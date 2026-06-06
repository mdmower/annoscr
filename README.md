# Annoscr

Annoscr is a lightweight screenshot annotation tool for GNOME.

<img width="541" height="381" src="data/screenshot.png" alt="Screenshot of Annoscr">

## Features

- **Annotation tools** — Select, Pen, Text, Line, Arrow, Rectangle, Oval, Highlighter, and a Number stamp, on an icon toolbar with tooltips.

- **Styling**
  - Color and fill: type a hex value, drag the opacity slider, or open the full palette.
  - Stroke width, line style (solid / dashed / dotted), arrowheads (open or filled), and rounded rectangle corners.
  - Text color, font, size, and alignment; a text fill (rounded corner backing plate, transparent by default) keeps lettering legible over busy images.
  - Remembered styles: each tool's defaults update when you create or restyle an annotation, so the next one matches.

- **Selecting and editing**
  - Click to select an annotation, or Shift+Click for several; then move, delete, duplicate, restack, or restyle them together.
  - Resize a line, arrow, rectangle, oval, or stamp by its handles; rotate a text, stamp, rectangle, or oval with its gizmo
    - Rectangles and ovals can be constrained to squares and circles, respectively.
    - Rotations can be constrained to 15° increments.
  - Re-edit a text annotation by double-clicking it.
  - Dig through stacked annotations.
  - Undo / redo throughout.
  - Discard confirmation of unsaved changes on exit.

- **Text labels** — give a rectangle or oval a centered caption; the text wraps to the box, aligns left / center / right, and rotates with the shape.

- **Number stamps** — numbered or lettered per group. Pick or reassign a stamp's group from the style bar, start a new group, and select a stamp to quickly identify all others in the group (if multiple groups exist).

- **Transforms** — rotate the whole image, or resize to crop or expand the canvas.

- **Image I/O** — open a file, paste, drag-and-drop, start a blank canvas, or capture a screenshot through the desktop portal; export to PNG / JPEG or copy back to the clipboard.

- **View** — Fit-to-window, 1:1, or a continuous 25–400% zoom slider.

- **Keyboard & accessibility** — the canvas is fully keyboard-drivable (walk, select, nudge, resize, rotate, and place annotations without the mouse), and every control carries an accessible label for screen readers. The complete shortcut list lives in the in-app reference (primary menu → Keyboard Shortcuts).

- **Preferences** (saved to `~/.config/annoscr/settings.json`) — color scheme, remember tool styles between sessions, default save folder and format, confirm before discarding, and select-after-placement; the font list offered in the text menu is editable too. The primary menu also holds a keyboard-shortcuts reference and About.

## Status

In active development.

### Planned

- Ability to save annotation files
  - Currently only saves to PNG and JPEG, effectively flattening all annotations into the background when saved.
- Improved style toolbar
  - The horizontally scrollable style toolbar when many options are available is a temporary solution.

## Requirements

Annoscr targets **GNOME 46** and newer. The floors are set by the newest APIs it calls:

- **GTK ≥ 4.14** — accessibility (`Gtk.Accessible.announce`, `Gtk.AccessibleList`)
- **libadwaita ≥ 1.5** — `Adw.AlertDialog`, `Adw.Dialog`, `Adw.PreferencesDialog`
- **GJS ≥ 1.72** — ESM `gi://` imports

It also loads GdkPixbuf 2, Pango / PangoCairo, and libportal (for screenshot capture), all of which have far older floors satisfied by any system meeting the above. By distribution:

| Distribution | Minimum           |
| ------------ | ----------------- |
| Debian       | 13 (trixie)       |
| Ubuntu       | 24.04 LTS         |
| Fedora       | 40                |
| Arch         | current (rolling) |

The Debian and Fedora packages declare these versions as dependencies, so a too-old system is refused at install time rather than failing at runtime.

**Screenshot capture** additionally goes through the XDG desktop portal, so it needs the `xdg-desktop-portal` service and a Screenshot-capable backend (e.g. `xdg-desktop-portal-gnome`) running, present by default on GNOME. This is an optional package dependency since everything else (open, paste, drag-and-drop, blank canvas) works without it. Display server makes no difference: the portal is the standard capture path on both Wayland and X11.

## Verifying downloads

Release artifacts are GPG-signed. The signing key is `CMPhys Releases <mdmower@cmphys.com>`, fingerprint:

```
7B5B 62F9 C73C 2BC9 E451 A82F 39B4 E900 0982 2511
```

Fetch the public key via any of:

```sh
# Web Key Directory
gpg --locate-keys mdmower@cmphys.com

# openpgp.org
gpg --keyserver keys.openpgp.org --recv-keys 7B5B62F9C73C2BC9E451A82F39B4E90009822511

# Signing key included with releases
gpg --import annoscr-signing-key.asc
```

Verify the checksums file and everything it lists:

```sh
gpg --verify SHA256SUMS.asc SHA256SUMS
# expect: Good signature from "CMPhys Releases ..."

sha256sum -c SHA256SUMS
# expect: each artifact OK
```

Each artifact also carries its own detached signature — `.asc` for the `.deb` and `.rpm`, `.sig` for the Arch package — if you'd rather check one directly:

```sh
gpg --verify annoscr_0.9.0_all.deb.asc annoscr_0.9.0_all.deb

gpg --verify annoscr-0.9.0-1-any.pkg.tar.zst.sig annoscr-0.9.0-1-any.pkg.tar.zst
```

