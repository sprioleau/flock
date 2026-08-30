import {
  createEmptyDocument,
  createStarterDocument,
  type EmailDocument,
  type GlobalStyles,
} from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import { MOCK_BRAND_KIT, type BrandKit } from "@/lib/brand-kit";
import {
  buildIdeatePromptText,
  buildVariationPromptText,
  MAX_GENERATION_DIRECTION_INPUT_LENGTH,
  pickVariationTheme,
  readSourceThemeGlobals,
} from "./draft-generation";

/*
  The user-facing half of the drafts-menu AI actions. The regression these
  pin: the message that lands in the chat thread used to be the whole model
  brief, so the bubble rendered block ids, hex colours, font stacks and a
  numbered instruction list. It must now read as a sentence a person wrote —
  everything internal is assembled server-side (api/chat/generation-brief.ts).
*/

/*
  Anything that would betray the machine half if it leaked into the bubble.
*/
const INTERNAL_LANGUAGE = [
  /#[0-9a-f]{6}/i, /* hex colours */
  /\b(?:sec|txt|img|btn|row|col|div|lnk)_[a-z0-9]+/i, /* block ids */
  /globals|emailBackgroundColor|buttonBorderRadius/i, /* theme property names */
  /KEEP THE WORDS|CHANGE THE STRUCTURE|templateId/, /* instruction vocabulary */
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
    /*
      Ideate used to fire straight from the menu item with no input at all,
      which made every run a blind reroll. The words they typed are theirs to
      see reflected back in the thread, exactly like a variation's.
    */
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
    /*
      The wire accepts 2,000 (MAX_GENERATION_DIRECTION_LENGTH, chat-contract),
      which is why raising the field from 200 needed no schema change — but a
      UI cap ABOVE the wire's would produce a message the server rejects, and
      the person would only find out after the draft was created.
    */
    expect(MAX_GENERATION_DIRECTION_INPUT_LENGTH).toBeLessThanOrEqual(2_000);
    /*
      The owner asked for "about 500" over the old 200.
    */
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
    /*
      The bug in one assertion: a 4,000-character brief used to travel here.
    */
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
    /*
      Both drafts render identically already; copying `{}` would only add a
      no-op to the new draft's history.
    */
    expect(readSourceThemeGlobals(createEmptyDocument())).toBeNull();
    expect(readSourceThemeGlobals(createStarterDocument())).toBeNull();
  });

  it("carries nothing from a malformed document", () => {
    expect(readSourceThemeGlobals({} as EmailDocument)).toBeNull();
  });
});

