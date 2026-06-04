# Annoscr

Annoscr is a lightweight screenshot annotation tool for GNOME.

<img width="541" height="381" src="data/screenshot.png" alt="Screenshot of Annoscr">

## Features

- **Annotation tools:** Select, Pen, Text, Line, Arrow, Rectangle, Oval, Highlighter, Number stamp (icon toolbar with tooltips)
- **Transforms:** Rotation, Resize (crop / canvas expansion)
- **I/O:** Open file, capture a screenshot via the desktop portal, blank canvas creation, paste from clipboard, drag-and-drop, export PNG/JPEG, copy to clipboard
- **Editing:** Per-tool color and fill (enter a hex value, drag an opacity slider, or open the full palette/eyedropper) — for text, Fill is a rounded background plate (defaults to transparent white, so the opacity slider reveals a translucent backdrop) that keeps the text legible over busy images; stroke width, line style (solid/dashed/dotted), arrowhead style (open or filled), rounded rectangle corners, text color, font family, font size, and alignment (a select-mode style edit also updates the matching tool's default for new annotations; the style bar scrolls horizontally when a dense selection's controls overflow); **add centered text to a rectangle or oval** (double-click it, press Enter while it's the only selection, or the Add/Edit-text button) to make a labelled callout — the text wraps to the box, left/center/right aligns, and rotates with the shape; select one or several annotations (Shift+Click) to move, delete, duplicate (Ctrl+D), restack (z-order: Ctrl+[ / Ctrl+] to step, Ctrl+Shift+[ / Ctrl+Shift+] to send to back / bring to front, or the selection-actions menu), or restyle them together; dig through overlapping items with `,` / `.` (or Alt+scroll); resize a single selected line, arrow, rectangle, oval, or number stamp by dragging its handles (Shift squares a rect/oval corner or side; a resized stamp's size becomes the next stamp's default); rotate a single selected text, number stamp, rectangle, or oval to any angle with its rotate gizmo (Shift snaps to 15°); re-edit a text annotation by double-clicking it or pressing Enter while it's the only selection, and finish by clicking elsewhere on the canvas or pressing Enter (which leaves it selected); undo/redo; discard confirmation
- **Number stamps:** per-group numbering with a Number/Letter variant per group; pick or reassign groups from the style bar, start a new group with Ctrl+G, and selecting a stamp badges the rest of its group on-canvas
- **View:** Fit-to-window and 1:1, plus a continuous 25%-400% zoom slider with scrollbars (Shift-drag to fine-tune); Ctrl+scroll to zoom at the cursor; Ctrl+/Ctrl- step the 25/50/100/200/400% detents; Ctrl+0 / Ctrl+1 shortcuts
- **App:** Primary menu with Preferences, a Keyboard shortcuts reference, and About
- **Preferences** (saved to `~/.config/annoscr/settings.json`): color scheme (system/light/dark), remember tool styles between sessions, default save folder + format, confirm-before-discard toggle, select-after-placement toggle (switch to the select tool with the new annotation selected)

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
