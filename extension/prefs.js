import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class IpLocPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        const general = new Adw.PreferencesGroup({
            title: 'Обновление',
            description: 'Каждая проверка — один HTTPS-запрос примерно на 250 байт к Cloudflare. ' +
                'При смене сети проверка запускается сразу, не дожидаясь интервала.',
        });

        const interval = new Adw.SpinRow({
            title: 'Интервал, секунд',
            adjustment: new Gtk.Adjustment({lower: 3, upper: 600, step_increment: 1, page_increment: 10}),
        });
        settings.bind('refresh-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        general.add(interval);
        page.add(general);

        const display = new Adw.PreferencesGroup({title: 'Отображение'});

        const showCode = new Adw.SwitchRow({
            title: 'Код страны рядом с флагом',
            subtitle: 'Например, «🇫🇮 FI» вместо «🇫🇮»',
        });
        settings.bind('show-code', showCode, 'active', Gio.SettingsBindFlags.DEFAULT);
        display.add(showCode);

        const showDetails = new Adw.SwitchRow({
            title: 'Город и провайдер',
            subtitle: 'Запрашиваются у ipwho.is только при смене IP',
        });
        settings.bind('show-details', showDetails, 'active', Gio.SettingsBindFlags.DEFAULT);
        display.add(showDetails);

        page.add(display);
        window.add(page);
    }
}
