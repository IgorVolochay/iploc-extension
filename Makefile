UUID := iploc@volochay
SRC  := extension
ZIP  := build/$(UUID).shell-extension.zip

.PHONY: pack install enable uninstall log prefs clean

pack: $(ZIP)

$(ZIP): $(wildcard $(SRC)/*) $(wildcard $(SRC)/schemas/*)
	@mkdir -p build
	gnome-extensions pack $(SRC) --force --out-dir=build

install: pack
	gnome-extensions install --force $(ZIP)
	@echo "Installed. On X11: Alt+F2 → r → Enter. On Wayland: log out and back in. Then: make enable"

enable:
	gnome-extensions enable $(UUID)

uninstall:
	-gnome-extensions disable $(UUID)
	gnome-extensions uninstall $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

log:
	journalctl -f -o cat /usr/bin/gnome-shell | grep -i --line-buffered iploc

clean:
	rm -rf build
