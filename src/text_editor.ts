import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

// Background tint on the live TextView/Frame so the canvas image shows
// through. Applied once at the display level — collision with other
// widgets is fine since the CSS class is editor-specific.
const EDITOR_CSS = `
  .annoscr-editor-frame {
    background-color: rgba(255, 255, 255, 0.3);
  }
  .annoscr-editor-view, .annoscr-editor-view text {
    background-color: transparent;
  }
  .annoscr-editor-view {
    caret-color: #333;
  }
  .annoscr-format-btn {
    color: #333;
  }
  .annoscr-format-btn:checked {
    color: #111;
  }
`;

let editorCssInstalled = false;
function installEditorCss(): void {
  if (editorCssInstalled) return;
  const display = Gdk.Display.get_default();
  if (!display) return;
  const provider = new Gtk.CssProvider();
  provider.load_from_string(EDITOR_CSS);
  // Gtk.StyleContext is wholly deprecated in 4.10+ but display-level CSS
  // providers have no replacement; the deprecation note itself says
  // "otherwise, there is no replacement." Same situation as the cairo
  // pixel-data accessors in exporter.ts / image_loader.ts.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  Gtk.StyleContext.add_provider_for_display(
    display,
    provider,
    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
  );
  editorCssInstalled = true;
}

export interface TextEditorStyle {
  color: [number, number, number, number];
  fontDesc: string;
  size: number; // image-space pixels (font height)
}

const TAG_NAMES = ['bold', 'italic', 'underline'] as const;
type TagName = (typeof TAG_NAMES)[number];

const MARKUP_TAG: Record<TagName, string> = {
  bold: 'b',
  italic: 'i',
  underline: 'u',
};

const MARKUP_TAG_REVERSE: Record<string, TagName> = {
  b: 'bold',
  i: 'italic',
  u: 'underline',
};

export interface TextEditorCallbacks {
  onCommit: (markup: string, x: number, y: number, rotation: number, replaceIndex?: number) => void;
  onCancel: (replaceIndex?: number) => void;
}

export interface TextEditorBeginOptions {
  markup?: string;
  replaceIndex?: number;
  rotation?: number; // 0..3 quarter-turns CW (carried through commit unchanged)
  // Visual style for the editor preview. Should match what the editor will
  // commit (font + color from the same source the canvas will render with),
  // so the live TextView visually previews placement and sizing.
  style?: TextEditorStyle;
}

export class TextEditor {
  private readonly frame: Gtk.Frame;
  private readonly view: Gtk.TextView;
  private readonly buffer: Gtk.TextBuffer;
  private readonly callbacks: TextEditorCallbacks;
  private readonly buttons: Record<TagName, Gtk.ToggleButton>;
  // Held as a field so beginAt can measure its height when computing the
  // vertical offset between the frame's top and the TextView's first line.
  private toolbar!: Gtk.Box;
  // Buffer-wide style tag (font + foreground color). Properties are updated
  // on each beginAt to reflect the active style; applied to the full buffer
  // after set_text/setBufferFromMarkup and to each insert range so newly
  // typed text inherits the same baseline. B/I/U tags layer on top.
  private baseTag!: Gtk.TextTag;

  private active: boolean = false;
  private imageX: number = 0;
  private imageY: number = 0;
  private rotation: number = 0;
  private replaceIndex: number | undefined = undefined;
  // Tags that will be applied to the next characters the user types.
  private pendingTags: Set<TagName> = new Set();
  // Guard so the programmatic set_active() in syncButtonStates doesn't
  // re-enter through the buttons' 'toggled' signal.
  private updatingButtons: boolean = false;

