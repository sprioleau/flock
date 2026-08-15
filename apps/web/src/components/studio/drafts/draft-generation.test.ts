import { createEmptyDocument, createStarterDocument, type EmailDocument } from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import {
  buildIdeatePromptText,
  buildVariationPromptText,
  MAX_GENERATION_DIRECTION_INPUT_LENGTH,
  readSourceThemeGlobals,
} from "./draft-generation";

/**
 * The user-facing half of the drafts-menu AI actions. The regression these
 * pin: the message that lands in the chat thread used to be the whole model
 * brief, so the bubble rendered block ids, hex colours, font stacks and a
 * numbered instruction list. It must now read as a sentence a person wrote —
 * everything internal is assembled server-side (api/chat/generation-brief.ts).
 */

/** Anything that would betray the machine half if it leaked into the bubble. */
const INTERNAL_LANGUAGE = [
  /#[0-9a-f]{6}/i, // hex colours
  /\b(?:sec|txt|img|btn|row|col|div|lnk)_[a-z0-9]+/i, // block ids
  /globals|emailBackgroundColor|buttonBorderRadius/i, // theme property names
  /KEEP THE WORDS|CHANGE THE STRUCTURE|templateId/, // instruction vocabulary
];

function expectNoInternalLanguage(text: string): void {
  for (const pattern of INTERNAL_LANGUAGE) {
    expect(text).not.toMatch(pattern);
  }
}

describe("buildIdeatePromptText", () => {
  it("reads as one plain sentence naming the source draft", () => {
    const text = buildIdeatePromptText({ sourceDraftName: "RenderATL 2026", direction: "" });
    expect(text).toBe('Ideate a new draft on this canvas, inspired by "RenderATL 2026".');
    expectNoInternalLanguage(text);
  });

  it("keeps the person's own direction, now that ideate has a field to type it in", () => {
    // Ideate used to fire straight from the menu item with no input at all,
    // which made every run a blind reroll. The words they typed are theirs to
    // see reflected back in the thread, exactly like a variation's.
    const text = buildIdeatePromptText({
      sourceDraftName: "RenderATL 2026",
      direction: "  aim it at first-time attendees  ",
    });
    expect(text).toBe(
      'Ideate a new draft on this canvas, inspired by "RenderATL 2026". aim it at first-time attendees',
    );
    expectNoInternalLanguage(text);
  });

  it("stays a single sentence when the direction field was left blank", () => {
    expect(buildIdeatePromptText({ sourceDraftName: "Draft 1", direction: "   " })).toBe(
      'Ideate a new draft on this canvas, inspired by "Draft 1".',
    );
  });
});

describe("MAX_GENERATION_DIRECTION_INPUT_LENGTH", () => {
  it("fits inside the wire's own cap, so the UI can never build an unsendable request", () => {
    // The wire accepts 2,000 (MAX_GENERATION_DIRECTION_LENGTH, chat-contract),
    // which is why raising the field from 200 needed no schema change — but a
    // UI cap ABOVE the wire's would produce a message the server rejects, and
    // the person would only find out after the draft was created.
    expect(MAX_GENERATION_DIRECTION_INPUT_LENGTH).toBeLessThanOrEqual(2_000);
    // The owner asked for "about 500" over the old 200.
    expect(MAX_GENERATION_DIRECTION_INPUT_LENGTH).toBeGreaterThan(200);
  });
});

describe("buildVariationPromptText", () => {
  it("reads as one plain sentence naming the source draft", () => {
    const text = buildVariationPromptText({
      sourceDraftName: "RenderATL 2026",
      direction: "",
    });
    expect(text).toBe('Add a design variation of "RenderATL 2026".');
    expectNoInternalLanguage(text);
  });

  it("keeps the person's own direction, which is theirs to see reflected back", () => {
    const text = buildVariationPromptText({
      sourceDraftName: "RenderATL 2026",
      direction: "  brighter colors, more punchy tone  ",
    });
    expect(text).toBe(
      'Add a design variation of "RenderATL 2026". brighter colors, more punchy tone',
    );
  });

  it("stays a single sentence when the direction field was left blank", () => {
    expect(buildVariationPromptText({ sourceDraftName: "Draft 1", direction: "   " })).toBe(
      'Add a design variation of "Draft 1".',
    );
  });

  it("never carries the source draft's content or theme", () => {
    // The bug in one assertion: a 4,000-character brief used to travel here.
    const text = buildVariationPromptText({
      sourceDraftName: "RenderATL 2026",
      direction: "brighter colors",
    });
    expect(text.length).toBeLessThan(120);
    expectNoInternalLanguage(text);
  });
});

describe("readSourceThemeGlobals", () => {
  function createThemedDocument(): EmailDocument {
    const doc = createEmptyDocument();
    const root = doc.root;
    if (root !== undefined && root.type === "root") {
      doc.root = { ...root, properties: { globals: { emailBackgroundColor: "#1b1035" } } };
    }
    return doc;
  }

  it("carries the theme the person is looking at — inheritance is ON by default", () => {
    expect(readSourceThemeGlobals(createThemedDocument())).toEqual({
      emailBackgroundColor: "#1b1035",
    });
  });

  it("carries nothing from a draft that is still on the shared defaults", () => {
    // Both drafts render identically already; copying `{}` would only add a
    // no-op to the new draft's history.
    expect(readSourceThemeGlobals(createEmptyDocument())).toBeNull();
    expect(readSourceThemeGlobals(createStarterDocument())).toBeNull();
  });

  it("carries nothing from a malformed document", () => {
    expect(readSourceThemeGlobals({} as EmailDocument)).toBeNull();
  });
});
