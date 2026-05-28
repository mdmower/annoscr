import Xdp from 'gi://Xdp?version=1.0';

const portal = new Xdp.Portal();

// Ask the desktop portal to capture a screenshot. INTERACTIVE lets the
// compositor show its own area/window/screen picker, so this works with
// GNOME's native capture UI without Annoscr reimplementing region selection.
// Resolves to a file:// URI for the saved image. Rejects (GLib.Error) if the
// user cancels or the portal fails — the caller treats both the same way.
//
// GJS doesn't surface libportal's promise overload, so we drive the async
// callback form ourselves rather than awaiting take_screenshot directly.
export function takeScreenshot(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    portal.take_screenshot(null, Xdp.ScreenshotFlags.INTERACTIVE, null, (_source, result) => {
      try {
        resolve(portal.take_screenshot_finish(result));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}