  constructor(callbacks: TextEditorCallbacks) {
    this.callbacks = callbacks;

    installEditorCss();

    this.view = new Gtk.TextView({
      wrap_mode: Gtk.WrapMode.NONE,
      accepts_tab: false,
      hexpand: false,
      vexpand: false,
      top_margin: 4,
      bottom_margin: 4,
      left_margin: 8,
      right_margin: 8,
    });
    this.view.add_css_class('annoscr-editor-view');
    this.view.set_size_request(80, -1);

    this.buffer = this.view.get_buffer();
    this.installTags();
    this.installPendingTagsApplier();

    this.toolbar = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 2,
      margin_top: 2,
      margin_bottom: 2,
      margin_start: 2,
      margin_end: 2,
    });
    this.buttons = {
      bold: this.makeFormatButton('format-text-bold-symbolic', 'Bold (Ctrl+B)', 'bold'),
      italic: this.makeFormatButton('format-text-italic-symbolic', 'Italic (Ctrl+I)', 'italic'),
      underline: this.makeFormatButton(
        'format-text-underline-symbolic',
        'Underline (Ctrl+U)',
        'underline'
      ),
    };
    this.toolbar.append(this.buttons.bold);
    this.toolbar.append(this.buttons.italic);
    this.toolbar.append(this.buttons.underline);

    const container = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    container.append(this.toolbar);
    container.append(new Gtk.Separator({orientation: Gtk.Orientation.HORIZONTAL}));
    container.append(this.view);

    this.frame = new Gtk.Frame({
      child: container,
      halign: Gtk.Align.START,
      valign: Gtk.Align.START,
      visible: false,
    });
    this.frame.add_css_class('annoscr-editor-frame');

    this.installKeyHandler();
    this.installSelectionWatcher();
  }

  private makeFormatButton(iconName: string, tooltip: string, tag: TagName): Gtk.ToggleButton {
    // can_focus: false so clicking the button doesn't steal keyboard focus
    // from the TextView — the user keeps typing into the buffer immediately.
    const btn = new Gtk.ToggleButton({
      icon_name: iconName,
      tooltip_text: tooltip,
      has_frame: false,
      can_focus: false,
    });
    btn.add_css_class('annoscr-format-btn');
    btn.connect('toggled', () => {
      if (this.updatingButtons) return;
      this.toggleTag(tag);
    });
    return btn;
  }

  getWidget(): Gtk.Frame {
    return this.frame;
  }

  isActive(): boolean {
    return this.active;
  }

  beginAt(
    imageX: number,
    imageY: number,
    widgetX: number,
    widgetY: number,
    options?: TextEditorBeginOptions
  ): void {
    this.imageX = imageX;
    this.imageY = imageY;
    this.rotation = options?.rotation ?? 0;
    this.replaceIndex = options?.replaceIndex;
    this.pendingTags.clear();
    if (options?.style) this.updateBaseTag(options.style);
    if (options?.markup) {
      this.setBufferFromMarkup(options.markup);
    } else {
      this.buffer.set_text('', -1);
    }
    this.applyBaseTagToBuffer();
    this.active = true;
    // Align the editor so the TextView's first line lands on the click point.
    // The toolbar's natural height + separator + textview top_margin already
    // matches the frame's intrinsic top inset on Debian 13 GNOME; left_margin
    // alone matches the left inset. If a different theme drifts these, add a
    // FRAME_INSET fudge factor here.
    const [, toolbarH] = this.toolbar.measure(Gtk.Orientation.VERTICAL, -1);
    const offsetTop = toolbarH + 1 + 4; // separator + view top_margin
    const offsetLeft = 8; // view left_margin
    this.frame.set_margin_start(Math.max(0, Math.floor(widgetX) - offsetLeft));
    this.frame.set_margin_top(Math.max(0, Math.floor(widgetY) - offsetTop));
    this.frame.set_visible(true);
    this.view.grab_focus();
    this.syncButtonStates();
  }

  commitIfActive(): void {
    if (!this.active) return;
    const start = this.buffer.get_start_iter();
    const end = this.buffer.get_end_iter();
    const plainText = this.buffer.get_text(start, end, true);
    const replaceIndex = this.replaceIndex;
    const rotation = this.rotation;
    this.active = false;
    this.frame.set_visible(false);
    this.replaceIndex = undefined;
    this.rotation = 0;
    if (plainText.trim().length === 0) {
      // No content — treat like a cancel so any hidden source action becomes
      // visible again, rather than silently deleting it.
      this.callbacks.onCancel(replaceIndex);
      return;
    }
    const markup = this.bufferToMarkup();
    this.callbacks.onCommit(markup, this.imageX, this.imageY, rotation, replaceIndex);
  }

  cancel(): void {
    if (!this.active) return;
    const replaceIndex = this.replaceIndex;
    this.active = false;
    this.frame.set_visible(false);
    this.replaceIndex = undefined;
    this.rotation = 0;
    this.callbacks.onCancel(replaceIndex);
  }

  private installTags(): void {
    const table = this.buffer.get_tag_table();
    // Base tag added first so its priority is below B/I/U; later-added tags
    // win on conflicting properties (e.g. italic overrides base style).
    this.baseTag = new Gtk.TextTag({name: 'base'});
    table.add(this.baseTag);
    table.add(new Gtk.TextTag({name: 'bold', weight: Pango.Weight.BOLD}));
    table.add(new Gtk.TextTag({name: 'italic', style: Pango.Style.ITALIC}));
    table.add(new Gtk.TextTag({name: 'underline', underline: Pango.Underline.SINGLE}));
  }

  private updateBaseTag(style: TextEditorStyle): void {
    const desc = Pango.FontDescription.from_string(style.fontDesc);
    desc.set_absolute_size(style.size * Pango.SCALE);
    this.baseTag.set_property('font-desc', desc);

    const rgba = new Gdk.RGBA();
    rgba.red = style.color[0];
    rgba.green = style.color[1];
    rgba.blue = style.color[2];
    rgba.alpha = style.color[3];
    this.baseTag.set_property('foreground-rgba', rgba);
  }

  private applyBaseTagToBuffer(): void {
    const start = this.buffer.get_start_iter();
    const end = this.buffer.get_end_iter();
    this.buffer.apply_tag(this.baseTag, start, end);
  }

  private installPendingTagsApplier(): void {
    // `insert-text` default handler does the insert and revalidates the iter
    // to point AFTER the inserted text. Connecting via _after gives us that
    // post-insert iter so we can apply pending tags to the just-inserted range.
    this.buffer.connect_after('insert-text', (buf, locationIter, text, _len) => {
      const endOffset = locationIter.get_offset();
      const startOffset = endOffset - [...text].length;
      const start = buf.get_iter_at_offset(startOffset);
      const end = buf.get_iter_at_offset(endOffset);
      // Base tag always wraps newly-typed text so it inherits the editor's
      // font + color (TextBuffer's left-side tag-inheritance isn't reliable
      // at offset 0 or after explicit removals).
      buf.apply_tag(this.baseTag, start, end);
      for (const tag of this.pendingTags) {
        buf.apply_tag_by_name(tag, start, end);
      }
    });
  }

  private installKeyHandler(): void {
    const key = new Gtk.EventControllerKey();
    // CAPTURE phase so we see Enter/Escape/Ctrl-shortcuts before the TextView's
    // default key handler (which would otherwise insert newline on Enter).
    key.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    key.connect('key-pressed', (_k, keyval, _keycode, state) => {
      return this.onKeyPressed(keyval, state);
    });
    this.view.add_controller(key);
  }

  private onKeyPressed(keyval: number, state: number): boolean {
    const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
    const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
    const alt = (state & Gdk.ModifierType.ALT_MASK) !== 0;

    if (keyval === Gdk.KEY_Escape) {
      this.cancel();
      return true;
    }
    if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
      if (shift) return false; // let TextView insert a newline
      this.commitIfActive();
      return true;
    }
    if (ctrl && !alt) {
      const tag = keyToTag(keyval);
      if (tag) {
        this.toggleTag(tag);
        return true;
      }
    }
    return false;
  }

  private toggleTag(tag: TagName): void {
    const [hasSel, start, end] = this.buffer.get_selection_bounds();
    if (hasSel) {
      // If every character in the selection has the tag, remove it; otherwise apply.
      if (allCharsHaveTag(start, end, tag)) {
        this.buffer.remove_tag_by_name(tag, start, end);
        this.pendingTags.delete(tag);
      } else {
        this.buffer.apply_tag_by_name(tag, start, end);
        this.pendingTags.add(tag);
      }
    } else {
      // No selection — toggle pending state for next-typed chars.
      if (this.pendingTags.has(tag)) this.pendingTags.delete(tag);
      else this.pendingTags.add(tag);
    }
    this.syncButtonStates();
  }

  // Watch buffer marks so the B/I/U buttons reflect "what would I see if I
  // toggled now" after the cursor or selection moves. Only the named insert
  // and selection_bound marks signal real cursor/selection changes;
  // anonymous marks fire too and we ignore them.
  private installSelectionWatcher(): void {
    this.buffer.connect('mark-set', (_buf, _iter, mark) => {
      const name = mark.get_name();
      if (name === 'insert' || name === 'selection_bound') {
        this.syncButtonStates();
      }
    });
  }

  private syncButtonStates(): void {
    this.updatingButtons = true;
    for (const tag of TAG_NAMES) {
      this.buttons[tag].set_active(this.isTagActiveForButton(tag));
    }
    this.updatingButtons = false;
  }

  // What the button should show:
  //   - with selection: pressed iff every selected char has the tag (matches
  //     toggleTag's "all-or-nothing" branch — pressing removes, otherwise applies)
  //   - no selection: pressed iff the tag is pending (will apply to next type)
  private isTagActiveForButton(tag: TagName): boolean {
    const [hasSel, start, end] = this.buffer.get_selection_bounds();
    if (hasSel) return allCharsHaveTag(start, end, tag);
    return this.pendingTags.has(tag);
  }

  // Walk the buffer character-by-character. When the active tag set changes,
  // close all currently-open markup tags and re-open the new set in a canonical
  // order. Always produces valid (well-nested) Pango markup.
  private bufferToMarkup(): string {
    const start = this.buffer.get_start_iter();
    const end = this.buffer.get_end_iter();
    const openStack: TagName[] = [];

    let result = '';
    let prev: Set<TagName> = new Set();

    const iter = start.copy();
    while (!iter.equal(end)) {
      const tags = activeTagSet(iter);

      if (!setsEqual(tags, prev)) {
        while (openStack.length > 0) {
          result += `</${MARKUP_TAG[openStack.pop()!]}>`;
        }
        for (const t of TAG_NAMES) {
          if (tags.has(t)) {
            result += `<${MARKUP_TAG[t]}>`;
            openStack.push(t);
          }
        }
        prev = tags;
      }

      // GJS binds gtk_text_iter_get_char to a string, not a codepoint number.
      result += escapeMarkup(iter.get_char());

      if (!iter.forward_char()) break;
    }

    while (openStack.length > 0) {
      result += `</${MARKUP_TAG[openStack.pop()!]}>`;
    }
    return result;
  }

  // Inverse of bufferToMarkup. We only emit <b>/<i>/<u> and entity escapes,
  // so a small custom parser is enough. GJS's Pango.AttrIterator.get(type) is
  // unreliable, so we don't use Pango.parse_markup here.
  private setBufferFromMarkup(markup: string): void {
    const {plainText, runs} = parseSimpleMarkup(markup);
    this.buffer.set_text(plainText, -1);
    for (const run of runs) {
      if (run.tags.size === 0) continue;
      const start = this.buffer.get_iter_at_offset(run.start);
      const end = this.buffer.get_iter_at_offset(run.end);
      for (const tag of run.tags) {
        this.buffer.apply_tag_by_name(tag, start, end);
      }
    }
  }
}

