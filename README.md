# Annoscr

A lightweight screenshot annotation tool for GNOME, written in TypeScript on GJS + GTK4 + Libadwaita.

Annoscr is a reimplementation of a subset of [Gradia](https://github.com/AlexanderVanhee/Gradia), focused primarily on annotation. The canvas/action design is inspired by Gradia's.

## Features

**Annotation tools:** Select, Pen, Text, Line, Arrow, Rectangle, Oval, Highlighter, Number stamp (icon toolbar with tooltips)
**Transforms:** Rotation, Resize (crop / canvas expansion)
**I/O:** Open file, capture a screenshot via the desktop portal, blank canvas creation, paste from clipboard, drag-and-drop, export PNG/JPEG, copy to clipboard
**Editing:** Per-tool color, fill, stroke width, line style (solid/dashed/dotted), font family, font size; select one or several annotations (Shift+Click) to move, delete, duplicate (Ctrl+D), or restyle them together; undo/redo; discard confirmation
**Number stamps:** per-group numbering with a Number/Letter variant per group; pick or reassign groups from the style bar, start a new group with Ctrl+G, and selecting a stamp badges the rest of its group on-canvas
**View:** Fit-to-window and 1:1, plus a 25%-400% zoom slider with scrollbars; Ctrl+scroll to zoom at the cursor; Ctrl+0 / Ctrl+1 shortcuts
**App:** Primary menu with Preferences, a Keyboard shortcuts reference, and About
**Preferences** (saved to `~/.config/annoscr/settings.json`): color scheme (system/light/dark), remember tool styles between sessions, default save folder + format, confirm-before-discard toggle

## Status

In active development.

## Building

### System dependencies (Debian 13)

```sh
sudo apt install gjs meson ninja-build nodejs npm \
    gir1.2-gtk-4.0 gir1.2-adw-1 gir1.2-gdkpixbuf-2.0 gir1.2-pango-1.0 \
    gir1.2-xdp-1.0
```

`nodejs` and `npm` can alternatively be installed from <https://nodejs.org/en/download/>.

### From source

```sh
npm install                    # installs TypeScript as a project devDependency
meson setup build
meson compile -C build
./build/src/annoscr            # run from the build tree
./build/src/annoscr shot.png   # open an image file (also used by "Open With")
./build/src/annoscr --new      # start with a blank 640×480 canvas
./build/src/annoscr --new --width 1920 --height 1080
./build/src/annoscr --screenshot   # capture via the desktop portal on launch
```

### Building the .deb

```sh
sudo apt install debhelper devscripts
dpkg-buildpackage -us -uc -b
# .deb lands in the parent directory
```

## License

GPL-3.0-or-later. See [COPYING](COPYING).

## Credits

Design inspired by [Gradia](https://github.com/AlexanderVanhee/Gradia) by Alexander Vanhee.
