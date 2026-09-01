/*
  STARTER ARCHETYPES — three owner-designed, pre-named brand kits offered as
  the brand-first onboarding gate's fallback when a website scrape fails (or
  the person has no website at all).

  WHY THESE EXIST AND `buildDefaultBrandKit` (brand-kit-default.ts) DOES NOT
  COVER IT: that starter is ONE kit — Flock's own brand — offered as a
  generic "something to edit" floor. These three are a curated CHOICE of
  visual directions (a warm/casual look, an editorial/elevated look, a
  bold/dark look) picked at onboarding time, before the user has necessarily
  committed to using Flock's own identity as their starting point.

  REUSE, NOT REINVENTION (owner directive). Every color that ends up in a
  variation's `globals` is put through the exact deterministic pipeline the
  website scrape uses:
    - `expandSemanticVariation` (brand-kit-extraction/expand-variations.ts)
      turns five semantic roles into a COMPLETE `Required<GlobalStyles>`
      payload and repairs any pairing that fails WCAG-AA — nothing here
      hand-picks a contrast-safe hex, the same way the scrape doesn't;
    - `buildBrandColorId` / `renumberBrandColors` (brand-kit-reconcile.ts)
      shape the authored palette exactly the way a saved kit's `colors[]`
      already is (stable ids, per-category ordering);
    - font labels resolve through the SAME email-safe stack table
      (`EMAIL_SAFE_FONT_OPTIONS`) `generate-brand-kit.ts` maps a scraped
      site's fonts through, so "Georgia" here is byte-for-byte the same
      stack a scraped Georgia-using site would get.

  Each archetype ships with exactly ONE named theme variation (the owner's
  spec) — not the 3-4 the scrape pipeline requires of ITSELF as a quality
  bar (see `brandKitModelOutputSchema` in generate-brand-kit.ts). That
  count is a constraint on what the SCRAPE must produce to be worth
  shipping, not a floor on what `saveBrandKit` will accept — the actual
  persistence gate, `getBrandKitValidationErrors` (brand-kit.ts), only ever
  requires at least one live variation, and every archetype clears it (see
  brand-kit-archetypes.test.ts).

  A function, not a frozen module constant — same reasoning as
  `buildDefaultBrandKit`: the caller (the onboarding gate, then
  `saveBrandKit`) is about to hand this object to a row that owns its own
  arrays from that point on, so each call returns freshly built objects
  rather than handing out shared references a later edit could corrupt.
*/

import { EMAIL_SAFE_FONT_OPTIONS } from "@/components/studio/text-editor/email-safe-fonts";
import type { BrandColor, BrandColorCategory, BrandKit } from "./brand-kit";
import { getBrandKitValidationErrors } from "./brand-kit";
import { buildBrandColorId, renumberBrandColors } from "./brand-kit-reconcile";
import { expandSemanticVariation, type ButtonShape } from "./brand-kit-extraction/expand-variations";

interface ArchetypeColorSpec {
  hex: string;
  name: string;
  category: BrandColorCategory;
}

interface ArchetypeSpec {
  name: string;
  headingFontLabel: string;
  bodyFontLabel: string;
  buttonShape: ButtonShape;
  emailBackgroundColor: string;
  contentBackgroundColor: string;
  accentColor: string;
  headingTextColor: string;
  paragraphTextColor: string;
  colors: readonly ArchetypeColorSpec[];
}

/*
  Resolve an EMAIL_SAFE_FONT_OPTIONS label ("Georgia") to its email-safe
  stack — the same lookup `generate-brand-kit.ts`'s `findFontStack` performs
  for a scraped site, reused rather than duplicated (there is exactly one
  label→stack table in the app).
*/
function fontStackForLabel(label: string): string {
  const option = EMAIL_SAFE_FONT_OPTIONS.find((candidate) => candidate.label === label);
  if (option === undefined) {
    throw new Error(`[brand-kit-archetypes] "${label}" is not an email-safe font label.`);
  }
  return option.value;
}

