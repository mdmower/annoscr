Name:           annoscr
Version:        1.3.0
Release:        1%{?dist}
Summary:        Lightweight screenshot annotation tool for GNOME

License:        GPL-3.0-or-later
URL:            https://github.com/mdmower/annoscr
Source0:        %{url}/archive/v%{version}/%{name}-%{version}.tar.gz

BuildArch:      noarch

BuildRequires:  meson >= 1.4.0
BuildRequires:  ninja-build
BuildRequires:  gettext
BuildRequires:  nodejs
BuildRequires:  npm
# meson resolves the gjs path at configure time to bake into the launcher.
BuildRequires:  gjs
# Used by the meson test suite (best-effort validation of the desktop and
# metainfo files); harmless if the build runs without %%check.
BuildRequires:  desktop-file-utils
BuildRequires:  appstream

# Runtime libraries GJS loads via GObject-Introspection. This is a noarch JS
# payload with no ELF objects, so RPM's automatic dependency generator can't
# infer them — list them explicitly. Fedora's GI packages carry no typelib()
# virtual Provides (the .typelib files ship inside these library packages), so
# depend on the packages directly. rpmlint's explicit-lib-dependency advisory
# for libadwaita/libportal is a false positive here, filtered in
# annoscr.rpmlintrc.
# Version floors set by the newest APIs used: GTK 4.14 accessibility and
# libadwaita 1.5 dialogs (the GNOME 46 baseline); GJS needs gi:// ESM imports.
Requires:       gjs >= 1.72
Requires:       gtk4 >= 4.14
Requires:       libadwaita >= 1.5
Requires:       gdk-pixbuf2
Requires:       pango
Requires:       libportal
Requires:       hicolor-icon-theme
# Screenshot capture goes through the XDG desktop portal; the service and a
# Screenshot-capable backend are needed only for that one feature (and ship with
# the GNOME desktop), so recommend rather than require.
Recommends:     xdg-desktop-portal

%description
Annoscr lets you annotate screenshots with arrows, text, shapes,
highlighter strokes, and numbered stamps. It also supports basic
rotation and cropping, and can export to PNG or JPEG or copy to the
clipboard.

Built with GJS, GTK4, and Libadwaita.

%prep
%autosetup

%build
# TypeScript is compiled by the project-local tsc (node_modules/.bin/tsc), which
# meson requires at configure time, so the npm packages must be present before
# `meson setup` runs. This step needs network access and is therefore unsuitable
# for a no-network build environment (mock/koji); build in one that allows it.
npm install --no-audit --no-fund
%meson
%meson_build

%install
%meson_install

%check
%meson_test

%files
%license COPYING
%doc README.md
%{_bindir}/%{name}
%{_datadir}/applications/com.cmphys.Annoscr.desktop
%{_datadir}/dbus-1/services/com.cmphys.Annoscr.service
%{_metainfodir}/com.cmphys.Annoscr.metainfo.xml
%{_datadir}/mime/packages/com.cmphys.Annoscr.mime.xml
%{_datadir}/icons/hicolor/scalable/apps/com.cmphys.Annoscr.svg
%{_datadir}/icons/hicolor/scalable/actions/annoscr-*-symbolic.svg
%{_datadir}/%{name}/
%{_mandir}/man1/%{name}.1*

%changelog
* Thu Jul 02 2026 Matt Mower <mdmower@cmphys.com> - 1.3.0-1
- Rectangles and ovals can now grow a callout tail, turning a shape into a speech-bubble style pointer. Turn on the Callout switch for a selected rectangle or oval to add one.
- Drag the callout tail's tip to aim it anywhere around the shape; hold Shift to snap its angle. The tail rotates and resizes along with its shape.

* Tue Jun 30 2026 Matt Mower <mdmower@cmphys.com> - 1.2.1-1
- The text placement editor scales with the zoom level, so placing text on a zoomed-out image no longer opens an oversized card; the box-text editor centers on its shape.
- Cancelling a command-line screenshot capture with no instance already running now exits cleanly instead of leaving an empty window.

* Mon Jun 22 2026 Matt Mower <mdmower@cmphys.com> - 1.2.0-1
- Right-click and drag pans the canvas with any tool, and the arrow keys pan when nothing is selected.
- Drag a box across empty canvas to select every annotation fully inside it; Ctrl+A selects all and Esc clears the selection.
- A rubber-band selection or a selection move auto-scrolls the canvas at a viewport edge.
- Opening and dismissing the color picker no longer flattens a mixed-color multi-selection.

* Tue Jun 17 2026 Matt Mower <mdmower@cmphys.com> - 1.1.0-1
- New preferences can close the window after a save or copy, and a silent-save option writes images straight to the default folder without a dialog.
- When the window auto-closes, a system notification with a thumbnail reopens the saved file or re-pastes the copied image, and "Show in Files" reveals a saved image.
- Images respect their EXIF orientation when loaded, so photos appear upright.
- An arrowhead no longer overshoots the shaft on very short arrows.

* Sun Jun 14 2026 Matt Mower <mdmower@cmphys.com> - 1.0.3-1
- The window remembers its size and maximized state across launches.
- Holding Shift while drawing a line or arrow snaps its angle to 15° increments.

* Fri Jun 12 2026 Matt Mower <mdmower@cmphys.com> - 1.0.2-1
- A text annotation's background plate wraps the text exactly, so the glyphs no longer spill past its edge with some fonts.

* Thu Jun 11 2026 Matt Mower <mdmower@cmphys.com> - 1.0.1-1
- Cursor-anchored zoom stays pinned under the pointer instead of drifting.
- Resize snaps to whole pixels so the crop matches the dashed preview.
- A resize fill covers only the added margin, not transparent areas of the existing image.
- A fast double-click no longer drops a duplicate stamp or pen dot.
- A text annotation's background plate is included in hit-testing and selection bounds.
- The hover aim outline tracks the right annotation after a rotate, delete, or group change.
- Command-line --help documents the FILE argument.
- The select-after-placement selection survives the text commit click.

* Wed Jun 10 2026 Matt Mower <mdmower@cmphys.com> - 1.0.0-1
- Editable annotation files (.annoscr): save the canvas and annotations together and reopen to keep editing.
- New Undo memory preference bounds the memory kept for canvas rotate/resize undo steps.
- The standalone text editor previews text at the current zoom level.
- Editing and accessibility polish: keyboard focus ring, tilted outline on rotated annotations, mixed-value marker.
- Translated the paste notifications.

* Thu Jun 04 2026 Matt Mower <mdmower@cmphys.com> - 0.9.0-1
- First public release.
