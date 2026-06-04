# Annoscr

Annoscr is a lightweight screenshot annotation tool for GNOME.

<img width="541" height="381" src="data/screenshot.png" alt="Screenshot of Annoscr">

## Features

- **Annotation tools** — Select, Pen, Text, Line, Arrow, Rectangle, Oval, Highlighter, and a Number stamp, on an icon toolbar with tooltips.

- **Styling**
  - Color and fill: type a hex value, drag the opacity slider, or open the full palette.
  - Stroke width, line style (solid / dashed / dotted), arrowheads (open or filled), and rounded rectangle corners.
  - Text color, font, size, and alignment; a text fill is a rounded backing plate (transparent by default) that keeps lettering legible over busy images.
  - Restyling an existing annotation updates that tool's default, so the next one you draw matches.

- **Selecting and editing**
  - Click to select an annotation, or Shift+Click for several; then move, delete, duplicate (Ctrl+D), restack, or restyle them together.
  - Resize a line, arrow, rectangle, oval, or stamp by its handles; rotate a text, stamp, rectangle, or oval with its gizmo (hold Shift to square a shape or snap rotation to 15°).
  - Re-edit a text annotation by double-clicking it.
  - Dig through stacked annotations with `,` / `.` (or Alt+scroll).
  - Undo / redo throughout, with a confirmation before you discard your work.

- **Text labels** — give a rectangle or oval a centered caption (double-click it, press Enter while it's selected, or use the Add-text button); the text wraps to the box, aligns left / center / right, and rotates with the shape.

- **Number stamps** — numbered or lettered per group. Pick or reassign a stamp's group from the style bar, start a new group with Ctrl+G, and select a stamp to badge the rest of its group on the canvas.

- **Transforms** — rotate the whole image, or resize to crop or expand the canvas.

- **Image I/O** — open a file, paste, drag-and-drop, start a blank canvas, or capture a screenshot through the desktop portal; export to PNG / JPEG or copy back to the clipboard.

- **View** — Fit-to-window, 1:1, or a continuous 25–400% zoom slider; Ctrl+scroll to zoom at the cursor, plus Ctrl+0 / Ctrl+1 shortcuts.

- **Keyboard & accessibility** — controls carry accessible labels for screen readers, and the canvas is keyboard-drivable: walk annotations with `[` / `]` and select with Space (Shift+Space for several), nudge the selection with the arrow keys (Shift for larger steps), rotate a rotatable item with Alt+← / Alt+→ in 15° steps, and place a stamp or text at the viewport center with Space. Rotate the image with Ctrl+R / Ctrl+Shift+R and resize the canvas with Ctrl+E. The full list is in the keyboard-shortcuts reference.

- **Preferences** (saved to `~/.config/annoscr/settings.json`) — color scheme, remember tool styles between sessions, default save folder and format, confirm before discarding, and select-after-placement; the font list offered in the text menu is editable too. The primary menu also holds a keyboard-shortcuts reference and About.

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
./build/src/annoscr --version      # print the version (-v) and exit
```

### Building the .deb

```sh
sudo apt install debhelper devscripts
dpkg-buildpackage -us -uc -b
# .deb lands in the parent directory
```

## Translations

The UI is gettext-enabled under the text domain `annoscr`. The source strings are US English, and gettext returns them unchanged when the running locale has no catalogue — so English is the fallback with no extra configuration. Compiled `.mo` files install to `<prefix>/share/locale/<lang>/LC_MESSAGES/` and load automatically; the launcher binds the domain to that directory.

### Marking strings for translation

Wrap user-facing strings with the helpers in [src/i18n.ts](src/i18n.ts):

- `_(s)` — translate `s` now. Use it everywhere a string is built at runtime (widget construction, dialogs, labels, tooltips).
- `N_(s)` — mark `s` for extraction but return it unchanged. Use it for strings defined at module load (constant tables such as the tool list or size presets), which are evaluated before the domain is bound; translate them with `_()` where they're used.
- `formatN(s, n)` — translate `s` and substitute a single `%d`/`%s`, keeping the variable out of the translatable text.

After adding strings, list the source file in [po/POTFILES](po/POTFILES).

### Adding a translation

Generate a `.po` from the template and fill in the `msgstr`s — with a tool (Poedit, GNOME Translation Editor, Lokalize) or on the command line:

```sh
msginit --input=po/annoscr.pot --locale=de --output=po/de.po
```

Add the language code to [po/LINGUAS](po/LINGUAS); the build compiles each listed `.po` to a `.mo` automatically. When source strings change, regenerate the template and merge it into existing catalogues with `meson compile -C build annoscr-update-po`.

Editing or regenerating the template (`po/annoscr.pot`) needs GNU gettext **≥ 0.25**, the first release whose `xgettext` understands TypeScript sources. Distribution gettext is often older, so point meson at a newer build via a native file:

```sh
cp build-aux/xgettext.ini.example build-aux/xgettext.ini
# edit the xgettext path inside to your gettext ≥0.25 build, then:
meson setup build --native-file build-aux/xgettext.ini
meson compile -C build annoscr-pot # writes po/annoscr.pot
```

This affects template _extraction_ only. Compiling catalogues uses `msgfmt` (`.po` → `.mo`), which any gettext provides, so a newer `xgettext` is a translator/maintainer tool — never a build or runtime dependency.

## License

GPL-3.0-or-later. See [COPYING](COPYING).

## Credits

Inspired by [Gradia](https://github.com/AlexanderVanhee/Gradia) by Alexander Vanhee.

### Background

I liked Gradia but wanted something slightly different, and I also prefer native packages to portable ones. Rather than fork the application, I decided to use this as a learning opportunity for writing GNOME applications and working with AI (Claude, specifically). I chose TypeScript to write the application because that's where I'm most comfortable; I wanted to be able to scrutinize the generated code. The result is a screenshot annotation tool that I use regularly. While there is overlap in functionality between Gradia and Annoscr, this project is not just a reimplementation of Gradia in TypeScript; thought has gone into every feature (undeniably tailored to my interests).
