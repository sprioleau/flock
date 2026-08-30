/*
  The scrape's AUTHORED palette (docs/proposals/brand-kit-user-control.md §3):
  turn harvested colors plus the model's naming/categorization into
  `BrandColor[]` — named, categorized entries a human can then edit.

  The owner's `--banana` idea lands here. `harvest.ts` already captures the
  CSS custom property each color was declared as, and the prompt already shows
  it to the model; the only thing missing was somewhere to PUT the name. Now
  there is, and the name resolution is a three-rung ladder that always
  terminates (lib/brand-kit.ts `resolveBrandColorName`):
    model's proposal → derived from `--banana` → a description of the color.

  FAITHFULNESS, same rule the logo pick follows: a color the model proposes
  must appear VERBATIM in the harvested signals, or it is dropped. The model
  names and categorizes; it never introduces a color the site doesn't use.

  CARDINALITY (§3.3): 2 primary / 2 secondary / 2 accent is a TARGET the
  deterministic fill aims at and stops early rather than pads. A monochrome
  brand gets three colors and no empty slots.
*/

import {
  MAX_BRAND_COLORS,
  TARGET_COLORS_PER_CATEGORY,
  resolveBrandColorName,
  type BrandColor,
  type BrandColorCategory,
} from "@/lib/brand-kit";
import { buildBrandColorId, renumberBrandColors } from "@/lib/brand-kit-reconcile";
import type { RankedColor } from "./harvest";

/*
  What the model proposes per color: naming and role, never a new color.
*/
export interface ModelBrandColor {
  hex: string;
  name: string;
  category: BrandColorCategory;
}

function normalizeHex(hex: string): string | null {
  const raw = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(raw) && !/^[0-9a-f]{3}$/i.test(raw)) {
    return null;
  }
  const full = raw.length === 3 ? [...raw].map((character) => character + character).join("") : raw;
  return `#${full.toLowerCase()}`;
}

/*
  Harvest provenance for one color, when the scrape saw it declared.
*/
function findHarvestProvenance({
  hex,
  rankedColors,
}: {
  hex: string;
  rankedColors: RankedColor[];
}): { sourceVariableName?: string; sourceUsageCount?: number } | null {
  const match = rankedColors.find((ranked) => normalizeHex(ranked.color) === hex);
  if (match === undefined) {
    return null;
  }
  return {
    ...(match.variableName === null ? {} : { sourceVariableName: match.variableName }),
    sourceUsageCount: match.count,
  };
}

/*
  The deterministic palette, used when the model proposed nothing usable and
  to top up a thin one. Accents come from the high-chroma candidate list (the
  harvester's own "these are signature accents" signal); primaries and
  secondaries come off the prominence ranking in order.
*/
function buildDeterministicColors({
  rankedColors,
  accentCandidates,
  takenHexes,
}: {
  rankedColors: RankedColor[];
  accentCandidates: RankedColor[];
  takenHexes: Set<string>;
}): BrandColor[] {
  const accentHexes = new Set(
    accentCandidates.flatMap((candidate) => {
      const hex = normalizeHex(candidate.color);
      return hex === null ? [] : [hex];
    }),
  );
  const claimed = new Set(takenHexes);
  const results: BrandColor[] = [];
  const countByCategory = new Map<BrandColorCategory, number>();
  const take = ({ ranked, category }: { ranked: RankedColor; category: BrandColorCategory }): void => {
    const hex = normalizeHex(ranked.color);
    if (hex === null || claimed.has(hex)) {
      return;
    }
    if ((countByCategory.get(category) ?? 0) >= TARGET_COLORS_PER_CATEGORY) {
      return;
    }
    claimed.add(hex);
    countByCategory.set(category, (countByCategory.get(category) ?? 0) + 1);
    results.push({
      id: buildBrandColorId(hex),
      hex,
      name: resolveBrandColorName({
        ...(ranked.variableName === null ? {} : { variableName: ranked.variableName }),
        hex,
      }),
      category,
      orderIndex: 0,
      origin: "scraped",
      ...(ranked.variableName === null ? {} : { sourceVariableName: ranked.variableName }),
      sourceUsageCount: ranked.count,
    });
  };
  /*
    Accents first: the harvester singled them out, and they are the colors a
    brand is actually recognized by.
  */
  for (const candidate of accentCandidates) {
    take({ ranked: candidate, category: "accent" });
  }
  const nonAccents = rankedColors.filter((ranked) => {
    const hex = normalizeHex(ranked.color);
    return hex !== null && !accentHexes.has(hex);
  });
  for (const ranked of nonAccents) {
    take({ ranked, category: "primary" });
  }
  for (const ranked of nonAccents) {
    take({ ranked, category: "secondary" });
  }
  return results;
}

/*
  Build the kit's authored palette. Model proposals lead (they carry the
  names and the human-legible categories); the deterministic pass fills what
  is missing so a kit always ships with SOME named palette.
*/
export function buildBrandColors({
  modelColors,
  rankedColors,
  accentCandidates,
}: {
  modelColors: ModelBrandColor[];
  rankedColors: RankedColor[];
  accentCandidates: RankedColor[];
}): BrandColor[] {
  const harvestedHexes = new Set(
    [...rankedColors, ...accentCandidates].flatMap((ranked) => {
      const hex = normalizeHex(ranked.color);
      return hex === null ? [] : [hex];
    }),
  );
  const claimed = new Set<string>();
  const fromModel: BrandColor[] = [];
  for (const proposal of modelColors) {
    const hex = normalizeHex(proposal.hex);
    /*
      Faithfulness: the model may name and categorize, never introduce.
    */
    if (hex === null || claimed.has(hex) || !harvestedHexes.has(hex)) {
      continue;
    }
    claimed.add(hex);
    const provenance = findHarvestProvenance({ hex, rankedColors: [...rankedColors, ...accentCandidates] });
    fromModel.push({
      id: buildBrandColorId(hex),
      hex,
      name: resolveBrandColorName({
        proposedName: proposal.name,
        ...(provenance?.sourceVariableName === undefined
          ? {}
          : { variableName: provenance.sourceVariableName }),
        hex,
      }),
      category: proposal.category,
      orderIndex: 0,
      origin: "agent",
      ...(provenance ?? {}),
    });
  }
  const filled = buildDeterministicColors({
    rankedColors,
    accentCandidates,
    takenHexes: claimed,
  });
  return renumberBrandColors([...fromModel, ...filled].slice(0, MAX_BRAND_COLORS));
}
