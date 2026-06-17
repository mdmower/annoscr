# Packaging and releases

Building Annoscr's distribution packages, and cutting a signed release. For building and running from source, see [CONTRIBUTING.md](../CONTRIBUTING.md).

The package builds reuse the Meson build and run `npm install` to fetch the TypeScript compiler, so the build host needs network access.

## Debian (.deb)

```sh
sudo apt install debhelper devscripts
dpkg-buildpackage -us -uc -b
# .deb lands in the parent directory
```

Check the built package against Debian policy (the script lints the most recent `../annoscr_*.deb` with `lintian`):

```sh
sudo apt install lintian
npm run lint:deb
# or build and lint in one step:  debuild -us -uc -b
```

The package installs a man page, so `man annoscr` documents the command-line options once installed.

## Fedora / openSUSE (RPM) and Arch

RPM and Arch packaging live under [packaging/](../packaging/). Run these from the repo root.

```sh
# RPM (Fedora / openSUSE) - dnf builddep installs the spec's BuildRequires
sudo dnf builddep packaging/rpm/annoscr.spec
git archive --prefix=annoscr-1.1.0/ \
  -o ~/rpmbuild/SOURCES/annoscr-1.1.0.tar.gz HEAD
rpmbuild -ba packaging/rpm/annoscr.spec
rpmlint -r packaging/rpm/annoscr.rpmlintrc \
  ~/rpmbuild/RPMS/noarch/annoscr-*.rpm

# Arch - makepkg fetches the source from the release tag, then builds and installs.
cd packaging/arch && makepkg -si
```

The `git archive` line stages a source tarball for `rpmbuild`; for an actual release, fetch the published tarball instead (e.g. `spectool -g`). The RPM declares its runtime libraries explicitly because a noarch GJS payload has no ELF links for RPM to scan, so `annoscr.rpmlintrc` filters the resulting (expected) `explicit-lib-dependency` advisory.

## Cutting a release

```sh
# Sync the version across package.json (+ lockfile), the spec, and the PKGBUILD.
npm run set-version -- x.y.z

# Build .deb + .rpm + Arch packages into dist/
npm run dist

# Generate detached GPG signatures and signed SHA256SUMS in dist/
npm run sign
```

`npm run set-version` ([build-aux/set-version.sh](../build-aux/set-version.sh)) only
syncs the version _fields_; it does not write any release notes. Before building,
hand-add a dated `x.y.z` entry to all three changelogs (it prints this reminder too):

- `debian/changelog` (e.g. `dch -v x.y.z`),
- `data/com.cmphys.Annoscr.metainfo.xml.in` — a `<release version="x.y.z" date="YYYY-MM-DD">` block whose body is wrapped in `<description its:translate="no">`,
- `packaging/rpm/annoscr.spec` `%changelog`.

Also bump the hardcoded version examples in [README.md](../README.md) (the verify/install
commands) and this file (the `git archive` example above), and regenerate the translation
template if UI strings changed since the last release (`npm run regenerate-languages`,
writing `po/annoscr.pot`). `npm run dist` aborts if any of the version fields disagree.

`npm run dist` ([build-aux/dist.sh](../build-aux/dist.sh)) builds the `.deb` on this host and the `.rpm` and Arch package in Fedora/Arch Docker containers (so it needs Docker and network for those two). All packages are saved to gitignored `dist/`, ready to attach to a GitHub release. This command aborts if any version fields disagree.

`npm run sign` ([build-aux/sign.sh](../build-aux/sign.sh)) adds a detached GPG signature next to each artifact (the Arch package gets a `.sig`, as pacman expects; the rest get an armored `.asc`), writes a `SHA256SUMS` plus its `SHA256SUMS.asc`, and exports the public key as `annoscr-signing-key.asc`. The key is taken from `$ANNOSCR_SIGNING_KEY`, falling back to `git config user.signingkey`. Users verify a release as described under [Verifying downloads](../README.md#verifying-downloads).
