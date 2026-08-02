/**
 * Re-scrape reconciliation (docs/proposals/brand-kit-user-control.md §8) —
 * the load-bearing problem in the whole proposal. Before this, a save was a
 * wholesale replace: scrape a site, rename its colors, re-scrape, and every
 * name you typed was gone silently.
 *
 * These tests pin the property that fixes it: ANYTHING A HUMAN TOUCHED
 * SURVIVES A RE-SCRAPE, and what was kept is reportable so the panel can say
 * it out loud.
 */
import { describe, expect, it } from "vitest";
import {
  buildBrandColorId,
  describeBrandKitReconciliation,
  isHumanOwnedColor,
  planBrandColorsUpdate,
  reconcileBrandColors,
  reconcileToneOfVoice,
  renumberBrandColors,
} from "./brand-kit-reconcile";
import { MAX_BRAND_COLORS, type BrandColor, type BrandToneOfVoice } from "./brand-kit";

function color(overrides: Partial<BrandColor> & { hex: string; name: string }): BrandColor {
  return {
    id: buildBrandColorId(overrides.hex),
    category: "primary",
    orderIndex: 0,
    origin: "agent",
    ...overrides,
  };
}

const NOW = 1_700_000_000_000;

describe("reconcileBrandColors — human edits survive the scrape", () => {
  it("keeps a renamed color VERBATIM and discards the scrape's version of it", () => {
    const stored = [
      color({ hex: "#ffc400", name: "Banana", origin: "user", userEditedAtMs: NOW }),
      color({ hex: "#0b1120", name: "Ink", origin: "agent" }),
    ];
    const incoming = [
      color({ hex: "#ffc400", name: "Yellow" }), // the scrape's blander name
      color({ hex: "#123456", name: "Steel" }),
    ];
    const { colors, keptUserEditedCount, adoptedFromSiteCount } = reconcileBrandColors({
      existing: stored,
      incoming,
    });
    expect(colors.map(({ name }) => name)).toEqual(["Banana", "Steel"]);
    expect(keptUserEditedCount).toBe(1);
    expect(adoptedFromSiteCount).toBe(1);
    // The machine entry from the PREVIOUS scrape is gone — that is what a
    // re-scrape is for.
    expect(colors.some(({ name }) => name === "Ink")).toBe(false);
  });

  it("treats a userEditedAtMs stamp as ownership even when origin still reads agent", () => {
    const stored = [color({ hex: "#ffc400", name: "Banana", origin: "agent", userEditedAtMs: NOW })];
    const { colors } = reconcileBrandColors({
      existing: stored,
      incoming: [color({ hex: "#ffc400", name: "Yellow" })],
    });
    expect(colors[0]?.name).toBe("Banana");
  });

  it("never lets an incoming color duplicate a hex the human already claimed", () => {
    const stored = [color({ hex: "#FFC400", name: "Banana", origin: "user" })];
    const { colors } = reconcileBrandColors({
      // Same color, different casing/shorthand — still the human's.
      existing: stored,
      incoming: [color({ hex: "#ffc400", name: "Yellow" })],
    });
    expect(colors).toHaveLength(1);
  });

  it("leaves the stored palette alone when a save carries none", () => {
    const stored = [color({ hex: "#ffc400", name: "Banana", origin: "user" })];
    const { colors, adoptedFromSiteCount } = reconcileBrandColors({
      existing: stored,
      incoming: undefined,
    });
    expect(colors).toEqual(stored);
    expect(adoptedFromSiteCount).toBe(0);
  });

  it("respects the cap, keeping the human's entries over the scrape's", () => {
    const stored = Array.from({ length: MAX_BRAND_COLORS }, (_, index) =>
      color({ hex: `#0000${index.toString(16).padStart(2, "0")}`, name: `Mine ${index}`, origin: "user" }),
    );
    const { colors } = reconcileBrandColors({
      existing: stored,
      incoming: [color({ hex: "#ffc400", name: "Yellow" })],
    });
    expect(colors).toHaveLength(MAX_BRAND_COLORS);
    expect(colors.every(({ name }) => name.startsWith("Mine"))).toBe(true);
  });

  it("renumbers order densely within each category", () => {
    const { colors } = reconcileBrandColors({
      existing: [],
      incoming: [
        color({ hex: "#111111", name: "A", category: "primary", orderIndex: 9 }),
        color({ hex: "#222222", name: "B", category: "accent", orderIndex: 4 }),
        color({ hex: "#333333", name: "C", category: "primary", orderIndex: 7 }),
      ],
    });
    expect(colors.map(({ category, orderIndex }) => `${category}${orderIndex}`)).toEqual([
      "primary0",
      "accent0",
      "primary1",
    ]);
  });
});

