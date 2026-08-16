import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_STYLES, type GlobalStyles } from "@flock/email-sdk";
import { MOCK_BRAND_KIT, type ThemeVariation } from "./brand-kit";
import {
  composeThemeGlobals,
  describeThemeOverrides,
  getOverriddenGlobalKeys,
  getThemeOverrideIndicator,
  resolveDraftThemeLink,
  type DraftBrandPointer,
} from "./brand-theme-link";

/**
 * Theme identity and per-property overrides (§14.5a). Everything here is a
 * property somebody's draft depends on:
 *
 * - the MIGRATION table: every shape a `documents.brand` row can have today
 *   resolves to the same *rendered* draft and the same *pill behaviour* it did
 *   before this landed. A migration that restyles is the failure mode;
 * - a theme EDIT propagates to referencing drafts;
 * - an overridden property SURVIVES that propagation;
 * - the indicator appears only for parent + at least one override.
 */

const CLASSIC: ThemeVariation = MOCK_BRAND_KIT.variations[0]!;
const MIDNIGHT: ThemeVariation = MOCK_BRAND_KIT.variations[1]!;
const KIT_ID = "kit_1";
const OTHER_KIT_ID = "kit_2";
const VARIATIONS = [CLASSIC, MIDNIGHT];

function pointer(overrides: Partial<DraftBrandPointer> = {}): DraftBrandPointer {
  return { kitId: KIT_ID, revision: 1, variationId: CLASSIC.id, ...overrides };
}

function resolve({
  globals,
  brand,
  revision = 1,
  variations = VARIATIONS,
}: {
  globals: GlobalStyles | undefined;
  brand?: DraftBrandPointer;
  revision?: number;
  variations?: ThemeVariation[];
}) {
  return resolveDraftThemeLink({
    variations,
    kitId: KIT_ID,
    revision,
    globals,
    pointer: brand,
  });
}

describe("getOverriddenGlobalKeys — the per-property diff", () => {
  it("names exactly the properties that differ, sorted", () => {
    const keys = getOverriddenGlobalKeys({
      globals: { ...CLASSIC.globals, buttonBackgroundColor: "#ff0000", paragraphTextColor: "#0000ff" },
      baseline: CLASSIC.globals,
    });
    expect(keys).toEqual(["buttonBackgroundColor", "paragraphTextColor"]);
  });

  it("compares RESOLVED values, so an absent key equal to the renderer default is not an override", () => {
    /*
      Every globals field is optional and falls back to DEFAULT_GLOBAL_STYLES.
      A raw-key diff would call these two payloads different and light the
      indicator for a draft nobody touched.
    */
    const { dividerColor, ...withoutDivider } = CLASSIC.globals;
    expect(dividerColor).not.toBe(DEFAULT_GLOBAL_STYLES.dividerColor);
    expect(
      getOverriddenGlobalKeys({
        globals: { ...withoutDivider, dividerColor: DEFAULT_GLOBAL_STYLES.dividerColor },
        baseline: { ...withoutDivider },
      }),
    ).toEqual([]);
  });
});

