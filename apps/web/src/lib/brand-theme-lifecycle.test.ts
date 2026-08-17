import { describe, expect, it } from "vitest";
import {
  getLiveThemeVariations,
  MAX_BRAND_KIT_VARIATIONS,
  MOCK_BRAND_KIT,
  type ThemeVariation,
} from "./brand-kit";
import { planThemeVariationDeletion } from "./brand-theme-lifecycle";

/**
 * Soft theme deletion (§14.5b), at the layer that decides it.
 *
 * The end-to-end proof that no draft is restyled lives in
 * `components/studio/brand-kit/brand-theme-deletion.test.ts`, against the real
 * Convex functions. What only this suite can prove is the arithmetic the
 * mutation delegates: what may be deleted, what may be restored, and that a
 * deleted row keeps everything a restore needs.
 */

function buildVariations(count: number): ThemeVariation[] {
  return Array.from({ length: count }, (_unused, index) => {
    const source = MOCK_BRAND_KIT.variations[index % MOCK_BRAND_KIT.variations.length]!;
    return { ...source, id: `theme-${index}`, name: `Theme ${index}` };
  });
}

describe("planThemeVariationDeletion", () => {
  it("marks the variation instead of removing it, so the id survives to re-link drafts", () => {
    /*
      THE point of soft deletion. Ids are slugged from the name, so a hard
      splice followed by re-creating "Midnight" yields `midnight-2` and every
      `documents.brand.variationId` naming `midnight` is stranded forever. The
      row surviving is what makes a restore a re-link rather than a new theme.
    */
    const variations = buildVariations(2);
    const plan = planThemeVariationDeletion({
      variations,
      variationId: "theme-0",
      isDeleted: true,
      nowMs: 1_700_000_000_000,
    });
    if (!plan.isOk) {
      throw new Error(plan.message);
    }
    expect(plan.variations).toHaveLength(2);
    const deleted = plan.variations.find((variation) => variation.id === "theme-0");
    expect(deleted?.deletedAtMs).toBe(1_700_000_000_000);
    /* Its payload is untouched — a restore has to bring back the same theme. */
    expect(deleted?.globals).toEqual(variations[0]!.globals);
    /* And it is no longer a theme the kit has. */
    expect(getLiveThemeVariations(plan.variations).map((variation) => variation.id)).toEqual([
      "theme-1",
    ]);
  });

  it("refuses to delete the kit's only remaining theme", () => {
    /*
      A kit with no live themes has no dropdown, no propagation target, and
      nothing for `pickTargetVariation`'s final fallback to return — the
      contract requires at least one, and the refusal belongs where a person
      can read it.
    */
    const plan = planThemeVariationDeletion({
      variations: buildVariations(1),
      variationId: "theme-0",
      isDeleted: true,
      nowMs: 1,
    });
    expect(plan.isOk).toBe(false);
  });

  it("counts only LIVE themes when deciding the kit still has one", () => {
    const [live, ...rest] = buildVariations(3);
    const variations = [live!, ...rest.map((variation) => ({ ...variation, deletedAtMs: 5 }))];
    const plan = planThemeVariationDeletion({
      variations,
      variationId: live!.id,
      isDeleted: true,
      nowMs: 9,
    });
    /* Two deleted siblings do not make this deletable — one live theme is one. */
    expect(plan.isOk).toBe(false);
  });

  it("restores by clearing the flag, leaving a row indistinguishable from an undeleted one", () => {
    const variations = buildVariations(2).map((variation, index) =>
      index === 0 ? { ...variation, deletedAtMs: 5 } : variation,
    );
    const plan = planThemeVariationDeletion({
      variations,
      variationId: "theme-0",
      isDeleted: false,
      nowMs: 9,
    });
    if (!plan.isOk) {
      throw new Error(plan.message);
    }
    const restored = plan.variations.find((variation) => variation.id === "theme-0");
    expect(restored?.deletedAtMs).toBeUndefined();
    expect(getLiveThemeVariations(plan.variations)).toHaveLength(2);
  });

  it("does NOT let a restore push the kit past the theme cap", () => {
    /*
      A restore takes a slot back, so it clears the same cap an append does.
      Delete one, add eight, then Undo must not produce a ninth live theme.
    */
    const variations = [
      { ...buildVariations(1)[0]!, id: "deleted-one", deletedAtMs: 5 },
      ...buildVariations(MAX_BRAND_KIT_VARIATIONS),
    ];
    const plan = planThemeVariationDeletion({
      variations,
      variationId: "deleted-one",
      isDeleted: false,
      nowMs: 9,
    });
    expect(plan.isOk).toBe(false);
  });

  it("is a no-op rather than an error when the theme is already in the requested state", () => {
    /* Two tabs, or a double click. Neither is a problem worth a message. */
    const variations = buildVariations(2);
    const plan = planThemeVariationDeletion({
      variations,
      variationId: "theme-0",
      isDeleted: false,
      nowMs: 9,
    });
    expect(plan).toEqual({ isOk: true, variations });
  });

  it("refuses an id the kit never had", () => {
    const plan = planThemeVariationDeletion({
      variations: buildVariations(2),
      variationId: "not-a-theme",
      isDeleted: true,
      nowMs: 9,
    });
    expect(plan.isOk).toBe(false);
  });
});