/*
  The owner's three archetypes, verbatim. Hex values are lowercase (the
  wire contract's `colors[].hex` and `globals` values are always
  lowercase — see brandKitSchema in generate-brand-kit.ts).
*/
const ARCHETYPE_SPECS: readonly ArchetypeSpec[] = [
  {
    name: "Daylight",
    headingFontLabel: "Trebuchet MS",
    bodyFontLabel: "Helvetica",
    buttonShape: "rounded",
    emailBackgroundColor: "#fff6ec",
    contentBackgroundColor: "#ffffff",
    accentColor: "#ff6b4a",
    headingTextColor: "#1f2933",
    paragraphTextColor: "#52606d",
    colors: [
      { hex: "#ff6b4a", name: "Coral", category: "accent" },
      { hex: "#1f2933", name: "Slate Ink", category: "primary" },
      { hex: "#fff6ec", name: "Warm White", category: "secondary" },
      { hex: "#52606d", name: "Slate Gray", category: "secondary" },
    ],
  },
  {
    name: "Gilded",
    headingFontLabel: "Georgia",
    bodyFontLabel: "Georgia",
    buttonShape: "square",
    emailBackgroundColor: "#f3ede2",
    contentBackgroundColor: "#fbf7f0",
    accentColor: "#b08d57",
    headingTextColor: "#2e2419",
    paragraphTextColor: "#5c5142",
    colors: [
      { hex: "#b08d57", name: "Antique Gold", category: "accent" },
      { hex: "#2e2419", name: "Espresso", category: "primary" },
      { hex: "#f3ede2", name: "Cream", category: "secondary" },
      { hex: "#5c5142", name: "Taupe", category: "secondary" },
    ],
  },
  {
    name: "Nocturne",
    headingFontLabel: "Helvetica",
    bodyFontLabel: "Helvetica",
    buttonShape: "rounded",
    emailBackgroundColor: "#0e0e12",
    contentBackgroundColor: "#17171f",
    accentColor: "#6c5ce7",
    headingTextColor: "#f5f5f7",
    paragraphTextColor: "#a9a9b8",
    colors: [
      { hex: "#6c5ce7", name: "Electric Indigo", category: "accent" },
      { hex: "#0e0e12", name: "Ink", category: "primary" },
      { hex: "#17171f", name: "Slate", category: "secondary" },
      { hex: "#a9a9b8", name: "Mist", category: "secondary" },
    ],
  },
];

function buildArchetypeColors(specs: readonly ArchetypeColorSpec[]): BrandColor[] {
  return renumberBrandColors(
    specs.map((spec) => ({
      id: buildBrandColorId(spec.hex),
      hex: spec.hex,
      name: spec.name,
      category: spec.category,
      orderIndex: 0,
      origin: "agent",
    })),
  );
}

function buildArchetypeKit(spec: ArchetypeSpec): BrandKit {
  const fonts = {
    heading: fontStackForLabel(spec.headingFontLabel),
    body: fontStackForLabel(spec.bodyFontLabel),
  };
  const variation = expandSemanticVariation({
    semantic: {
      name: spec.name,
      emailBackgroundColor: spec.emailBackgroundColor,
      contentBackgroundColor: spec.contentBackgroundColor,
      accentColor: spec.accentColor,
      headingTextColor: spec.headingTextColor,
      paragraphTextColor: spec.paragraphTextColor,
    },
    fonts,
    buttonShape: spec.buttonShape,
  });
  if (variation === null) {
    /*
      Would mean a spec regressed to an unparseable color — a bug in this
      file, not a runtime condition a caller should have to handle.
    */
    throw new Error(`[brand-kit-archetypes] "${spec.name}" failed contrast expansion.`);
  }
  return {
    name: spec.name,
    fonts,
    colors: buildArchetypeColors(spec.colors),
    variations: [variation],
  };
}

/*
  The three archetypes, freshly built on every call.
*/
export function getStarterArchetypes(): BrandKit[] {
  return ARCHETYPE_SPECS.map(buildArchetypeKit);
}

/*
  Dev-time guard, same stance as `MOCK_BRAND_KIT`'s own module-load
  assertion: a spec that regresses past contrast or completeness fails
  immediately at import time, in every environment that loads this module,
  rather than surfacing later as a rejected `saveBrandKit` call.
*/
if (process.env.NODE_ENV !== "production") {
  for (const archetype of getStarterArchetypes()) {
    const errors = getBrandKitValidationErrors(archetype);
    if (errors.length > 0) {
      throw new Error(
        `[brand-kit-archetypes] "${archetype.name}" violates the brand kit contract:\n${errors.join("\n")}`,
      );
    }
  }
}
