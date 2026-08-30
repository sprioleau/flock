import { formatShortcut } from "@/components/studio/shortcuts/shortcut-keys";
import type { Suggestion, SuggestionRung, SuggestionRungId } from "./types";

/**
 * Keyboard reach for the live suggestion card (Phase 7.3).
 *
 * The card sits directly above the composer, so a suggestion that only
 * accepts a click makes the user leave the keyboard mid-edit. ⌥A (Alt+A)
 * applies it; Esc dismisses it through the same persistence path as the ×
 * button.
 *
 * WHY ⌥A AND NOT ⌘↵. ⌘↵ was the first choice and was wrong: the composer
 * submits on Enter WITHOUT excluding modifiers (ChatPanel.tsx
 * `handleComposerKeyDown`), so ⌘↵ already sends a chat message there, as
 * does the queued-message editor. Yielding that chord in typing contexts
 * made the shortcut unreachable exactly where the user's focus usually is —
 * the composer, and the property fields whose edits GENERATE these
 * suggestions in the first place. ⌥A is claimed by nothing (the hold-to-
 * quick-add listener requires a bare "a" and bails on altKey), so it fires
 * EVERYWHERE, text fields included. That reach is the whole point of the
 * key; do not reintroduce a typing-context guard on the apply path.
 *
 * THE COST, DELIBERATELY ACCEPTED: while a suggestion is live, ⌥A will not
 * type its character (`å` on a Mac) into the focused field, because the
 * handler calls preventDefault. This is intentional — a live suggestion is
 * rare, transient, and visibly hinted on the card. Please do not "fix" it.
 *
 * THREE RULES THIS MODULE EXISTS TO ENFORCE:
 *
 * 1. NEVER SHORTCUT PAST A GATE. The shortcut only ever reaches the DEFAULT
 *    rung — the first rung the rules registry composed WITHOUT
 *    `needsConfirm` (see types.ts). A confirm-gated rung (the whole-email
 *    re-theme) is unreachable from the keyboard by construction: it is not
 *    "the default rung" before the confirm opens, and while the confirm IS
 *    open ⌥A resolves to `ignore` so the gate keeps its explicit click. The
 *    ladder is ordered smallest-scope first, so the default is also the
 *    least surprising thing to apply blind.
 *
 * 2. ESC STILL YIELDS TO TYPING. Unlike the apply key, Esc IS claimed by
 *    typing contexts — the composer stops dictation with it, the queued
 *    message editor cancels, the inline text editor closes. So Esc alone
 *    declines the keystroke when it lands in a field (the caller passes
 *    `isTypingContext`, keyboard-guards.ts).
 *
 * 3. STAY SILENT WHEN THERE IS NOTHING TO ACT ON. No live suggestion, or a
 *    suggestion the user cannot currently SEE on any surface, resolves to
 *    `ignore`. The card's own mount lifetime already covers the collapsed
 *    tray and the post-apply "Applied — Revert" state. Note "on any surface":
 *    the suggestion now also renders as a pill under the edited block, and a
 *    visible pill makes ⌥A live even with the chat panel collapsed — see
 *    {@link getIsSuggestionReachable}, which is the only thing that computes
 *    `isCardInteractive`.
 *
 * Split into a pure resolver + a caller-owned listener so the whole decision
 * table is unit-testable in the node test environment (no DOM required).
 */

/*
  react-hotkeys-hook combo notation — `alt` renders as ⌥ on Apple keyboards.
*/
export const APPLY_SUGGESTION_COMBO = "alt+a";

/*
  Dismiss the live suggestion (or back out of an open confirm).
*/
export const DISMISS_SUGGESTION_COMBO = "escape";

/*
  The rung ⌥A applies: the first NON-gated rung on the ladder (smallest
  scope first). Null when every rung is confirm-gated — the keyboard path
  then does nothing at all rather than promoting a gated rung.
*/
export function getDefaultRung(suggestion: Suggestion): SuggestionRung | null {
  return suggestion.rungs.find((rung) => rung.needsConfirm !== true) ?? null;
}

/*
  Can the user act on the live suggestion right now?

  This was the second, independent half of "I wasn't sure the feature
  worked": ⌥A was gated on the chat panel being EXPANDED, so with the panel
  collapsed the suggestion was both invisible AND unreachable. It is reachable
  whenever it is on screen SOMEWHERE — the chat card in the expanded panel, or
  the pill under the block that was just edited. The pill reports its own
  mount (suggestion-surface-store.ts) rather than being inferred, so this
  never claims a keystroke for something the user cannot see: the pill hides
  itself in the mobile preview, on a different draft frame, when its block is
  deselected, and after its × is clicked.
*/
export function getIsSuggestionReachable({
  isChatPanelExpanded,
  isCanvasPillVisible,
}: {
  isChatPanelExpanded: boolean;
  isCanvasPillVisible: boolean;
}): boolean {
  return isChatPanelExpanded || isCanvasPillVisible;
}

