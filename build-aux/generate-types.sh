#!/bin/sh

# Generate the GJS type definitions (@girs/*) into types/girs/ from the GIR
# files of the oldest supported distribution, so tsc rejects any API newer than
# the libraries it ships.
# Run via `npm run generate-types`, or directly with `sh build-aux/generate-types.sh`.

set -eu

root=$(CDPATH="" cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

# Of the supported distributions (Debian 13, Ubuntu 26.04, Fedora 43), Debian 13
# has the oldest version of every library Annoscr uses.
image=debian:trixie
ts_for_gir=5.2.0
# The namespaces src/globals.d.ts imports, as GIR names (case-sensitive).
# ts-for-gir adds their dependencies.
modules="GLib-2.0 GObject-2.0 Gio-2.0 Gdk-4.0 Graphene-1.0 Gtk-4.0 Adw-1 GdkPixbuf-2.0 Pango-1.0 cairo-1.0 PangoCairo-1.0 Xdp-1.0"
out="$root/types/girs"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required to install the GIR files." >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Created on the host so the host user can delete the files the container's
# root user copies into it.
mkdir "$work/gir"

# 1. GIR files. Debian installs the architecture-dependent ones (GLib-2.0.gir)
#    under /usr/lib/<triplet>/gir-1.0.
echo "==> GIR files ($image container)"
docker pull -q "$image" >/dev/null
docker run --rm -v "$work/gir":/gir "$image" sh -euc '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends libgtk-4-dev libadwaita-1-dev libportal-dev
  cp /usr/share/gir-1.0/*.gir /usr/lib/*/gir-1.0/*.gir /gir/
' >"$work/gir.log" 2>&1 || { echo "   GIR install failed:" >&2; tail -30 "$work/gir.log" >&2; exit 1; }

# 2. Type definitions, one npm package per namespace.
echo "==> ts-for-gir $ts_for_gir"
rm -rf "$out"
# shellcheck disable=SC2086 # $modules is a word list
npx --yes "@ts-for-gir/cli@$ts_for_gir" generate $modules \
  --girDirectories "$work/gir" --outdir "$out" --package --ignoreVersionConflicts \
  >"$work/generate.log" 2>&1 || { echo "   generation failed:" >&2; tail -30 "$work/generate.log" >&2; exit 1; }

# 3. ts-for-gir skips a module it can't find and still exits 0, so check that
#    every package src/globals.d.ts imports was generated.
missing=0
for pkg in $(sed -n "s|^import '@girs/\([^']*\)';|\1|p" src/globals.d.ts); do
  if [ ! -f "$out/$pkg/package.json" ]; then
    echo "   ! @girs/$pkg was not generated" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "Add the missing namespaces to modules in $0." >&2
  exit 1
fi

echo
echo "==> types/girs/"
for f in "$out"/*/package.json; do
  node -p "const p = require('$f'); p.name + (p.libraryVersion ? ' ' + p.libraryVersion : '')"
done
