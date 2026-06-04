import Gtk from 'gi://Gtk?version=4.0';

// Thin wrappers over the GtkAccessible property/relation API. They exist to
// hide the calling convention: update_property/update_relation take parallel
// arrays (one property/relation per slot, its value in the matching slot), and
// a relation whose value is a reference list — LABELLED_BY — wants that list
// nested one level deeper. Centralizing it keeps call sites readable and the
// nesting correct in one place.

// Set a widget's accessible name. Use for icon-only controls whose meaning is
// otherwise carried only by an icon (tooltips are not reliably exposed to AT).
export function setAccessibleLabel(w: Gtk.Accessible, label: string): void {
  w.update_property([Gtk.AccessibleProperty.LABEL], [label]);
}

// Set a widget's accessible description (the supplementary detail a screen
// reader reads after the name).
export function setAccessibleDescription(w: Gtk.Accessible, description: string): void {
  w.update_property([Gtk.AccessibleProperty.DESCRIPTION], [description]);
}

// Copy a widget's tooltip to its accessible name. The many icon-only buttons
// already carry a tooltip stating their purpose, so this keeps the accessible
// label in sync with the visible hint without restating the string.
export function labelFromTooltip(w: Gtk.Widget): void {
  const tip = w.get_tooltip_text();
  if (tip) setAccessibleLabel(w, tip);
}

// Name a control by one or more visible label widgets. The control's accessible
// name then tracks the label's text live, so a caption that gains a "(mixed)"
// suffix is reflected to AT without a second update call.
//
// The LABELLED_BY value is a reference list, which GJS only marshals correctly
// when boxed in a Gtk.AccessibleList via new_from_list (a plain array fails to
// guess the GValue type; new_from_array mismarshals its length).
export function setLabelledBy(w: Gtk.Accessible, ...labels: Gtk.Accessible[]): void {
  w.update_relation(
    [Gtk.AccessibleRelation.LABELLED_BY],
    [Gtk.AccessibleList.new_from_list(labels)]
  );
}

// Request the screen reader speak a transient message (selection/placement/
// deletion feedback). MEDIUM lets it interrupt lower-priority chatter without
// preempting the user's own typing.
export function announce(w: Gtk.Accessible, message: string): void {
  w.announce(message, Gtk.AccessibleAnnouncementPriority.MEDIUM);
}
