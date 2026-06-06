#!/bin/sh

# Run via `npm run clean`, or directly with `sh build-aux/clean.sh`.
set -eu

# Resolve the project root (one level up from this script) so the command works
# regardless of the current working directory.
root=$(CDPATH="" cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

# Meson build trees: the development tree and the out-of-tree build dir
# dpkg-buildpackage creates (obj-<arch>, e.g. obj-x86_64-linux-gnu).
rm -rf build obj-*

# debhelper staging and per-build state under debian/.
rm -rf debian/annoscr debian/.debhelper
rm -f debian/files debian/debhelper-build-stamp debian/*.substvars debian/*.log

# Source-package build products dpkg writes to the parent directory.
rm -f ../annoscr_*.deb ../annoscr_*.buildinfo ../annoscr_*.changes \
  ../annoscr_*.dsc ../annoscr_*.tar.*

# Arch makepkg artifacts (makepkg runs in packaging/arch/). RPM builds happen in
# ~/rpmbuild, outside the tree, so nothing to clean there.
rm -rf packaging/arch/pkg packaging/arch/src
rm -f packaging/arch/*.pkg.tar.* packaging/arch/*.tar.gz

# Release artifacts collected by `npm run dist` and signed by `npm run sign`.
rm -rf dist

echo "Cleaned build trees and packaging artifacts."
