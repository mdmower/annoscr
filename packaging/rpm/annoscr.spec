Name:           annoscr
Version:        2.2.0
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
# Minimum versions come from Debian 13 (GNOME 48), the oldest supported
# distribution, whose GIR files the code is type-checked against. The remaining
# typelibs have older minimums.
Requires:       gjs >= 1.82
Requires:       gtk4 >= 4.18
Requires:       libadwaita >= 1.7
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
* Sun Sep 20 2026 Matt Mower <mdmower@cmphys.com> - 2.2.0-1
- An arrow's head and its tail are set separately, and each can be nothing, wings, or filled. Every combination is allowed, so an arrow can point both ways or neither. Arrows in existing files keep the heads they were saved with.
- Annoscr now requires GNOME 48 or newer: Debian 13, Ubuntu 26.04, Fedora 43, or current Arch. Two calls it already made need GTK 4.18 and libadwaita 1.6, so the minimums it declared before were too low.
- The apt repository no longer serves a noble suite, since Ubuntu 24.04 is below the new minimum. On Ubuntu, set Suites to resolute.
- Cancelling "Add a font" in Preferences no longer logs a warning.
* Tue Sep 15 2026 Matt Mower <mdmower@cmphys.com> - 2.1.0-1
- Each number stamp group has a Start number, which sets the number of its first stamp; the rest count up from there. In letter mode the field accepts a single letter, and letters still wrap after Z.
- Text is measured the same way at every zoom level, so text in a rectangle or oval no longer re-wraps as the zoom changes, and what is drawn on screen matches the exported image.
- On a HiDPI display, the image and image items are drawn at the display's full resolution instead of being scaled up from a lower-resolution copy.

* Sun Sep 13 2026 Matt Mower <mdmower@cmphys.com> - 2.0.0-1
- Annotation files: Annoscr 2.0 cannot open files written by Annoscr 1.4 or earlier (open and save them in Annoscr 1.5 first), and files saved by 2.0 cannot be opened by 1.x releases.
- Images can be added to the canvas as items: paste with Ctrl+Shift+V, drop image files on an open canvas, or choose Insert image file from the primary menu. An item can be moved, resized (it keeps its proportions; hold Shift to stretch it), rotated, and made translucent, and keeps its full resolution. Dropping an image on an open canvas now adds it as an item instead of replacing the canvas.
- Scale image (Ctrl+Shift+E) resamples the image to a new size, as a percentage or in pixels, with the aspect ratio locked. Annotations scale by the same factor and stay editable. Scale image and Crop or expand (Ctrl+E, formerly Resize canvas) are in a menu on the image dimensions in the status bar, which replaces the crop button in the header bar.
- Replace background, in the primary menu, replaces the image under the annotations with a color or another image, keeping the canvas size and every annotation. An image of another size is cropped or padded to the canvas, aligned by a 3x3 anchor.
- The Select and arrange menu (formerly the selection actions menu) is shown whenever the Select tool is active, and adds every annotation of one type to the selection, such as all arrows or all text.
- Stroke width, corner radius, font size, and opacity are set with spin buttons instead of sliders. Width, corner radius, and font size accept decimals, with ranges of 0.1 to 400, 0 to 2000, and 1 to 1000.
- Saving, exporting, and copying a large image no longer freezes the window while the image is encoded.
- When zoomed out, the image is redrawn from a resampled copy after the zoom stops changing, so text and thin lines stay legible.
- Ctrl+H shows or hides the recent files strip.
- Each change of line style, arrowhead, or text alignment is a separate undo step. Changing a color and then changing it back no longer leaves an undo step that does nothing.
- The curve handle is hidden on lines and arrows shorter than 64 pixels on screen, so dragging a short segment moves it instead of bending it.
- Dragging a selection box selects a rectangle or oval with a callout tail only when the tail's tip is also inside the box.

* Sun Aug 02 2026 Matt Mower <mdmower@cmphys.com> - 1.5.0-1
- A recent files strip below the status bar keeps thumbnails of the images, annotation files, and screenshots you open, so returning to an earlier one is a single click. A status bar button shows or hides it, and right-clicking a thumbnail offers Show in Files and Forget.
- Files can be lined up in the strip without opening any of them: drop a selection onto the strip, or press Insert to choose them from a dialog, then work through them one at a time.
- Lines and arrows can be curved. Drag the round handle at the middle of a selected segment to bend it; the arrowhead follows the curve and points where the ink arrives. Drag the handle back to the middle, or use Straighten in the selection actions menu, to flatten it again.
- The style bar can be docked to any window edge from Preferences. Top and bottom keep the horizontal strip; left and right show the controls as a vertical panel.
- Annotation files are stored in a new format that opens faster and no longer inflates the embedded image. Files written by earlier releases still open, and saving one writes the new format; support for the old format will be removed in 2.0.
- The eyedropper now cancels when you click outside the canvas, instead of staying active invisibly and capturing your next click on the image.
- Pasting an annotation file copied in the file manager now opens it as a document, matching what dropping the same file already did.

* Sat Jul 18 2026 Matt Mower <mdmower@cmphys.com> - 1.4.0-1
- Each color popover (Color, Fill, and Text color) gains an eyedropper that picks a color straight from the image, with a magnifier loupe and hex readout; annotations are included in the sample.
- A new Default tool preference chooses which tool is active when the app starts.
- Translucent arrows now render with uniform opacity; the shaft and head no longer darken where they overlap.

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
