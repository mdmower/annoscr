// Loose module declarations for `gi://` imports.
// Replace with proper `@girs/*` typings once vendored under `typings/`.

declare module 'gi://GLib?version=2.0' { const m: any; export default m; }
declare module 'gi://GObject?version=2.0' { const m: any; export default m; }
declare module 'gi://Gio?version=2.0' { const m: any; export default m; }
declare module 'gi://Gdk?version=4.0' { const m: any; export default m; }
declare module 'gi://Gtk?version=4.0' { const m: any; export default m; }
declare module 'gi://Adw?version=1' { const m: any; export default m; }
declare module 'gi://GdkPixbuf?version=2.0' { const m: any; export default m; }
declare module 'gi://Pango?version=1.0' { const m: any; export default m; }
declare module 'gi://PangoCairo?version=1.0' { const m: any; export default m; }
declare module 'gi://cairo?version=1.0' { const m: any; export default m; }

// GJS top-level globals.
declare const ARGV: string[];
declare const imports: any;
declare function print(...args: unknown[]): void;
declare function printerr(...args: unknown[]): void;
declare function log(...args: unknown[]): void;
declare function logError(e: unknown, prefix?: string): void;
