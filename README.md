# iploc-extension

GNOME Shell extension that shows the country of your current public IP in the top panel.

- Panel: flag + country code, e.g. `🇫🇮 FI`
- Click: full country name, IP address (click it to copy), city and provider, time of the last check
- Refreshes every 5 seconds by default (configurable 3–600 s), plus immediately on network changes and when the menu opens

<img width="403" height="288" alt="123" src="https://github.com/user-attachments/assets/1d27f82e-285d-4242-8978-09a52bd00ae4" />

Tested on Ubuntu 24.04 / GNOME Shell 46.

## How it works and what it costs

Each check is one HTTPS request to `https://1.1.1.1/cdn-cgi/trace` (fallback: `www.cloudflare.com/cdn-cgi/trace`).
The response is ~200 bytes of plain text with `ip=` and `loc=` (ISO country code). The HTTP session is kept
alive between checks, so there is no new TLS handshake each time. Requests never overlap: the next one is
scheduled only after the previous one finishes.

A kept-alive connection silently stops answering when a VPN switches servers. So every request has a hard
3-second deadline. If a check fails, all connections are dropped and both endpoints are queried in parallel
on fresh connections. "Refresh now" and network changes skip straight to that step and interrupt any running
check.

While a check is in progress, the panel shows a spinning icon. It appears right away for manual refreshes,
network changes and retries. For routine background checks it appears only after 2 seconds, so the panel
does not blink every few seconds.

The country name comes from the system locale via `Intl.DisplayNames`, so no lookup table is needed.

City and provider come from `ipwho.is`, requested only when the IP changes. This can be turned off in settings.

If a check fails, the panel keeps the last known country and dims it.

## Install

```sh
make install          # pack + install into ~/.local/share/gnome-shell/extensions
# X11: Alt+F2, type r, Enter.  Wayland: log out and back in.
make enable
```

Other targets: `make prefs` (settings), `make log` (follow shell log), `make uninstall`.

After changing the code: `make install`, then restart the shell again.
