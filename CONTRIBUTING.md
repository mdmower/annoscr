# Contributing

Annoscr is written in TypeScript, runs on GJS, and builds with Meson. This guide covers building from source and working with translations. For building `.deb` / `.rpm` / Arch packages and cutting releases, see [docs/PACKAGING.md](docs/PACKAGING.md).

Issues and patches are welcome at <https://github.com/mdmower/annoscr>.

## Building from source

### System dependencies

The package names below are for Debian 13 (trixie); install the equivalents on other distributions.

```sh
sudo apt install gjs meson ninja-build nodejs npm gettext \
    gir1.2-gtk-4.0 gir1.2-adw-1 gir1.2-gdkpixbuf-2.0 \
    gir1.2-pango-1.0 gir1.2-xdp-1.0
```

`nodejs` and `npm` can alternatively be installed from <https://nodejs.org/en/download/>; LTS versions 22 and 24 have been tested successfully.

If your changes affect UI strings, regenerating the translation template needs `gettext` version 0.25.0 or newer. See [Translations](#translations) if your distribution provides an older version.

### Build and run

```sh
npm install
meson setup build
meson compile -C build
./build/src/annoscr # run from the build tree
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

`npm run clean` ([build-aux/clean.sh](build-aux/clean.sh)) wipes both Meson build trees (`build/` and the `obj-*/` dir `dpkg-buildpackage` creates), the debhelper staging under `debian/`, and the `.deb`/`.changes`/`.buildinfo` products dpkg writes to the parent directory.

## Translations

The UI is gettext-enabled under the text domain `annoscr`. The source strings are US English, and gettext returns them unchanged when the running locale has no catalogue, i.e. English is the fallback with no extra configuration. Compiled `.mo` files install to `<prefix>/share/locale/<lang>/LC_MESSAGES/` and load automatically; the launcher binds the domain to that directory.

### Marking strings for translation

Wrap user-facing strings with the helpers in [src/i18n.ts](src/i18n.ts):

- `_(s)`: translate `s` now. Use it everywhere a string is built at runtime (widget construction, dialogs, labels, tooltips).
- `N_(s)`: mark `s` for extraction but return it unchanged. Use it for strings defined at module load (constant tables such as the tool list or size presets), which are evaluated before the domain is bound; translate them with `_()` where they're used.
- `formatN(s, n)`: translate `s` and substitute a single `%d`/`%s`, keeping the variable out of the translatable text.

After adding strings, list the source file in [po/POTFILES](po/POTFILES).

### Adding a translation

Generate a `.po` from the template and fill in the `msgstr`s, either with a tool (Poedit, GNOME Translation Editor, Lokalize) or on the command line:

```sh
msginit --input=po/annoscr.pot --locale=de --output=po/de.po
```

Add the language code to [po/LINGUAS](po/LINGUAS); the build compiles each listed `.po` to a `.mo` automatically. When source strings change, regenerate the template and merge it into existing catalogues with `meson compile -C build annoscr-update-po`.

Editing or regenerating the template (`po/annoscr.pot`) needs GNU gettext **≥ 0.25**, the first release whose `xgettext` understands TypeScript sources. This affects template _extraction_ only: compiling catalogues uses `msgfmt` (`.po` → `.mo`), which any gettext provides, so a newer `xgettext` is a translator/maintainer tool, not a build or runtime dependency.

#### Getting a recent xgettext

If your distribution's gettext is older, build 0.26 in a Docker container. Save this as `gettext.Dockerfile`:

```dockerfile
FROM debian:trixie

RUN echo "deb-src http://deb.debian.org/debian trixie main" \
      > /etc/apt/sources.list.d/src.list \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get build-dep -y gettext \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y wget xz-utils

WORKDIR /build
RUN wget https://ftp.gnu.org/pub/gnu/gettext/gettext-0.26.tar.gz \
 && tar -xzf gettext-0.26.tar.gz

WORKDIR /build/gettext-0.26
RUN ./configure --prefix=/opt/gettext-0.26 --disable-shared --enable-static \
 && make -j"$(nproc)" \
 && make install
```

Build the image, then copy the finished tree out to `~/.local/gettext-0.26` (where `xgettext.ini.example` suggests):

```sh
docker build -t annoscr-gettext -f gettext.Dockerfile .

CID=$(docker create annoscr-gettext)
mkdir -p ~/.local
docker cp "$CID:/opt/gettext-0.26" ~/.local/gettext-0.26
docker rm "$CID"
```

#### Pointing meson at it

Point meson at that build through a native file:

```sh
cp build-aux/xgettext.ini.example build-aux/xgettext.ini
# set the path inside to your build (if using the suggested path, remember to
# replace the YOURUSER placeholder).

meson setup build --native-file build-aux/xgettext.ini
meson compile -C build annoscr-pot # writes po/annoscr.pot
```