describe("pickVariationTheme", () => {
  /*
    A kit holding exactly the named MOCK themes, in that order.
  */
  function createKit(ids: string[]): BrandKit {
    return {
      ...MOCK_BRAND_KIT,
      variations: ids.map((id) => {
        const variation = MOCK_BRAND_KIT.variations.find((entry) => entry.id === id);
        if (variation === undefined) {
          throw new Error(`No mock theme "${id}"`);
        }
        return variation;
      }),
    };
  }

  /*
    The globals of a mock theme, as a source draft would be wearing them.
  */
  function globalsOf(id: string): GlobalStyles {
    const variation = MOCK_BRAND_KIT.variations.find((entry) => entry.id === id);
    if (variation === undefined) {
      throw new Error(`No mock theme "${id}"`);
    }
    return variation.globals;
  }

  /*
    Every theme this picker lands on as the random value sweeps its range.
  */
  function sweepPickedIds({
    brandKit,
    sourceGlobals,
  }: {
    brandKit: BrandKit;
    sourceGlobals: GlobalStyles | null;
  }): string[] {
    const picked: string[] = [];
    for (const randomValue of [0, 0.2, 0.4, 0.5, 0.6, 0.8, 0.999]) {
      const choice = pickVariationTheme({ brandKit, sourceGlobals, randomValue });
      if (choice.isVaried) {
        picked.push(choice.variation.id);
      }
    }
    return picked;
  }

  it("NEVER offers the theme the source draft is already wearing", () => {
    /*
      The whole point of the change, and the assertion that fails vacuously if
      written any other way: the source's own theme is IN the kit, so a picker
      that merely returns "some theme from the kit" would still hand back the
      one the person is looking at. Sweeping the whole random range is what
      turns "it happened to differ once" into "it cannot be offered".
    */
    const picked = sweepPickedIds({
      brandKit: createKit(["classic-light", "warm-sand", "midnight"]),
      sourceGlobals: globalsOf("warm-sand"),
    });
    expect(picked).toHaveLength(7);
    expect(picked).not.toContain("warm-sand");
  });

  it("can reach every alternative, so a variation is not always the same theme", () => {
    /*
      A picker that ignored `randomValue` would pass the test above and fail
      here — one theme forever is a design variation in name only.
    */
    const picked = sweepPickedIds({
      brandKit: createKit(["classic-light", "warm-sand", "midnight"]),
      sourceGlobals: globalsOf("warm-sand"),
    });
    expect(new Set(picked)).toEqual(new Set(["classic-light", "midnight"]));
  });

  it("is deterministic in the random value it is handed", () => {
    const brandKit = createKit(["classic-light", "warm-sand", "midnight"]);
    const sourceGlobals = globalsOf("warm-sand");
    const first = pickVariationTheme({ brandKit, sourceGlobals, randomValue: 0.9 });
    const second = pickVariationTheme({ brandKit, sourceGlobals, randomValue: 0.9 });
    expect(first).toEqual(second);
    expect(first.isVaried && first.variation.id).toBe("midnight");
  });

  it("varies away from the shared defaults when the source has no theme of its own", () => {
    const picked = sweepPickedIds({
      brandKit: createKit(["classic-light", "midnight"]),
      sourceGlobals: null,
    });
    expect(new Set(picked)).toEqual(new Set(["classic-light", "midnight"]));
  });

  it("never offers a soft-deleted theme, so a variation cannot be born stranded", () => {
    /*
      A draft wearing a deleted theme has no parent (`findMatchingVariation`
      is live-only), which is exactly the detached state this feature must not
      manufacture. `getLiveThemeVariations` is the one filter that decides it.
    */
    const brandKit = createKit(["classic-light", "warm-sand", "midnight"]);
    const deletedKit: BrandKit = {
      ...brandKit,
      variations: brandKit.variations.map((variation) =>
        variation.id === "midnight" ? { ...variation, deletedAtMs: 1_700_000_000_000 } : variation,
      ),
    };
    const picked = sweepPickedIds({
      brandKit: deletedKit,
      sourceGlobals: globalsOf("warm-sand"),
    });
    expect(new Set(picked)).toEqual(new Set(["classic-light"]));
  });

  it("says so when the kit holds nothing to vary to, rather than lying with the same theme", () => {
    /*
      One-theme kits are real, and a "design variation" that silently reuses the
      theme is the defect this feature exists to fix — the caller shows a notice
      instead of pretending.
    */
    expect(
      pickVariationTheme({
        brandKit: createKit(["warm-sand"]),
        sourceGlobals: globalsOf("warm-sand"),
        randomValue: 0.5,
      }),
    ).toEqual({ isVaried: false, reason: "no-alternative-theme" });
  });

  it("clamps a random value at the very top of its range onto a real theme", () => {
    /*
      Math.random() is [0, 1), but a 1 arriving from anywhere must not index
      past the end and turn a two-theme kit into "nothing to vary to".
    */
    const choice = pickVariationTheme({
      brandKit: createKit(["classic-light", "midnight"]),
      sourceGlobals: globalsOf("classic-light"),
      randomValue: 1,
    });
    expect(choice.isVaried && choice.variation.id).toBe("midnight");
  });
});