/*
  The parts of a keydown this decision depends on (a real KeyboardEvent fits).
*/
export interface SuggestionShortcutKeyEvent {
  /*
    The produced character/name — used for Esc only (see `code`).
  */
  key: string;
  /*
    The PHYSICAL key. The apply chord matches on this, never on `key`:
    macOS composes ⌥A into "å", so `key === "a"` silently never fires there.
  */
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /*
    Another handler already claimed this keystroke; leave it alone.
  */
  isDefaultPrevented: boolean;
  /*
    The keystroke landed in a field, the composer, or a contenteditable.
    Consulted for Esc ONLY — ⌥A deliberately fires inside text fields too.
  */
  isTypingContext: boolean;
}

/*
  What the card should do about a keystroke.
*/
export type SuggestionShortcutAction =
  | { name: "ignore" }
  | { name: "apply"; rungId: SuggestionRungId }
  | { name: "dismiss" }
  | { name: "cancelConfirm" };

const IGNORE: SuggestionShortcutAction = { name: "ignore" };

/*
  The whole decision table. Returns `ignore` for every keystroke the card
  must not claim, so the caller can pass the event straight through.
*/
export function resolveSuggestionShortcut({
  event,
  suggestion,
  confirmingRungId,
  isCardInteractive,
}: {
  event: SuggestionShortcutKeyEvent;
  /*
    The live suggestion, or null when nothing is suggested right now.
  */
  suggestion: Suggestion | null;
  /*
    The rung whose inline confirm is currently open, or null.
  */
  confirmingRungId: SuggestionRungId | null;
  /**
   * False while the suggestion exists but the user can see it on NO surface.
   * Always computed by {@link getIsSuggestionReachable}.
   */
  isCardInteractive: boolean;
}): SuggestionShortcutAction {
  if (suggestion === null || !isCardInteractive) {
    return IGNORE;
  }
  if (event.isDefaultPrevented) {
    return IGNORE;
  }

  if (event.key === "Escape") {
    /*
      Rule 2: Esc belongs to whatever field the user is typing in.
    */
    if (event.isTypingContext) {
      return IGNORE;
    }
    /*
      A bare Esc only. ⌥Esc / ⇧Esc belong to the OS and the browser.
    */
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return IGNORE;
    }
    /*
      Esc backs out of the innermost thing first: an open confirm, then the
      suggestion itself.
    */
    return confirmingRungId === null ? { name: "dismiss" } : { name: "cancelConfirm" };
  }

  /*
    ⌥A on the PHYSICAL A key, alt and nothing else — so no larger chord
    (⌘⌥A, ⌥⇧A, browser and OS combos) can trip an apply. Note the absence of
    any isTypingContext check: this chord is meant to reach the user mid-type.
  */
  const isApplyChord =
    event.code === "KeyA" &&
    event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey;
  if (!isApplyChord) {
    return IGNORE;
  }
  /*
    Rule 1: an open confirm is a gate, and gates take an explicit click.
  */
  if (confirmingRungId !== null) {
    return IGNORE;
  }
  const defaultRung = getDefaultRung(suggestion);
  return defaultRung === null ? IGNORE : { name: "apply", rungId: defaultRung.id };
}

/*
  The card's discoverability hint, in the reader's own keyboard notation:
  "⌥A to apply · esc to dismiss" on Apple keyboards, "Alt+A to apply ·
  Esc to dismiss" elsewhere. Derived from the combo constants rather than
  written out, so the hint cannot drift from the binding. While a confirm is
  open the only live key is Esc, so the hint says just that.
*/
export function formatSuggestionShortcutHint({
  isApplePlatform,
  isConfirming,
}: {
  isApplePlatform: boolean;
  isConfirming: boolean;
}): string {
  const dismissKey = formatShortcut({ combo: DISMISS_SUGGESTION_COMBO, isApplePlatform });
  if (isConfirming) {
    return `${dismissKey} to cancel`;
  }
  const applyKeys = formatShortcut({ combo: APPLY_SUGGESTION_COMBO, isApplePlatform });
  return `${applyKeys} to apply · ${dismissKey} to dismiss`;
}