describe("resolveDraftThemeLink — migration: every existing row shape keeps its behaviour", () => {
  it("pointer for the bound kit + matching payload stays `current` with no overrides", () => {
    const link = resolve({ globals: CLASSIC.globals, brand: pointer() });
    expect(link).toMatchObject({
      state: "current",
      parentVariationId: CLASSIC.id,
      overriddenGlobalKeys: [],
    });
  });

  it("pointer for the bound kit + diverged payload becomes `overridden` (was `detached`), naming the properties", () => {
    const link = resolve({
      globals: { ...CLASSIC.globals, buttonBackgroundColor: "#ff0000" },
      brand: pointer(),
    });
    expect(link.state).toBe("overridden");
    expect(link.parentVariationId).toBe(CLASSIC.id);
    expect(link.overriddenGlobalKeys).toEqual(["buttonBackgroundColor"]);
  });

  it("a LEGACY row at an older revision stays `outdated` AND reports no overrides", () => {
    /*
      The regression this guards, and it is the sharpest one in the migration.
      A legacy row has no baseline, so the fallback is the variation's CURRENT
      globals. If the kit moved (updateBrandFonts rewrites every variation and
      bumps), diffing against the moved payload would report the KIT's own font
      change as the user's override. The draft would lose its pill, and — far
      worse — propagation would faithfully "preserve" the stale fonts, so the
      update the person confirmed would silently not land.

      An untrustworthy baseline therefore yields zero overrides, which is
      exactly the pre-§14.5a behaviour: propagation writes the theme verbatim.
    */
    const movedClassic: ThemeVariation = {
      ...CLASSIC,
      globals: { ...CLASSIC.globals, paragraphFontFamily: "Georgia, serif" },
    };
    const link = resolve({
      globals: CLASSIC.globals,
      brand: pointer({ revision: 1 }),
      revision: 2,
      variations: [movedClassic, MIDNIGHT],
    });
    expect(link.state).toBe("outdated");
    expect(link.overriddenGlobalKeys).toEqual([]);
    expect(
      composeThemeGlobals({
        themeGlobals: movedClassic.globals,
        draftGlobals: CLASSIC.globals,
        overriddenGlobalKeys: link.overriddenGlobalKeys,
      }),
    ).toEqual(movedClassic.globals);
  });

  it("a pointer naming a variation the kit no longer carries stays silent, as `detached` did", () => {
    /* Only theme DELETION can produce this, and deletion is unbuilt (§14.5a). */
    const link = resolve({
      globals: { ...CLASSIC.globals, buttonBackgroundColor: "#ff0000" },
      brand: pointer({ variationId: "a-theme-that-is-gone" }),
    });
    expect(link).toMatchObject({
      state: "overridden",
      parentVariationId: null,
      overriddenGlobalKeys: [],
    });
    /* Null parent ⇒ no dot, no note — the same silence the old state gave it. */
    expect(
      getThemeOverrideIndicator({
        parentVariationId: link.parentVariationId,
        overriddenGlobalKeys: link.overriddenGlobalKeys,
        hasSectionThemeOverrides: false,
      }).isVisible,
    ).toBe(false);
  });

  it("pointer for a DIFFERENT kit stays `outdated` with no parent in the bound kit", () => {
    const link = resolve({
      globals: { ...CLASSIC.globals, buttonBackgroundColor: "#ff0000" },
      brand: pointer({ kitId: OTHER_KIT_ID }),
    });
    expect(link).toMatchObject({ state: "outdated", parentVariationId: null });
  });

  it("no pointer + matching payload resolves `current` by equality alone (no backfill needed)", () => {
    const link = resolve({ globals: MIDNIGHT.globals });
    expect(link).toMatchObject({ state: "current", parentVariationId: MIDNIGHT.id });
  });

  it("no pointer + no match stays `never-applied` — the genuinely parentless state survives the rename", () => {
    const link = resolve({ globals: { ...CLASSIC.globals, contentWidth: 480 } });
    expect(link).toMatchObject({ state: "never-applied", parentVariationId: null });
  });

  it("equality still beats the pointer, so an UNDONE theme switch reads as the theme on screen", () => {
    /*
      Undo reverts globals without touching the pointer. Pointer-first identity
      would call this "Midnight with twenty-six overrides"; the shipped rule
      calls it "Classic, clean", which is what the person is looking at. This
      is the whole reason equality keeps first say.
    */
    const link = resolve({
      globals: CLASSIC.globals,
      brand: pointer({ variationId: MIDNIGHT.id, baselineGlobals: MIDNIGHT.globals }),
    });
    expect(link).toMatchObject({
      state: "current",
      parentVariationId: CLASSIC.id,
      overriddenGlobalKeys: [],
    });
  });
});