On Arch, `pacman -U` verifies the package against its own keyring. Installing a package signed by a key it doesn't recognize fails with `required key missing from keyring`. Import the key from `annoscr-signing-key.asc` and trust it locally, once:

```sh
# import into pacman's keyring
sudo pacman-key --add annoscr-signing-key.asc

# trust it locally
sudo pacman-key --lsign-key 7B5B62F9C73C2BC9E451A82F39B4E90009822511

# install
sudo pacman -U ./annoscr-0.9.0-1-any.pkg.tar.zst
```

## CLI

```text
$ annoscr --help

Usage:
  annoscr [OPTION…]

Help Options:
  -h, --help                 Show help options
  --help-all                 Show all help options
  --help-gapplication        Show GApplication options

Application Options:
  -v, --version              Print the version and exit
  --new                      Create a blank canvas
  --width=PIXELS             Canvas width in pixels (default: 640, requires --new)
  --height=PIXELS            Canvas height in pixels (default: 480, requires --new)
  --screenshot               Capture a screenshot via the desktop portal on app startup
```

### Examples

- Start the application with a blank 1920x1080px canvas
  ```sh
  annoscr --new --width 1920 --height 1080
  ```
- Take a screenshot and annotate it
  ```sh
  annoscr --screenshot
  ```
- Annotate an existing screenshot
  ```sh
  annoscr path/to/image.png
  ```

## Building

### System dependencies (Debian 13)

```sh
sudo apt install gjs meson ninja-build nodejs npm \
    gir1.2-gtk-4.0 gir1.2-adw-1 gir1.2-gdkpixbuf-2.0 \
    gir1.2-pango-1.0 gir1.2-xdp-1.0
```

`nodejs` and `npm` can alternatively be installed from <https://nodejs.org/en/download/>.

### From source

```sh
npm install
meson setup build
meson compile -C build
./build/src/annoscr # run from the build tree
```

### Building the .deb

```sh
sudo apt install debhelper devscripts
dpkg-buildpackage -us -uc -b
# .deb lands in the parent directory
```

Check the built package against Debian policy (script invokes `lintian` to lint the most recent `../annoscr_*.deb`):

```sh
sudo apt install lintian
npm run lint:deb
# or build and lint in one step:  debuild -us -uc -b
```

The package installs a man page, so `man annoscr` documents the command-line options once installed.

### Other distributions (RPM, Arch)

RPM and Arch packaging live under [packaging/](packaging/). Both reuse the Meson build and run `npm install` during the build to fetch the TypeScript compiler, so the build host needs network access.

```sh
# RPM (Fedora / openSUSE) - dnf builddep installs the spec's BuildRequires
sudo dnf builddep packaging/rpm/annoscr.spec
git archive --prefix=annoscr-0.9.0/ \
  -o ~/rpmbuild/SOURCES/annoscr-0.9.0.tar.gz HEAD
rpmbuild -ba packaging/rpm/annoscr.spec
rpmlint -r packaging/rpm/annoscr.rpmlintrc \
  ~/rpmbuild/RPMS/noarch/annoscr-*.rpm

# Arch - makepkg fetches the source from the release tag, then builds and installs.
cd packaging/arch && makepkg -si
```

The `git archive` line stages a source tarball for `rpmbuild`; for an actual release, fetch the published tarball instead (e.g. `spectool -g`). The RPM declares its runtime libraries explicitly because a noarch GJS payload has no ELF links for RPM to scan — `annoscr.rpmlintrc` filters the resulting (expected) `explicit-lib-dependency` advisory.

### Cutting a release

```sh
# Sync version across package.json (+ lockfile), the spec, and the PKGBUILD.
# Also adds a dated entry to debian/changelog, the metainfo, and the spec %changelog.
npm run set-version -- x.y.z

# Build .deb + .rpm + Arch packages into dist/
npm run dist

# Generate detached GPG signatures and signed SHA256SUMS in dist/
npm run sign
```

`npm run dist` ([build-aux/dist.sh](build-aux/dist.sh)) builds the `.deb` on this host and the `.rpm` and Arch package in Fedora/Arch Docker containers (so it needs Docker and network for those two). All packages are saved to gitignored `dist/`, ready to attach to a GitHub release. This command aborts if any version fields disagree.

`npm run sign` ([build-aux/sign.sh](build-aux/sign.sh)) adds a detached GPG signature next to each artifact (the Arch package gets a `.sig`, as pacman expects; the rest get an armored `.asc`), writes a `SHA256SUMS` plus its `SHA256SUMS.asc`, and exports the public key as `annoscr-signing-key.asc`. The key is taken from `$ANNOSCR_SIGNING_KEY`, falling back to `git config user.signingkey`. Downloaders verify a release with:

```sh
gpg --import annoscr-signing-key.asc
gpg --verify SHA256SUMS.asc SHA256SUMS && sha256sum -c SHA256SUMS
```

### Cleaning

```sh
# incremental: remove build outputs, keep config
meson compile -C build --clean

# full reset of the dev build tree
rm -rf build

# remove every build tree and packaging artifact
npm run clean
```

`npm run clean` ([build-aux/clean.sh](build-aux/clean.sh)) wipes both Meson build trees (`build/` and the `obj-*/` dir `dpkg-buildpackage` creates), the debhelper staging under `debian/`, and the `.deb`/`.changes`/`.buildinfo` products dpkg writes to the parent directory, returning the checkout to a pristine state.

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
