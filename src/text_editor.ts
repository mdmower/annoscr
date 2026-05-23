import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

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
}

export class TextEditor {
  private readonly frame: Gtk.Frame;
  private readonly view: Gtk.TextView;
  private readonly buffer: Gtk.TextBuffer;
  private readonly callbacks: TextEditorCallbacks;

  private active: boolean = false;
  private imageX: number = 0;
  private imageY: number = 0;
  private rotation: number = 0;
  private replaceIndex: number | undefined = undefined;
  // Tags that will be applied to the next characters the user types.
  private pendingTags: Set<TagName> = new Set();

  constructor(callbacks: TextEditorCallbacks) {
    this.callbacks = callbacks;

    this.view = new Gtk.TextView({
      wrap_mode: Gtk.WrapMode.NONE,
      accepts_tab: false,
      hexpand: false,
      vexpand: false,
      top_margin: 4,
      bottom_margin: 4,
      left_margin: 4,
      right_margin: 4,
    });
    this.view.set_size_request(80, -1);

    this.buffer = this.view.get_buffer();
    this.installTags();
    this.installPendingTagsApplier();

    this.frame = new Gtk.Frame({
      child: this.view,
      halign: Gtk.Align.START,
      valign: Gtk.Align.START,
      visible: false,
    });

    this.installKeyHandler();
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
    if (options?.markup) {
      this.setBufferFromMarkup(options.markup);
    } else {
      this.buffer.set_text('', -1);
    }
    this.active = true;
    // Offset by a few pixels so the frame border/padding doesn't push the
    // visible text cursor too far from where the user clicked.
    this.frame.set_margin_start(Math.max(0, Math.floor(widgetX) - 6));
    this.frame.set_margin_top(Math.max(0, Math.floor(widgetY) - 6));
    this.frame.set_visible(true);
    this.view.grab_focus();
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
    table.add(new Gtk.TextTag({name: 'bold', weight: Pango.Weight.BOLD}));
    table.add(new Gtk.TextTag({name: 'italic', style: Pango.Style.ITALIC}));
    table.add(new Gtk.TextTag({name: 'underline', underline: Pango.Underline.SINGLE}));
  }

  private installPendingTagsApplier(): void {
    // `insert-text` default handler does the insert and revalidates the iter
    // to point AFTER the inserted text. Connecting via _after gives us that
    // post-insert iter so we can apply pending tags to the just-inserted range.
    this.buffer.connect_after('insert-text', (buf, locationIter, text, _len) => {
      if (this.pendingTags.size === 0) return;
      const endOffset = locationIter.get_offset();
      const startOffset = endOffset - [...text].length;
      const start = buf.get_iter_at_offset(startOffset);
      const end = buf.get_iter_at_offset(endOffset);
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
