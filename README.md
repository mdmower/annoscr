# Annoscr

A lightweight screenshot annotation tool for GNOME, written in TypeScript on GJS + GTK4 + Libadwaita.

Annoscr is a reimplementation of a subset of [Gradia](https://github.com/AlexanderVanhee/Gradia), focused primarily on annotation. The canvas/action design is inspired by Gradia's.

## Features (planned)

**Annotation tools:** Select, Pen, Text, Line, Arrow, Rectangle, Oval, Highlighter, Number stamp
**Transforms:** Rotation, Crop
**I/O:** Open file, paste from clipboard, drag-and-drop, export PNG/WebP, copy to clipboard

## Status

Pre-alpha. Currently at milestone 1 (scaffolding + hello-world window).

## Building

### System dependencies (Debian 13)

```sh
sudo apt install gjs meson ninja-build nodejs npm \
    gir1.2-gtk-4.0 gir1.2-adw-1 gir1.2-gdkpixbuf-2.0 gir1.2-pango-1.0
```

`nodejs` and `npm` can alternatively be installed from <https://nodejs.org/en/download/>.

### From source

```sh
npm install                    # installs TypeScript as a project devDependency
meson setup build
meson compile -C build
./build/src/annoscr            # run from the build tree
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