interface MarkupRun {
  start: number;
  end: number;
  tags: Set<TagName>;
}

function parseSimpleMarkup(markup: string): {
  plainText: string;
  runs: MarkupRun[];
} {
  let plainText = '';
  const runs: MarkupRun[] = [];
  const stack: TagName[] = [];
  let runStart = 0;

  function flushRun(end: number): void {
    if (end > runStart) {
      runs.push({start: runStart, end, tags: new Set(stack)});
    }
    runStart = end;
  }

  let i = 0;
  while (i < markup.length) {
    const ch = markup[i];
    if (ch === '<') {
      flushRun(plainText.length);
      const gt = markup.indexOf('>', i);
      if (gt < 0) break;
      const inner = markup.slice(i + 1, gt);
      const closing = inner.startsWith('/');
      const name = closing ? inner.slice(1) : inner;
      const tagName = MARKUP_TAG_REVERSE[name];
      if (tagName) {
        if (closing) {
          const idx = stack.lastIndexOf(tagName);
          if (idx >= 0) stack.splice(idx, 1);
        } else {
          stack.push(tagName);
        }
      }
      i = gt + 1;
    } else if (ch === '&') {
      const semi = markup.indexOf(';', i);
      if (semi < 0) {
        plainText += ch;
        i++;
      } else {
        const entity = markup.slice(i + 1, semi);
        plainText += decodeEntity(entity);
        i = semi + 1;
      }
    } else {
      plainText += ch;
      i++;
    }
  }
  flushRun(plainText.length);

  return {plainText, runs};
}

