#!/bin/sh

# Run lintian against the most recently built .deb to catch Debian policy
# issues. Build the packages first with `npm run dist` (it writes them to
# dist/).
#
# Run via `npm run lint:deb`, or directly with `sh build-aux/lint-deb.sh`.

set -eu

if ! command -v lintian >/dev/null 2>&1; then
  echo "lintian is not installed. Install it with: sudo apt-get install lintian" >&2
  exit 1
fi

root=$(CDPATH="" cd -- "$(dirname -- "$0")/.." && pwd)

# Newest annoscr_*.deb in dist/, where the release build writes it.
deb=$(ls -t "$root"/dist/annoscr_*.deb 2>/dev/null | head -n1 || true)
if [ -z "${deb:-}" ]; then
  echo "No dist/annoscr_*.deb found. Build one with: npm run dist" >&2
  exit 1
fi

echo "Linting $deb"
exec lintian "$deb"
