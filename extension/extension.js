import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Tiny plain-text responses (~250 bytes) with `ip=` and `loc=` (ISO country code).
// 1.1.1.1 goes first: it needs no DNS lookup and always answers over IPv4.
const TRACE_URLS = [
    'https://1.1.1.1/cdn-cgi/trace',
    'https://www.cloudflare.com/cdn-cgi/trace',
];
// Only queried when the IP changes, for city and provider.
const DETAILS_URL = 'https://ipwho.is/%s?fields=success,city,region,connection';

const REQUEST_TIMEOUT_MS = 3000;
const NETWORK_CHANGE_DELAY_S = 1;
const SPINNER_DELAY_MS = 2000;

const regionNames = (() => {
    try {
        return new Intl.DisplayNames(undefined, {type: 'region'});
    } catch {
        return null;
    }
})();

function flagFor(code) {
    if (!/^[A-Z]{2}$/.test(code) || code === 'XX')
        return '🌐';
    return String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

function countryName(code) {
    if (code === 'T1')
        return 'Tor';
    if (!/^[A-Z]{2}$/.test(code) || code === 'XX')
        return 'Неизвестно';
    try {
        return regionNames?.of(code) ?? code;
    } catch {
        return code;
    }
}

function parseTrace(text) {
    const fields = {};
    for (const line of text.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0)
            fields[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    if (!fields.ip || !fields.loc)
        throw new Error('Unexpected trace response');
    return {ip: fields.ip, code: fields.loc.toUpperCase()};
}

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

const InfoRow = GObject.registerClass(
class InfoRow extends PopupMenu.PopupBaseMenuItem {
    _init(title, {reactive = false} = {}) {
        super._init({reactive, can_focus: reactive});
        this.add_child(new St.Label({
            text: title,
            style_class: 'iploc-row-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this.value = new St.Label({
            text: '—',
            style_class: 'iploc-row-value',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.value);
    }
});

const IpLocIndicator = GObject.registerClass(
class IpLocIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'IP Location');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._state = null;      // {ip, code, time}
        this._details = null;    // {ip, city, region, isp}
        this._stale = false;
        this._loading = false;
        this._busy = false;
        this._gen = 0;           // bumps on every refresh; results of older refreshes are dropped
        this._timerId = 0;
        this._netTimerId = 0;
        this._spinnerTimerId = 0;
        this._destroyed = false;

        this._requests = new Map(); // Gio.Cancellable -> deadline source id
        this._session = this._newSession();

        const box = new St.BoxLayout();
        this._spinner = new St.Icon({
            icon_name: 'process-working-symbolic',
            style_class: 'system-status-icon',
            visible: false,
        });
        this._spinner.set_pivot_point(0.5, 0.5);
        this._label = new St.Label({
            text: '🌐 …',
            style_class: 'iploc-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._spinner);
        box.add_child(this._label);
        this.add_child(box);

        this._buildMenu();

        this._settingsIds = [
            this._settings.connect('changed::refresh-interval', () => {
                if (!this._busy)
                    this._scheduleNext(this._interval);
            }),
            this._settings.connect('changed::show-code', () => this._render()),
            this._settings.connect('changed::show-details', () => {
                this._details = null;
                this._maybeFetchDetails();
                this._render();
            }),
        ];

        // Debounced: the monitor often fires several times in a row while a VPN comes up.
        this._netMonitor = Gio.NetworkMonitor.get_default();
        this._netId = this._netMonitor.connect('network-changed', () => {
            if (this._netTimerId)
                GLib.source_remove(this._netTimerId);
            this._netTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, NETWORK_CHANGE_DELAY_S, () => {
                this._netTimerId = 0;
                this._refresh({hard: true});
                return GLib.SOURCE_REMOVE;
            });
        });

        this._refresh({hard: true});
    }

    get _interval() {
        return this._settings.get_uint('refresh-interval');
    }

    _buildMenu() {
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._headerFlag = new St.Label({text: '🌐', style_class: 'iploc-header-flag', y_align: Clutter.ActorAlign.CENTER});
        this._headerName = new St.Label({text: 'Определяю…', style_class: 'iploc-header-name', y_align: Clutter.ActorAlign.CENTER});
        header.add_child(this._headerFlag);
        header.add_child(this._headerName);
        this.menu.addMenuItem(header);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._ipRow = new InfoRow('IP', {reactive: true});
        this._ipRow.connect('activate', () => this._copyIp());
        this.menu.addMenuItem(this._ipRow);

        this._cityRow = new InfoRow('Город');
        this.menu.addMenuItem(this._cityRow);

        this._ispRow = new InfoRow('Провайдер');
        this.menu.addMenuItem(this._ispRow);

        this._timeRow = new InfoRow('Обновлено');
        this.menu.addMenuItem(this._timeRow);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addAction('Обновить сейчас', () => this._refresh({hard: true}));
        this.menu.addAction('Настройки', () => this._extension.openPreferences());

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        });
    }

    _clearTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    _scheduleNext(delay) {
        if (this._destroyed)
            return;
        this._clearTimer();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timerId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- HTTP -------------------------------------------------------------

    _newSession() {
        // No Soup timeout: it is unreliable on a dead HTTP/2 connection. Each request has its own deadline instead.
        return new Soup.Session({user_agent: 'iploc-gnome-extension'});
    }

    _cancelRequests() {
        for (const [cancellable, deadlineId] of this._requests) {
            if (deadlineId)
                GLib.source_remove(deadlineId);
            cancellable.cancel();
        }
        this._requests.clear();
    }

    // Drops in-flight requests and pooled keep-alive connections. Needed after a VPN switch:
    // the old connection then silently stops answering instead of failing.
    _resetSession() {
        this._cancelRequests();
        this._session.abort();
        this._session = this._newSession();
    }

    _get(url, cancellable = new Gio.Cancellable()) {
        const session = this._session;
        const msg = Soup.Message.new('GET', url);
        let timedOut = false;

        const deadlineId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_MS, () => {
            timedOut = true;
            if (this._requests.has(cancellable))
                this._requests.set(cancellable, 0);
            cancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });
        this._requests.set(cancellable, deadlineId);

        return new Promise((resolve, reject) => {
            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (_session, res) => {
                if (this._requests.has(cancellable)) {
                    const id = this._requests.get(cancellable);
                    if (id)
                        GLib.source_remove(id);
                    this._requests.delete(cancellable);
                }
                try {
                    const bytes = session.send_and_read_finish(res);
                    const status = msg.get_status();
                    if (status !== Soup.Status.OK)
                        throw new Error(`HTTP ${status} from ${url}`);
                    resolve(new TextDecoder().decode(bytes.get_data()));
                } catch (e) {
                    reject(timedOut ? new Error(`Timeout: ${url}`) : e);
                }
            });
        });
    }

    // Queries all endpoints at once and takes the first answer.
    async _race(urls) {
        const cancellables = urls.map(() => new Gio.Cancellable());
        try {
            return await Promise.any(urls.map((url, i) => this._get(url, cancellables[i]).then(parseTrace)));
        } catch (e) {
            const errors = e.errors ?? [e];
            throw errors.find(isCancelled) ?? errors[0];
        } finally {
            cancellables.forEach(c => c.cancel());
        }
    }

    async _fetchTrace(gen, fresh) {
        if (!fresh) {
            try {
                return parseTrace(await this._get(TRACE_URLS[0]));
            } catch (e) {
                if (isCancelled(e) || gen !== this._gen)
                    throw e;
            }
            // The kept-alive connection is probably dead: show progress and retry on fresh connections.
            this._setLoading(true);
            this._resetSession();
        }
        return this._race(TRACE_URLS);
    }

    // hard: the user asked for it or the network changed. Interrupt whatever is running,
    // start on fresh connections and show the spinner right away.
    async _refresh({hard = false} = {}) {
        if (this._destroyed || (this._busy && !hard))
            return;
        if (hard)
            this._resetSession();

        const gen = ++this._gen;
        this._busy = true;
        this._clearTimer();
        this._armSpinner(hard ? 0 : SPINNER_DELAY_MS);

        let result = null;
        try {
            result = await this._fetchTrace(gen, hard);
        } catch {
            // Handled below as "no connection".
        }
        if (this._destroyed || gen !== this._gen)
            return;

        this._busy = false;
        if (result) {
            this._state = {...result, time: GLib.DateTime.new_now_local()};
            this._stale = false;
            this._maybeFetchDetails();
        } else {
            this._stale = true;
        }
        this._setLoading(false);
        this._scheduleNext(this._interval);
    }

    async _maybeFetchDetails() {
        const ip = this._state?.ip;
        if (!ip || !this._settings.get_boolean('show-details') || this._details?.ip === ip)
            return;

        this._details = {ip, city: null, region: null, isp: null};
        try {
            const data = JSON.parse(await this._get(DETAILS_URL.replace('%s', encodeURIComponent(ip))));
            if (this._destroyed || !data.success || this._details?.ip !== ip)
                return;
            this._details = {
                ip,
                city: data.city || null,
                region: data.region || null,
                isp: data.connection?.isp || data.connection?.org || null,
            };
            this._render();
        } catch {
            // Also covers cancellation by a session reset. Allow a retry on the next refresh.
            if (!this._destroyed && this._details?.ip === ip)
                this._details = null;
        }
    }

    // --- UI ---------------------------------------------------------------

    _clearSpinnerTimer() {
        if (this._spinnerTimerId) {
            GLib.source_remove(this._spinnerTimerId);
            this._spinnerTimerId = 0;
        }
    }

    // Background checks normally finish in well under a second; delaying the spinner
    // keeps the panel from blinking every few seconds.
    _armSpinner(delayMs) {
        this._clearSpinnerTimer();
        if (delayMs <= 0) {
            this._setLoading(true);
            return;
        }
        this._spinnerTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._spinnerTimerId = 0;
            this._setLoading(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _setLoading(loading) {
        if (!loading)
            this._clearSpinnerTimer();
        if (this._loading !== loading) {
            this._loading = loading;
            this._spinner.remove_all_transitions();
            this._spinner.rotation_angle_z = 0;
            this._spinner.visible = loading;
            this._label.visible = !loading;
            // With animations turned off the icon stays still instead of spinning.
            if (loading && St.Settings.get().enable_animations) {
                this._spinner.ease({
                    rotation_angle_z: 360,
                    duration: 1000,
                    mode: Clutter.AnimationMode.LINEAR,
                    repeatCount: -1,
                });
            }
        }
        this._render();
    }

    _render() {
        const state = this._state;
        const showCode = this._settings.get_boolean('show-code');

        if (!state) {
            this._label.text = this._stale ? '🌐 ?' : '🌐 …';
            this._headerFlag.text = '🌐';
            this._headerName.text = this._stale && !this._loading ? 'Нет соединения' : 'Определяю…';
            this._ipRow.value.text = '—';
            this._timeRow.value.text = this._loading ? 'проверяю…' : '—';
            this._cityRow.visible = false;
            this._ispRow.visible = false;
            return;
        }

        const flag = flagFor(state.code);
        this._label.text = showCode ? `${flag} ${state.code}` : flag;
        this._label.opacity = this._stale ? 128 : 255;

        this._headerFlag.text = flag;
        this._headerName.text = countryName(state.code);
        this._ipRow.value.text = state.ip;

        const time = state.time.format('%H:%M:%S');
        if (this._loading)
            this._timeRow.value.text = `${time}, проверяю…`;
        else
            this._timeRow.value.text = this._stale ? `${time} (нет связи)` : time;

        const details = this._settings.get_boolean('show-details') && this._details?.ip === state.ip
            ? this._details : null;
        const place = [details?.city, details?.region].filter(Boolean)
            .filter((v, i, arr) => arr.indexOf(v) === i).join(', ');
        this._cityRow.visible = Boolean(place);
        this._cityRow.value.text = place;
        this._ispRow.visible = Boolean(details?.isp);
        this._ispRow.value.text = details?.isp ?? '';
    }

    _copyIp() {
        const ip = this._state?.ip;
        if (!ip)
            return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, ip);
        Main.notify('IP скопирован', ip);
    }

    destroy() {
        this._destroyed = true;
        this._clearTimer();
        this._clearSpinnerTimer();
        if (this._netTimerId) {
            GLib.source_remove(this._netTimerId);
            this._netTimerId = 0;
        }
        this._spinner.remove_all_transitions();
        this._cancelRequests();
        this._session.abort();
        this._netMonitor.disconnect(this._netId);
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._settings = null;
        super.destroy();
    }
});

export default class IpLocExtension extends Extension {
    enable() {
        this._indicator = new IpLocIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
