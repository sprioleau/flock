import { formatShortcut } from "@/components/studio/shortcuts/shortcut-keys";
import type { Suggestion, SuggestionRung, SuggestionRungId } from "./types";

/**
 * Keyboard reach for the live suggestion card (Phase 7.3).
 *
 * The card sits directly above the composer, so a suggestion that only
 * accepts a click makes the user leave the keyboard mid-edit. ⌘↵ (Ctrl+Enter
 * off Apple keyboards) applies it; Esc dismisses it through the same
 * persistence path as the × button.
 *
 * THREE RULES THIS MODULE EXISTS TO ENFORCE:
 *
 * 1. NEVER SHORTCUT PAST A GATE. The shortcut only ever reaches the DEFAULT
 *    rung — the first rung the rules registry composed WITHOUT
 *    `needsConfirm` (see types.ts). A confirm-gated rung (the whole-email
 *    re-theme) is unreachable from the keyboard by construction: it is not
 *    "the default rung" before the confirm opens, and while the confirm IS
 *    open ⌘↵ resolves to `ignore` so the gate keeps its explicit click. The
 *    ladder is ordered smallest-scope first, so the default is also the
 *    least surprising thing to apply blind.
 *
 * 2. YIELD TO TYPING. The chat composer submits on Enter WITHOUT excluding
 *    modifiers (ChatPanel.tsx `handleComposerKeyDown`), so ⌘↵ already sends
 *    a chat message there; the queued-message editor does the same, and the
 *    inline text editor closes on a bare Esc. Rather than guess at how to
 *    split those keys, this shortcut declines the keystroke entirely
 *    whenever it lands in a typing context — the caller passes
 *    `isTypingContext` (keyboard-guards.ts). Existing behavior is untouched.
 *
 * 3. STAY SILENT WHEN THERE IS NOTHING TO ACT ON. No live suggestion, or a
 *    card the user cannot currently see (collapsed chat panel), resolves to
 *    `ignore`. The card's own mount lifetime already covers the collapsed
 *    tray and the post-apply "Applied — Revert" state.
 *
 * Split into a pure resolver + a caller-owned listener so the whole decision
 * table is unit-testable in the node test environment (no DOM required).
 */

/** react-hotkeys-hook combo notation — `mod` is ⌘ on Apple, Ctrl elsewhere. */
export const APPLY_SUGGESTION_COMBO = "mod+enter";

/** Dismiss the live suggestion (or back out of an open confirm). */
export const DISMISS_SUGGESTION_COMBO = "escape";

/**
 * The rung ⌘↵ applies: the first NON-gated rung on the ladder (smallest
 * scope first). Null when every rung is confirm-gated — the keyboard path
 * then does nothing at all rather than promoting a gated rung.
 */
export function getDefaultRung(suggestion: Suggestion): SuggestionRung | null {
  return suggestion.rungs.find((rung) => rung.needsConfirm !== true) ?? null;
}

/** The parts of a keydown this decision depends on (a real KeyboardEvent fits). */
export interface SuggestionShortcutKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** Another handler already claimed this keystroke; leave it alone. */
  isDefaultPrevented: boolean;
  /** The keystroke landed in a field, the composer, or a contenteditable. */
  isTypingContext: boolean;
}

/** What the card should do about a keystroke. */
export type SuggestionShortcutAction =
  | { name: "ignore" }
  | { name: "apply"; rungId: SuggestionRungId }
  | { name: "dismiss" }
  | { name: "cancelConfirm" };

const IGNORE: SuggestionShortcutAction = { name: "ignore" };

/**
 * The whole decision table. Returns `ignore` for every keystroke the card
 * must not claim, so the caller can pass the event straight through.
 */
export function resolveSuggestionShortcut({
  event,
  suggestion,
  confirmingRungId,
  isCardInteractive,
}: {
  event: SuggestionShortcutKeyEvent;
  /** The live suggestion, or null when nothing is suggested right now. */
  suggestion: Suggestion | null;
  /** The rung whose inline confirm is currently open, or null. */
  confirmingRungId: SuggestionRungId | null;
  /** False while the card is on screen but unreachable (panel collapsed). */
  isCardInteractive: boolean;
}): SuggestionShortcutAction {
  if (suggestion === null || !isCardInteractive) {
    return IGNORE;
  }
  if (event.isDefaultPrevented || event.isTypingContext) {
    return IGNORE;
  }

  if (event.key === "Escape") {
    // A bare Esc only. ⌥Esc / ⇧Esc belong to the OS and the browser.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return IGNORE;
    }
    // Esc backs out of the innermost thing first: an open confirm, then the
    // suggestion itself.
    return confirmingRungId === null ? { name: "dismiss" } : { name: "cancelConfirm" };
  }

  const isApplyChord =
    event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
  if (!isApplyChord) {
    return IGNORE;
  }
  // Rule 1: an open confirm is a gate, and gates take an explicit click.
  if (confirmingRungId !== null) {
    return IGNORE;
  }
  const defaultRung = getDefaultRung(suggestion);
  return defaultRung === null ? IGNORE : { name: "apply", rungId: defaultRung.id };
}

/**
 * The card's discoverability hint, in the reader's own keyboard notation:
 * "⌘↵ to apply · esc to dismiss" on Apple keyboards, "Ctrl+Enter to apply ·
 * Esc to dismiss" elsewhere. While a confirm is open the only live key is
 * Esc, so the hint says just that.
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
