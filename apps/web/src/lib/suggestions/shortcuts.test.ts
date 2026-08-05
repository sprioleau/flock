import { describe, expect, it } from "vitest";
import {
  formatSuggestionShortcutHint,
  getDefaultRung,
  getIsSuggestionReachable,
  resolveSuggestionShortcut,
  type SuggestionShortcutKeyEvent,
} from "./shortcuts";
import type { Suggestion, SuggestionRung } from "./types";

/**
 * The keyboard path for the suggestion card. The load-bearing case is the
 * confirm-gated rung: ⌘↵ must never dispatch a whole-email re-theme, before
 * OR after the confirm opens.
 */

const sectionRung: SuggestionRung = {
  id: "section",
  label: "The other 2 buttons in this section",
  ops: [{ name: "updateBlockProperties", blockId: "b1", properties: { backgroundColor: "#ff0000" } }],
};

const emailRung: SuggestionRung = {
  id: "email",
  label: "All 4 buttons in the email",
  ops: [{ name: "updateBlockProperties", blockId: "b2", properties: { backgroundColor: "#ff0000" } }],
};

const rethemeRung: SuggestionRung = {
  id: "retheme",
  label: "Re-theme the email…",
  needsConfirm: true,
  confirmDescription: "Restyle the whole email around #ff0000.",
  ops: [],
};

function makeSuggestion(rungs: SuggestionRung[]): Suggestion {
  return {
    id: "suggestion-1",
    ruleId: "repeated-property-edit",
    source: "rule",
    patternKey: "button|backgroundColor",
    title: "Make the other buttons match?",
    description: "You set the same background color on 2 buttons. Apply it to the rest?",
    rungs,
    anchorBlockId: "b1",
    targetBlockIds: ["b1", "b2"],
  };
}

/** A bare keystroke on the canvas: nothing typed into, nothing claimed. */
function makeKeyEvent(overrides: Partial<SuggestionShortcutKeyEvent>): SuggestionShortcutKeyEvent {
  return {
    key: "a",
    code: "KeyA",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isDefaultPrevented: false,
    isTypingContext: false,
    ...overrides,
  };
}

/**
 * ⌥A as a Mac actually reports it: the PHYSICAL key is "KeyA" but the
 * composed character is "å". Matching on `key` would silently never fire.
 */
const applyOnApple = makeKeyEvent({ key: "å", code: "KeyA", altKey: true });
/** The same physical chord on Windows/Linux, where Alt composes nothing. */
const applyOnWindows = makeKeyEvent({ key: "a", code: "KeyA", altKey: true });
const escape = makeKeyEvent({ key: "Escape", code: "Escape" });

/** The full ladder, as the rules registry composes it for a button recolor. */
const fullLadder = makeSuggestion([sectionRung, emailRung, rethemeRung]);

function resolve(args: {
  event: SuggestionShortcutKeyEvent;
  suggestion?: Suggestion | null;
  confirmingRungId?: Suggestion["rungs"][number]["id"] | null;
  isCardInteractive?: boolean;
}) {
  return resolveSuggestionShortcut({
    event: args.event,
    suggestion: args.suggestion === undefined ? fullLadder : args.suggestion,
    confirmingRungId: args.confirmingRungId ?? null,
    isCardInteractive: args.isCardInteractive ?? true,
  });
}

describe("getDefaultRung", () => {
  it("picks the smallest-scope rung the ladder offers", () => {
    expect(getDefaultRung(fullLadder)?.id).toBe("section");
    expect(getDefaultRung(makeSuggestion([emailRung, rethemeRung]))?.id).toBe("email");
  });

  it("skips confirm-gated rungs entirely", () => {
    expect(getDefaultRung(makeSuggestion([rethemeRung, emailRung]))?.id).toBe("email");
  });

  it("is null when every rung is gated", () => {
    expect(getDefaultRung(makeSuggestion([rethemeRung]))).toBeNull();
  });
});

describe("resolveSuggestionShortcut — applying", () => {
  it("applies the default rung on ⌥A even though macOS composes it into 'å'", () => {
    expect(applyOnApple.key).toBe("å");
    expect(resolve({ event: applyOnApple })).toEqual({ name: "apply", rungId: "section" });
  });

  it("applies the default rung on Alt+A for non-Apple keyboards", () => {
    expect(resolve({ event: applyOnWindows })).toEqual({ name: "apply", rungId: "section" });
  });

  it("applies the email rung when the ladder has no section rung", () => {
    expect(resolve({ event: applyOnApple, suggestion: makeSuggestion([emailRung, rethemeRung]) })).toEqual(
      { name: "apply", rungId: "email" },
    );
  });

  it("ignores a bare A, so typing the letter never applies anything", () => {
    expect(resolve({ event: makeKeyEvent({ key: "a", code: "KeyA" }) })).toEqual({ name: "ignore" });
  });

  it("ignores any larger chord built on top of ⌥A", () => {
    for (const extra of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
      expect(resolve({ event: makeKeyEvent({ code: "KeyA", altKey: true, ...extra }) })).toEqual({
        name: "ignore",
      });
    }
  });

  it("ignores Alt on any other physical key, including one that composes 'å'", () => {
    expect(resolve({ event: makeKeyEvent({ key: "å", code: "KeyB", altKey: true }) })).toEqual({
      name: "ignore",
    });
    expect(resolve({ event: makeKeyEvent({ key: "Enter", code: "Enter", metaKey: true }) })).toEqual({
      name: "ignore",
    });
  });
});