function decodeEntity(name: string): string {
  switch (name) {
    case 'amp':
      return '&';
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'quot':
      return '"';
    case 'apos':
      return "'";
    default:
      // Numeric character references (&#NN; / &#xHH;) are rare in our output
      // but worth a try; unknown entities collapse to empty.
      if (name.startsWith('#x') || name.startsWith('#X')) {
        const code = parseInt(name.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : '';
      }
      if (name.startsWith('#')) {
        const code = parseInt(name.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : '';
      }
      return '';
  }
}

function keyToTag(keyval: number): TagName | null {
  if (keyval === Gdk.KEY_b || keyval === Gdk.KEY_B) return 'bold';
  if (keyval === Gdk.KEY_i || keyval === Gdk.KEY_I) return 'italic';
  if (keyval === Gdk.KEY_u || keyval === Gdk.KEY_U) return 'underline';
  return null;
}

function activeTagSet(iter: Gtk.TextIter): Set<TagName> {
  const set = new Set<TagName>();
  for (const tag of iter.get_tags()) {
    const name = tag.name as TagName;
    if (TAG_NAMES.includes(name)) set.add(name);
  }
  return set;
}

function allCharsHaveTag(start: Gtk.TextIter, end: Gtk.TextIter, tagName: TagName): boolean {
  const iter = start.copy();
  while (!iter.equal(end)) {
    if (!activeTagSet(iter).has(tagName)) return false;
    if (!iter.forward_char()) break;
  }
  return true;
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
