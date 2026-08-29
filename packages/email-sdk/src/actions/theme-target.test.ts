import { describe, expect, it } from "vitest";
import type { GlobalStyles } from "../schema/globals";
import {
  applyThemeToDraftInputSchema,
  matchNamedCandidate,
  normalizeReferenceKey,
  resolveDraftTarget,
  resolveThemeReference,
  themeReferenceSchema,
  type NamedTheme,
} from "./theme-target";

/**
 * The reference vocabulary: a NAME on the wire, real globals on the other
 * side, and a refusal that says what would have worked.
 *
 * The two failures these tests exist to make impossible are the two the owner
 * named: a theme that does not actually change, and a theme that lands on the
 * WRONG draft. Both are the shape that passes for free if you assert only
 * "something resolved", so every case here pins the payload or the target,
 * never the fact of a result.
 */

const PAGE_GLOBALS: GlobalStyles = {
  emailBackgroundColor: "#ffffff",
  buttonBackgroundColor: "#ffc600",
};
const MIDNIGHT_GLOBALS: GlobalStyles = {
  emailBackgroundColor: "#101014",
  paragraphTextColor: "#f5f5f5",
};
const SAND_GLOBALS: GlobalStyles = {
  emailBackgroundColor: "#f5efe6",
  paragraphTextColor: "#2b2118",
};

const KIT_THEMES: NamedTheme[] = [
  { id: "midnight", name: "Midnight", globals: MIDNIGHT_GLOBALS },
  { id: "warm-sand", name: "Warm Sand", globals: SAND_GLOBALS },
];

const PAGE_THEME = {
  globals: PAGE_GLOBALS,
  source: "accent #ffc600 (--ui-accent-1)",
  url: "https://wesbos.com/about",
};