describe("resolveSuggestionShortcut — the confirm gate", () => {
  it("never resolves to the confirm-gated rung, even though it is on the ladder", () => {
    const action = resolve({ event: applyOnApple });
    expect(action).not.toEqual({ name: "apply", rungId: "retheme" });
  });

  it("does nothing at all when the gated rung is the ONLY rung", () => {
    expect(resolve({ event: applyOnApple, suggestion: makeSuggestion([rethemeRung]) })).toEqual({
      name: "ignore",
    });
  });

  it("refuses to confirm an OPEN gate — the confirm keeps its explicit click", () => {
    expect(resolve({ event: applyOnApple, confirmingRungId: "retheme" })).toEqual({ name: "ignore" });
    expect(resolve({ event: applyOnWindows, confirmingRungId: "retheme" })).toEqual({ name: "ignore" });
  });

  it("backs out of an open confirm on Esc instead of dismissing the suggestion", () => {
    expect(resolve({ event: escape, confirmingRungId: "retheme" })).toEqual({ name: "cancelConfirm" });
  });
});

describe("resolveSuggestionShortcut — dismissing", () => {
  it("dismisses the live suggestion on Esc", () => {
    expect(resolve({ event: escape })).toEqual({ name: "dismiss" });
  });

  it("ignores Esc with modifiers (those belong to the OS and the browser)", () => {
    expect(resolve({ event: makeKeyEvent({ key: "Escape", metaKey: true }) })).toEqual({ name: "ignore" });
    expect(resolve({ event: makeKeyEvent({ key: "Escape", shiftKey: true }) })).toEqual({ name: "ignore" });
    expect(resolve({ event: makeKeyEvent({ key: "Escape", altKey: true }) })).toEqual({ name: "ignore" });
  });
});

describe("resolveSuggestionShortcut — staying silent", () => {
  it("ignores every shortcut when no suggestion is live", () => {
    expect(resolve({ event: applyOnApple, suggestion: null })).toEqual({ name: "ignore" });
    expect(resolve({ event: applyOnWindows, suggestion: null })).toEqual({ name: "ignore" });
    expect(resolve({ event: escape, suggestion: null })).toEqual({ name: "ignore" });
  });

  it("ignores shortcuts while the card is on screen but unreachable", () => {
    expect(resolve({ event: applyOnApple, isCardInteractive: false })).toEqual({ name: "ignore" });
    expect(resolve({ event: escape, isCardInteractive: false })).toEqual({ name: "ignore" });
  });

  it("yields Esc to the composer and every other typing context", () => {
    expect(resolve({ event: { ...escape, isTypingContext: true } })).toEqual({ name: "ignore" });
  });

  it("still applies from INSIDE a text field — the whole reason ⌥A replaced ⌘↵", () => {
    expect(resolve({ event: { ...applyOnApple, isTypingContext: true } })).toEqual({
      name: "apply",
      rungId: "section",
    });
    expect(resolve({ event: { ...applyOnWindows, isTypingContext: true } })).toEqual({
      name: "apply",
      rungId: "section",
    });
  });

  it("yields a keystroke another handler already claimed", () => {
    expect(resolve({ event: { ...applyOnApple, isDefaultPrevented: true } })).toEqual({ name: "ignore" });
    expect(resolve({ event: { ...escape, isDefaultPrevented: true } })).toEqual({ name: "ignore" });
  });
});

describe("getIsSuggestionReachable", () => {
  /**
   * The owner's second complaint: the suggestion existed, was correct, and ⌥A
   * did nothing because the chat panel happened to be collapsed. Reachability
   * is about whether the user can SEE the offer anywhere, not about one panel.
   */
  it("is reachable from the chat card while the panel is expanded", () => {
    expect(
      getIsSuggestionReachable({ isChatPanelExpanded: true, isCanvasPillVisible: false }),
    ).toBe(true);
  });

  it("is reachable from the canvas pill even with the chat panel collapsed", () => {
    expect(
      getIsSuggestionReachable({ isChatPanelExpanded: false, isCanvasPillVisible: true }),
    ).toBe(true);
  });

  it("stays reachable when both surfaces are showing it", () => {
    expect(getIsSuggestionReachable({ isChatPanelExpanded: true, isCanvasPillVisible: true })).toBe(
      true,
    );
  });

  it("is unreachable when no surface is showing it, so ⌥A claims nothing", () => {
    expect(
      getIsSuggestionReachable({ isChatPanelExpanded: false, isCanvasPillVisible: false }),
    ).toBe(false);
  });

  it("feeds resolveSuggestionShortcut's gate directly", () => {
    const isCardInteractive = getIsSuggestionReachable({
      isChatPanelExpanded: false,
      isCanvasPillVisible: true,
    });
    expect(resolve({ event: applyOnApple, isCardInteractive })).toEqual({
      name: "apply",
      rungId: "section",
    });
  });
});

describe("formatSuggestionShortcutHint", () => {
  it("uses Apple glyphs on Apple keyboards", () => {
    expect(formatSuggestionShortcutHint({ isApplePlatform: true, isConfirming: false })).toBe(
      "⌥A to apply · esc to dismiss",
    );
  });

  it("spells the keys out everywhere else", () => {
    expect(formatSuggestionShortcutHint({ isApplePlatform: false, isConfirming: false })).toBe(
      "Alt+A to apply · Esc to dismiss",
    );
  });

  it("offers only the way out while a confirm is open", () => {
    expect(formatSuggestionShortcutHint({ isApplePlatform: true, isConfirming: true })).toBe(
      "esc to cancel",
    );
    expect(formatSuggestionShortcutHint({ isApplePlatform: false, isConfirming: true })).toBe(
      "Esc to cancel",
    );
  });
});
