#!/bin/sh

# Sign the release artifacts in dist/ with detached GPG signatures plus a signed
# SHA256SUMS. The .pkg.tar.zst gets a binary .sig (the form pacman verifies);
# the .deb/.rpm get an armored .asc. The public key is exported alongside as
# annoscr-signing-key.asc so downloaders can verify:
#
#   gpg --import annoscr-signing-key.asc
#   gpg --verify SHA256SUMS.asc SHA256SUMS && sha256sum -c SHA256SUMS
#
# The signing key comes from $ANNOSCR_SIGNING_KEY, else `git config
# user.signingkey`.
#
# Run via `npm run sign`, or directly with `sh build-aux/sign.sh`.

set -eu

root=$(CDPATH="" cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

key=${ANNOSCR_SIGNING_KEY:-$(git config user.signingkey 2>/dev/null || true)}
if [ -z "$key" ]; then
  echo "No signing key. Set ANNOSCR_SIGNING_KEY=<key-id> or run" >&2
  echo "  git config user.signingkey <key-id>" >&2
  exit 1
fi

dist="$root/dist"
# Collect the artifacts, skipping any signatures/sums from a previous run.
set --
for f in "$dist"/*.deb "$dist"/*.rpm "$dist"/*.pkg.tar.zst; do
  [ -e "$f" ] && set -- "$@" "$f"
done
if [ "$#" -eq 0 ]; then
  echo "No artifacts in dist/. Run 'npm run dist' first." >&2
  exit 1
fi

echo "Signing ${#} artifact(s) with key $key"
gpgsign() { gpg --batch --yes --local-user "$key" "$@"; }

# Start clean so re-signing doesn't accumulate stale files.
rm -f "$dist"/*.asc "$dist"/*.sig "$dist"/SHA256SUMS

for f in "$@"; do
  case $f in
    *.pkg.tar.zst) gpgsign --detach-sign --output "$f.sig" "$f" ;;
    *) gpgsign --armor --detach-sign --output "$f.asc" "$f" ;;
  esac
  echo "  signed $(basename "$f")"
done

# Checksums over the artifacts (basenames, so `sha256sum -c` runs from dist/),
# with a detached signature over the list.
( cd "$dist" && : > SHA256SUMS && for f in "$@"; do sha256sum "$(basename "$f")" >> SHA256SUMS; done )
gpgsign --armor --detach-sign --output "$dist/SHA256SUMS.asc" "$dist/SHA256SUMS"
echo "  signed SHA256SUMS"

# Public key for downloaders to import and verify against.
gpg --armor --export "$key" > "$dist/annoscr-signing-key.asc"
echo "  exported annoscr-signing-key.asc"

echo
echo "Verify with:"
echo "  cd dist && gpg --verify SHA256SUMS.asc SHA256SUMS && sha256sum -c SHA256SUMS"
