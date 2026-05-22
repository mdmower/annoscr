import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

const TAG_NAMES = ['bold', 'italic', 'underline'] as const;
type TagName = typeof TAG_NAMES[number];

const MARKUP_TAG: Record<TagName, string> = {
  bold: 'b',
  italic: 'i',
  underline: 'u',
};

export type TextCommitCallback = (markup: string, x: number, y: number) => void;

export class TextEditor {
  private readonly frame: any;
  private readonly view: any;
  private readonly buffer: any;
  private readonly commitCallback: TextCommitCallback;

  private active: boolean = false;
  private imageX: number = 0;
  private imageY: number = 0;
  // Tags that will be applied to the next characters the user types.
  // Set is updated on Ctrl+B/I/U; persists across the edit session.
  private pendingTags: Set<TagName> = new Set();

  constructor(commitCallback: TextCommitCallback) {
    this.commitCallback = commitCallback;

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

  getWidget(): any {
    return this.frame;
  }

  isActive(): boolean {
    return this.active;
  }

  beginAt(imageX: number, imageY: number, widgetX: number, widgetY: number): void {
    this.imageX = imageX;
    this.imageY = imageY;
    this.buffer.set_text('', -1);
    this.pendingTags.clear();
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
    this.active = false;
    this.frame.set_visible(false);
    if (plainText.trim().length === 0) return;
    const markup = this.bufferToMarkup();
    this.commitCallback(markup, this.imageX, this.imageY);
  }

  cancel(): void {
    if (!this.active) return;
    this.active = false;
    this.frame.set_visible(false);
  }

  private installTags(): void {
    const table = this.buffer.get_tag_table();
    table.add(new Gtk.TextTag({ name: 'bold', weight: Pango.Weight.BOLD }));
    table.add(new Gtk.TextTag({ name: 'italic', style: Pango.Style.ITALIC }));
    table.add(new Gtk.TextTag({ name: 'underline', underline: Pango.Underline.SINGLE }));
  }

  private installPendingTagsApplier(): void {
    // `insert-text` default handler does the insert and revalidates the iter
    // to point AFTER the inserted text. Connecting via _after gives us that
    // post-insert iter so we can apply pending tags to the just-inserted range.
    this.buffer.connect_after('insert-text', (buf: any, locationIter: any, text: string, _len: number) => {
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
    key.connect('key-pressed', (_k: any, keyval: number, _keycode: number, state: number) => {
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

    let result = '';
    let openStack: TagName[] = [];
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
}

function keyToTag(keyval: number): TagName | null {
  if (keyval === Gdk.KEY_b || keyval === Gdk.KEY_B) return 'bold';
  if (keyval === Gdk.KEY_i || keyval === Gdk.KEY_I) return 'italic';
  if (keyval === Gdk.KEY_u || keyval === Gdk.KEY_U) return 'underline';
  return null;
}

function activeTagSet(iter: any): Set<TagName> {
  const set = new Set<TagName>();
  for (const tag of iter.get_tags()) {
    const name = tag.name as TagName;
    if (TAG_NAMES.includes(name)) set.add(name);
  }
  return set;
}

function allCharsHaveTag(start: any, end: any, tagName: TagName): boolean {
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
