/*
  Typing-context guard for hand-rolled key listeners (the hold-A quick-add;
  react-hotkeys-hook bindings use the library's equivalent built-in guards).
  True when the event target is a place where letter keys mean TYPING — form
  fields or anything contenteditable (the inline text editor) — so single-key
  shortcuts must stay silent.
*/
export function getIsEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tagName = target.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}