describe("resolveDraftThemeLink — a theme edit, measured against the stored baseline", () => {
  const EDITED_CLASSIC: ThemeVariation = {
    ...CLASSIC,
    globals: { ...CLASSIC.globals, paragraphTextColor: "#123456" },
  };

  it("separates the user's override from the parent's edit instead of merging them", () => {
    /*
      Without the baseline, diffing against the EDITED variation would report
      two overrides — the user's button color AND the theme's own new paragraph
      color — and propagation would then "preserve" the stale paragraph color,
      i.e. the edit would never land. The baseline is what makes the edit real.
    */
    const draftGlobals = { ...CLASSIC.globals, buttonBackgroundColor: "#ff0000" };
    const link = resolveDraftThemeLink({
      variations: [EDITED_CLASSIC, MIDNIGHT],
      kitId: KIT_ID,
      revision: 2,
      globals: draftGlobals,
      pointer: pointer({ revision: 2, baselineGlobals: CLASSIC.globals }),
    });
    expect(link.overriddenGlobalKeys).toEqual(["buttonBackgroundColor"]);
    expect(link.state).toBe("outdated");
  });

  it("composing the edited theme with those overrides adopts the edit AND keeps the override", () => {
    const draftGlobals = { ...CLASSIC.globals, buttonBackgroundColor: "#ff0000" };
    const composed = composeThemeGlobals({
      themeGlobals: EDITED_CLASSIC.globals,
      draftGlobals,
      overriddenGlobalKeys: ["buttonBackgroundColor"],
    });
    expect(composed.paragraphTextColor).toBe("#123456");
    expect(composed.buttonBackgroundColor).toBe("#ff0000");
  });

  it("with ZERO overrides the composition is the theme verbatim — the no-wrong-restyle property", () => {
    const composed = composeThemeGlobals({
      themeGlobals: MIDNIGHT.globals,
      draftGlobals: CLASSIC.globals,
      overriddenGlobalKeys: [],
    });
    expect(composed).toEqual(MIDNIGHT.globals);
  });
});

describe("getThemeOverrideIndicator — when the dot appears", () => {
  it("stays hidden without a parent theme, however different the draft looks", () => {
    expect(
      getThemeOverrideIndicator({
        parentVariationId: null,
        overriddenGlobalKeys: ["buttonBackgroundColor"],
        hasSectionThemeOverrides: true,
      }),
    ).toEqual({ isVisible: false, overrideCount: 0 });
  });

  it("stays hidden for a parent with no overrides", () => {
    expect(
      getThemeOverrideIndicator({
        parentVariationId: CLASSIC.id,
        overriddenGlobalKeys: [],
        hasSectionThemeOverrides: false,
      }),
    ).toEqual({ isVisible: false, overrideCount: 0 });
  });

  it("appears for a parent plus at least one overridden global", () => {
    expect(
      getThemeOverrideIndicator({
        parentVariationId: CLASSIC.id,
        overriddenGlobalKeys: ["buttonBackgroundColor"],
        hasSectionThemeOverrides: false,
      }),
    ).toEqual({ isVisible: true, overrideCount: 1 });
  });

  it("appears for a SECTION background override alone — the block layer counts too", () => {
    /*
      innerBackgroundColor / outerBackgroundColor are block properties, so the
      server query never sees them; the toolbar composes them in locally. A
      section painted a custom color is exactly the owner's "section
      background" example and must light the dot.
    */
    expect(
      getThemeOverrideIndicator({
        parentVariationId: CLASSIC.id,
        overriddenGlobalKeys: [],
        hasSectionThemeOverrides: true,
      }),
    ).toEqual({ isVisible: true, overrideCount: 1 });
  });

  it("describes one change and many in the user's words, and names the reset", () => {
    expect(describeThemeOverrides({ themeName: "Midnight", overrideCount: 1 })).toContain(
      "1 local change",
    );
    const many = describeThemeOverrides({ themeName: "Midnight", overrideCount: 3 });
    expect(many).toContain("3 local changes");
    expect(many).toContain("Pick the theme again to reset");
  });
});