describe("normalizeReferenceKey", () => {
  it("collapses case, spacing and separators so one theme has one key", () => {
    const keys = ["Warm Sand", "warm-sand", "warm_sand", "WarmSand", " warm  sand "].map(
      normalizeReferenceKey,
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("warmsand");
  });

  it("keeps genuinely different names apart", () => {
    expect(normalizeReferenceKey("Midnight")).not.toBe(normalizeReferenceKey("Midnight Blue"));
  });
});

describe("matchNamedCandidate", () => {
  it("picks the one candidate that answers to the name", () => {
    const match = matchNamedCandidate({
      query: "warm sand",
      candidates: KIT_THEMES,
      getNames: (theme) => [theme.id, theme.name],
    });
    expect(match.isMatched && match.candidate.id).toBe("warm-sand");
  });

  /*
    The wrong-target failure in its smallest form. Two drafts called "Launch"
    and a resolver that takes the first restyles a real document the user did
    not mean, and the only evidence is a sentence naming the other one.
  */
  it("REFUSES rather than picking a side when two candidates share a name", () => {
    const match = matchNamedCandidate({
      query: "Launch",
      candidates: [
        { id: "a", name: "Launch" },
        { id: "b", name: "Launch" },
      ],
      getNames: (draft) => [draft.name],
    });
    expect(match).toEqual({ isMatched: false, reason: "ambiguous" });
  });

  it("reports an unknown name as unknown, not as a match on the first entry", () => {
    const match = matchNamedCandidate({
      query: "Neon",
      candidates: KIT_THEMES,
      getNames: (theme) => [theme.id, theme.name],
    });
    expect(match).toEqual({ isMatched: false, reason: "unknown" });
  });

  it("matches nothing when the query has no alphanumerics to match on", () => {
    expect(
      matchNamedCandidate({
        query: "  --  ",
        candidates: KIT_THEMES,
        getNames: (theme) => [theme.id, theme.name],
      }),
    ).toEqual({ isMatched: false, reason: "unknown" });
  });
});

describe("resolveThemeReference", () => {
  it('resolves "page" to the page\'s OWN globals, byte for byte', () => {
    const resolution = resolveThemeReference({
      reference: "page",
      pageTheme: PAGE_THEME,
      kitThemes: KIT_THEMES,
      currentGlobals: MIDNIGHT_GLOBALS,
    });
    expect(resolution).toEqual({
      isResolved: true,
      source: "page",
      name: "https://wesbos.com/about",
      globals: PAGE_GLOBALS,
      derivedFrom: "accent #ffc600 (--ui-accent-1)",
    });
  });

  /*
    The whole point of a reference: the resolved globals are the PAGE's, not
    the draft's. Asserting only `isResolved` would pass with either.
  */
  it('does not silently answer "page" with the current theme', () => {
    const resolution = resolveThemeReference({
      reference: "page",
      pageTheme: PAGE_THEME,
      kitThemes: KIT_THEMES,
      currentGlobals: MIDNIGHT_GLOBALS,
    });
    expect(resolution.isResolved && resolution.globals).not.toEqual(MIDNIGHT_GLOBALS);
  });

  it('refuses "page" when this turn read no page, and lists the themes that exist', () => {
    expect(
      resolveThemeReference({
        reference: "page",
        pageTheme: null,
        kitThemes: KIT_THEMES,
        currentGlobals: null,
      }),
    ).toEqual({
      isResolved: false,
      reason: "no-page-theme",
      availableThemeNames: ["Midnight", "Warm Sand"],
    });
  });

  it("resolves a kit theme by display name, by id, and by loose spelling", () => {
    for (const reference of ["Warm Sand", "warm-sand", "warmsand"]) {
      const resolution = resolveThemeReference({
        reference,
        pageTheme: null,
        kitThemes: KIT_THEMES,
        currentGlobals: null,
      });
      expect(resolution.isResolved && resolution.globals).toEqual(SAND_GLOBALS);
      expect(resolution.isResolved && resolution.variationId).toBe("warm-sand");
    }
  });

  /*
    The list the caller passes IS the offer. A soft-deleted variation kept out
    of `kitThemes` is not "refused" by a check that could be forgotten — it is
    not a candidate, so a draft can never be born wearing a theme its kit no
    longer has.
  */
  it("cannot resolve a theme the caller left out of the list", () => {
    expect(
      resolveThemeReference({
        reference: "Midnight",
        pageTheme: null,
        kitThemes: [KIT_THEMES[1]!],
        currentGlobals: null,
      }),
    ).toEqual({
      isResolved: false,
      reason: "unknown-theme",
      availableThemeNames: ["Warm Sand"],
    });
  });

  it('resolves "current" to the draft\'s own globals', () => {
    const resolution = resolveThemeReference({
      reference: "current",
      pageTheme: PAGE_THEME,
      kitThemes: KIT_THEMES,
      currentGlobals: MIDNIGHT_GLOBALS,
    });
    expect(resolution.isResolved && resolution.source).toBe("current");
    expect(resolution.isResolved && resolution.globals).toEqual(MIDNIGHT_GLOBALS);
  });

  it('refuses "current" on a draft that carries no theme of its own', () => {
    for (const currentGlobals of [null, {}]) {
      expect(
        resolveThemeReference({
          reference: "current",
          pageTheme: null,
          kitThemes: KIT_THEMES,
          currentGlobals,
        }).isResolved,
      ).toBe(false);
    }
  });

  it("refuses an ambiguous kit name rather than picking one", () => {
    expect(
      resolveThemeReference({
        reference: "Midnight",
        pageTheme: null,
        kitThemes: [
          { id: "midnight", name: "Midnight", globals: MIDNIGHT_GLOBALS },
          { id: "midnight-2", name: "Mid Night", globals: SAND_GLOBALS },
        ],
        currentGlobals: null,
      }).isResolved,
    ).toBe(false);
  });

  /*
    THE HOUSE RULE, as a test. A reference that looks like a colour is a
    reference, not a colour: it resolves to nothing, and nothing is applied.
    The alternative — a resolver that recognised "#ffc600" and obliged — is
    exactly the transcription surface this module exists to remove.
  */
  it("treats a hex value as an unknown theme name, never as a colour", () => {
    const resolution = resolveThemeReference({
      reference: "#ffc600",
      pageTheme: PAGE_THEME,
      kitThemes: KIT_THEMES,
      currentGlobals: MIDNIGHT_GLOBALS,
    });
    expect(resolution.isResolved).toBe(false);
  });
});

describe("resolveDraftTarget", () => {
  const DRAFTS = [
    { documentId: "doc_1", name: "Spring sale" },
    { documentId: "doc_2", name: "Launch v2" },
  ];

  it("resolves a named draft to THAT draft's id", () => {
    expect(resolveDraftTarget({ target: "Launch v2", drafts: DRAFTS, currentDocumentId: "doc_1" }))
      .toEqual({ isResolved: true, documentId: "doc_2", name: "Launch v2" });
  });

  it("resolves an omitted target to the draft the user is on", () => {
    expect(resolveDraftTarget({ target: undefined, drafts: DRAFTS, currentDocumentId: "doc_1" }))
      .toEqual({ isResolved: true, documentId: "doc_1", name: "Spring sale" });
  });

  it('resolves "current" the same way as omitting it', () => {
    expect(resolveDraftTarget({ target: "current", drafts: DRAFTS, currentDocumentId: "doc_2" }))
      .toEqual({ isResolved: true, documentId: "doc_2", name: "Launch v2" });
  });

  /*
    THE AUTHORIZATION PROPERTY, stated as behaviour rather than as a check.
    `drafts` is the user's own canvas listing, so a draft on another canvas is
    not rejected — it was never a candidate, and there is no code path that
    could be edited to let it become one.
  */
  it("cannot reach a draft that is not on the canvas it was given", () => {
    expect(
      resolveDraftTarget({
        target: "Someone else's draft",
        drafts: DRAFTS,
        currentDocumentId: "doc_1",
      }),
    ).toEqual({
      isResolved: false,
      reason: "unknown-draft",
      availableDraftNames: ["Spring sale", "Launch v2"],
    });
  });

  it("refuses when two drafts on the canvas share the named name", () => {
    expect(
      resolveDraftTarget({
        target: "Launch",
        drafts: [
          { documentId: "doc_1", name: "Launch" },
          { documentId: "doc_2", name: "Launch" },
        ],
        currentDocumentId: "doc_1",
      }).isResolved,
    ).toBe(false);
  });

  it("says so when there is no current draft to fall back to", () => {
    expect(
      resolveDraftTarget({ target: undefined, drafts: DRAFTS, currentDocumentId: null }),
    ).toEqual({
      isResolved: false,
      reason: "no-current-draft",
      availableDraftNames: ["Spring sale", "Launch v2"],
    });
  });
});

describe("the model-facing schemas", () => {
  /*
    A `pattern` on this schema would be the obvious way to police the grammar
    and it takes the whole toolset down on several OpenRouter free-tier models.
    The constraint is measured, so it is pinned here rather than rediscovered.
  */
  it("keeps the reference a plain bounded string — no regex reaches the wire", () => {
    const jsonSchema = themeReferenceSchema.toJSONSchema();
    /* Pinned so the "no pattern" assertion below can never pass vacuously. */
    expect(jsonSchema.type).toBe("string");
    expect(jsonSchema.maxLength).toBe(60);
    expect(Object.keys(jsonSchema)).not.toContain("pattern");
    expect(themeReferenceSchema.safeParse("Midnight").success).toBe(true);
    expect(themeReferenceSchema.safeParse("").success).toBe(false);
    expect(themeReferenceSchema.safeParse("x".repeat(61)).success).toBe(false);
  });

  /*
    The action takes a NAME. Nothing about its input can carry a styles object,
    so "apply these colours" is not an under-used capability — it is not
    expressible.
  */
  it("rejects a globals payload smuggled in beside the reference", () => {
    expect(
      applyThemeToDraftInputSchema.safeParse({
        theme: "page",
        globals: { emailBackgroundColor: "#ffc600" },
      }).success,
    ).toBe(false);
    expect(applyThemeToDraftInputSchema.safeParse({ theme: "page" }).success).toBe(true);
    expect(
      applyThemeToDraftInputSchema.safeParse({ theme: "page", draft: "Launch v2" }).success,
    ).toBe(true);
  });
});
