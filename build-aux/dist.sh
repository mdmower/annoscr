#!/bin/sh

# Build release artifacts into dist/
# - Debian/Ubuntu .deb
# - Fedora/openSUSE .rpm
# - Arch package
# Run via `npm run dist`, or directly with `sh build-aux/dist.sh`.

set -eu

root=$(CDPATH="" cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

ver=$(node -p "require('./package.json').version")
echo "==> Annoscr $ver"

# 1. Every packaging file must agree on the version, or we would ship a
#    mismatched set. Verify before building anything.
mismatch=0
expect() { # label value
  if [ "$2" != "$ver" ]; then
    printf '   ! %-16s is %s, expected %s\n' "$1" "${2:-<none>}" "$ver" >&2
    mismatch=1
  fi
}
expect "debian/changelog" "$(sed -n 's/^annoscr (\([^)]*\)).*/\1/p' debian/changelog | head -1)"
expect "metainfo" "$(grep -oE '<release version="[^"]+"' data/com.cmphys.Annoscr.metainfo.xml.in | head -1 | sed 's/.*version="//;s/"//')"
expect "rpm spec" "$(sed -n 's/^Version:[[:space:]]*//p' packaging/rpm/annoscr.spec | head -1)"
expect "arch PKGBUILD" "$(sed -n 's/^pkgver=//p' packaging/arch/PKGBUILD | head -1)"
if [ "$mismatch" -ne 0 ]; then
  echo "Version mismatch. Run 'npm run set-version -- $ver', add the release notes, then retry." >&2
  exit 1
fi

dist="$root/dist"
mkdir -p "$dist"
# Clear prior output so a stale file (an old version, or a format no longer
# built) never lingers next to a fresh build.
rm -f "$dist"/annoscr* "$dist"/SHA256SUMS*
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# 2. Source tarball from a snapshot of the working tree (tracked files; honors
#    .gitignore).
echo "==> source tarball"
idx="$work/index"
GIT_INDEX_FILE="$idx" git read-tree HEAD
GIT_INDEX_FILE="$idx" git add -A
tree=$(GIT_INDEX_FILE="$idx" git write-tree)
git archive --format=tar.gz --prefix="annoscr-$ver/" -o "$work/annoscr-$ver.tar.gz" "$tree"

# 3. Debian .deb; built on this host from a clean extraction so the working
#    tree is not dirtied.
echo "==> .deb (host)"
(
  tar -C "$work" -xzf "$work/annoscr-$ver.tar.gz"
  cd "$work/annoscr-$ver"
  npm install --no-audit --no-fund >/dev/null 2>&1
  dpkg-buildpackage -us -uc -b >/dev/null 2>&1
) >"$work/deb.log" 2>&1 || { echo "   .deb build failed:" >&2; tail -30 "$work/deb.log" >&2; exit 1; }
cp "$work"/annoscr_"$ver"_*.deb "$dist"/

# 4 & 5. .rpm and Arch package in containers.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  cp packaging/rpm/annoscr.spec packaging/rpm/annoscr.rpmlintrc packaging/arch/PKGBUILD "$work"/

  echo "==> .rpm (fedora container)"
  docker pull -q fedora:41 >/dev/null
  docker run --rm -v "$work":/work fedora:41 bash -euc '
    dnf -y install rpm-build "dnf-command(builddep)" >/dev/null 2>&1
    dnf -y builddep /work/annoscr.spec >/dev/null 2>&1
    mkdir -p /root/rpmbuild/SOURCES /root/rpmbuild/SPECS
    cp /work/annoscr-*.tar.gz /root/rpmbuild/SOURCES/
    cp /work/annoscr.spec /root/rpmbuild/SPECS/
    rpmbuild -bb /root/rpmbuild/SPECS/annoscr.spec >/dev/null
    cp /root/rpmbuild/RPMS/noarch/*.rpm /work/
  ' >"$work/rpm.log" 2>&1 || { echo "   .rpm build failed:" >&2; tail -30 "$work/rpm.log" >&2; exit 1; }
  cp "$work"/annoscr-"$ver"-*.rpm "$dist"/

  echo "==> Arch package (arch container)"
  docker pull -q archlinux:latest >/dev/null
  docker run --rm -v "$work":/work archlinux:latest bash -euc '
    pacman -Syu --noconfirm --needed base-devel meson ninja nodejs npm gettext \
      gjs gtk4 libadwaita gdk-pixbuf2 pango libportal \
      desktop-file-utils appstream >/dev/null 2>&1
    useradd -m builder
    cp /work/PKGBUILD /work/annoscr-*.tar.gz /home/builder/
    chown -R builder:builder /home/builder
    cd /home/builder
    sudo -u builder makepkg >/dev/null 2>&1
    cp /home/builder/*.pkg.tar.zst /work/
  ' >"$work/arch.log" 2>&1 || { echo "   Arch build failed:" >&2; tail -30 "$work/arch.log" >&2; exit 1; }
  cp "$work"/annoscr-"$ver"-*.pkg.tar.zst "$dist"/
else
  echo "!! Docker unavailable - skipped .rpm and Arch package (built .deb only)." >&2
fi

echo
echo "==> dist/"
ls -1 "$dist"
