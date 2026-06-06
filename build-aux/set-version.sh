#!/bin/sh

# Set the release version in package.json (the source of truth) and then copy
# to packaging specs.
#
# The dated release notes still need a new entry per release: debian/changelog,
# the metainfo <release>, and the spec %changelog. `npm run dist` verifies all
# of them match this version before building.
#
# Run via `npm run set-version -- x.y.z`, or directly with
# `sh build-aux/set-version.sh x.y.z`.

set -eu

ver=${1:-}
if [ -z "$ver" ]; then
  echo "usage: npm run set-version -- <version>   (e.g. 0.9.1)" >&2
  exit 2
fi
case $ver in
  *[!0-9.]* | *..* | .* | *. | '')
    echo "version must be dot-separated digits, e.g. 0.9.1" >&2
    exit 2
    ;;
esac

root=$(CDPATH="" cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

# package.json (+ package-lock.json). --no-git-tag-version skips git entirely.
npm version "$ver" --no-git-tag-version --allow-same-version >/dev/null

# RPM spec Version: and Arch PKGBUILD pkgver=
sed -i "s/^Version:.*/Version:        $ver/" packaging/rpm/annoscr.spec
sed -i "s/^pkgver=.*/pkgver=$ver/" packaging/arch/PKGBUILD

echo "Set version $ver in:"
echo "  package.json, packaging/rpm/annoscr.spec, packaging/arch/PKGBUILD"
echo
echo "Add a dated $ver entry (release notes) to, if you haven't already:"
echo "  - debian/changelog                              (e.g. dch -v $ver)"
echo "  - data/com.cmphys.Annoscr.metainfo.xml.in       (<release version=\"$ver\" date=\"YYYY-MM-DD\"> with <description its:translate=\"no\">)"
echo "  - packaging/rpm/annoscr.spec                     (%changelog)"