describe("reconcileToneOfVoice", () => {
  const scraped: BrandToneOfVoice = { descriptors: ["bold"], origin: "agent" };
  const authored: BrandToneOfVoice = {
    descriptors: ["warm", "plain-spoken"],
    guidance: "Short sentences.",
    origin: "user",
    userEditedAtMs: NOW,
  };

  it("keeps a voice the human wrote, whole", () => {
    const { toneOfVoice, keptUserEdit } = reconcileToneOfVoice({
      existing: authored,
      incoming: scraped,
    });
    expect(toneOfVoice).toEqual(authored);
    expect(keptUserEdit).toBe(true);
  });

  it("refreshes a machine voice from the scrape", () => {
    const { toneOfVoice, keptUserEdit } = reconcileToneOfVoice({
      existing: { descriptors: ["stale"], origin: "agent" },
      incoming: scraped,
    });
    expect(toneOfVoice).toEqual(scraped);
    expect(keptUserEdit).toBe(false);
  });

  it("keeps the stored voice when the scrape found no copy at all", () => {
    const { toneOfVoice } = reconcileToneOfVoice({ existing: scraped, incoming: undefined });
    expect(toneOfVoice).toEqual(scraped);
  });
});

describe("planBrandColorsUpdate — provenance decided server-side", () => {
  const stored = [
    color({
      hex: "#ffc400",
      name: "Yellow",
      origin: "agent",
      sourceVariableName: "--banana",
      sourceUsageCount: 41,
    }),
  ];

  it("stamps a changed entry as the human's", () => {
    const [updated] = planBrandColorsUpdate({
      existing: stored,
      incoming: [{ ...stored[0]!, name: "Banana" }],
      nowMs: NOW,
    });
    expect(updated?.origin).toBe("user");
    expect(updated?.userEditedAtMs).toBe(NOW);
    expect(isHumanOwnedColor(updated!)).toBe(true);
  });

  it("leaves an untouched entry's provenance alone (saving ≠ editing)", () => {
    const [unchanged] = planBrandColorsUpdate({
      existing: stored,
      incoming: [{ ...stored[0]! }],
      nowMs: NOW,
    });
    expect(unchanged?.origin).toBe("agent");
    expect(unchanged?.userEditedAtMs).toBeUndefined();
  });

  it("keeps the scrape's --banana provenance across the rename it explains", () => {
    const [renamed] = planBrandColorsUpdate({
      existing: stored,
      incoming: [{ ...stored[0]!, name: "Banana", sourceVariableName: undefined, sourceUsageCount: undefined }],
      nowMs: NOW,
    });
    expect(renamed?.sourceVariableName).toBe("--banana");
    expect(renamed?.sourceUsageCount).toBe(41);
  });

  it("normalizes a typed hex and treats a brand-new row as the human's", () => {
    const [added] = planBrandColorsUpdate({
      existing: [],
      incoming: [color({ hex: "#ABC", name: "Sky" })],
      nowMs: NOW,
    });
    expect(added?.hex).toBe("#aabbcc");
    expect(added?.origin).toBe("user");
  });
});

describe("describeBrandKitReconciliation — say what was kept", () => {
  it("names both kinds of survivor", () => {
    expect(
      describeBrandKitReconciliation({ keptUserEditedColors: 3, keptUserToneOfVoice: true }),
    ).toBe("Updated from the site — we kept 3 colors you edited and your tone of voice.");
  });

  it("reads naturally for one color", () => {
    expect(
      describeBrandKitReconciliation({ keptUserEditedColors: 1, keptUserToneOfVoice: false }),
    ).toBe("Updated from the site — we kept 1 color you edited.");
  });

  it("says nothing when there was nothing of the human's to keep", () => {
    expect(
      describeBrandKitReconciliation({ keptUserEditedColors: 0, keptUserToneOfVoice: false }),
    ).toBeNull();
  });
});

describe("renumberBrandColors / buildBrandColorId", () => {
  it("derives a stable id from the color so an unchanged color keeps its identity", () => {
    expect(buildBrandColorId("#FFC400")).toBe(buildBrandColorId("#ffc400"));
    expect(buildBrandColorId("#ffc400")).toBe("color-ffc400");
  });

  it("is a no-op on an already dense list", () => {
    const dense = [
      color({ hex: "#111111", name: "A", orderIndex: 0 }),
      color({ hex: "#222222", name: "B", orderIndex: 1 }),
    ];
    expect(renumberBrandColors(dense).map(({ orderIndex }) => orderIndex)).toEqual([0, 1]);
  });
});
