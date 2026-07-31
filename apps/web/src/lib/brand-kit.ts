import { DEFAULT_GLOBAL_STYLES, type GlobalStyles } from "@tandem/email-sdk";

/**
 * Brand kit — the data contract behind the studio's theme selector.
 *
 * CONTRACT FOR THE FUTURE PIPELINE (Phase 7.4 / backlog §10.9): a scrape step
 * will fetch a user-provided website URL, extract palette / logo / fonts, and
 * an agent will generate a {@link BrandKit} — including 3–4 color
 * {@link ThemeVariation}s with adequately contrasting foreground/background
 * combinations. That pipeline must emit EXACTLY this shape; the theme
 * selector UI (components/studio/theme/) codes against it and nothing else.
 *
 * Until then, {@link MOCK_BRAND_KIT} below stands in with hand-tuned
 * variations. Swap the mock for pipeline output and the UI keeps working.
 *
 * Invariants the pipeline must honor (enforced for the mock by a dev-time
 * check at the bottom of this file):
 * - Every variation's `globals` is a COMPLETE payload (`Required<GlobalStyles>`).
 *   `applyTheme` replaces `root.properties.globals` wholesale, so omitted keys
 *   would silently revert to renderer defaults; complete payloads keep each
 *   theme self-contained and make current-theme detection exact.
 * - Body-text legibility: paragraph and heading text colors, the link color,
 *   and the button label color must each hit WCAG-AA contrast (≥ 4.5:1)
 *   against the background they sit on (content background / button fill).
 *   Use {@link getContrastRatio} — compute it, don't eyeball it.
 * - Layout keys (`contentWidth`, `baseSpacing`, paddings) stay at renderer
 *   defaults unless the brand explicitly demands otherwise: a theme switch
 *   should restyle the email, not reflow it.
 */

/** Font stacks the brand kit was built around (email-safe CSS stacks). */
export interface BrandKitFonts {
  /** Stack used for headings (and any display text). */
  heading: string;
  /** Stack used for paragraphs, buttons, and other body text. */
  body: string;
}

/**
 * One selectable theme: a named, complete `root.properties.globals` payload.
 * Applying it is exactly one `applyTheme` operation. Everything the swatch UI
 * renders (Aa glyph colors, background circles) is read straight from
 * `globals` — no separate display fields to drift out of sync.
 */
export interface ThemeVariation {
  /** Stable id, unique within the kit (e.g. "warm-sand"). */
  id: string;
  /** Short human-readable name shown in the dropdown (e.g. "Warm Sand"). */
  name: string;
  /** The complete globals payload — the exact `applyTheme` argument. */
  globals: Required<GlobalStyles>;
}

/** A brand kit: source provenance, brand basics, and its theme variations. */
export interface BrandKit {
  /** The scraped site, once the pipeline exists. Absent for mock/manual kits. */
  sourceUrl?: string;
  /** Brand name (scraped or user-provided). */
  name: string;
  /** Font stacks extracted for the brand. */
  fonts: BrandKitFonts;
  /**
   * Brand logo: an absolute URL from the site's head metadata / masthead, or
   * a `data:image/svg+xml` URI when the logo was an inline SVG. (Uploading
   * the binary to Convex storage is a separate backlog item.)
   */
  logoUrl?: string;
  /** The site's og:image social-card URL — display-only kit metadata. */
  socialImageUrl?: string;
  /** 3–4 agent-generated color variations; the theme dropdown's content. */
  variations: ThemeVariation[];
}

// ---------------------------------------------------------------------------
// Contrast (WCAG 2.x)
// ---------------------------------------------------------------------------

/** Parse "#rgb" or "#rrggbb" into [r, g, b] (0–255). Returns null otherwise. */
function parseHexColor(color: string): [number, number, number] | null {
  const hex = color.trim().replace(/^#/, "");
  const isShort = /^[0-9a-f]{3}$/i.test(hex);
  const isLong = /^[0-9a-f]{6}$/i.test(hex);
  if (!isShort && !isLong) {
    return null;
  }
  const full = isShort ? [...hex].map((c) => c + c).join("") : hex;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** WCAG relative luminance of a hex color. */
function getRelativeLuminance(color: string): number | null {
  const rgb = parseHexColor(color);
  if (rgb === null) {
    return null;
  }
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two hex colors (1–21). Returns null when either
 * color is not parseable hex (brand kits should stick to hex).
 */
export function getContrastRatio({
  foreground,
  background,
}: {
  foreground: string;
  background: string;
}): number | null {
  const fg = getRelativeLuminance(foreground);
  const bg = getRelativeLuminance(background);
  if (fg === null || bg === null) {
    return null;
  }
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The fg/bg pairings a variation must keep legible (WCAG AA, ≥ 4.5:1). */
export function getVariationContrastPairs(variation: ThemeVariation): {
  label: string;
  foreground: string;
  background: string;
  ratio: number | null;
}[] {
  const { globals } = variation;
  const pairs = [
    { label: "paragraph on content", foreground: globals.paragraphTextColor, background: globals.contentBackgroundColor },
    { label: "heading 1 on content", foreground: globals.heading1TextColor, background: globals.contentBackgroundColor },
    { label: "heading 2 on content", foreground: globals.heading2TextColor, background: globals.contentBackgroundColor },
    { label: "heading 3 on content", foreground: globals.heading3TextColor, background: globals.contentBackgroundColor },
    { label: "link on content", foreground: globals.linkTextColor, background: globals.contentBackgroundColor },
    { label: "button label on button", foreground: globals.buttonTextColor, background: globals.buttonBackgroundColor },
  ];
  return pairs.map((pair) => ({
    ...pair,
    ratio: getContrastRatio({ foreground: pair.foreground, background: pair.background }),
  }));
}

/** Minimum contrast every pairing in {@link getVariationContrastPairs} must hit. */
export const MIN_THEME_CONTRAST_RATIO = 4.5;

// ---------------------------------------------------------------------------
// Whole-kit validation (shared by the Convex saveBrandKit guard and dev checks)
// ---------------------------------------------------------------------------

/** Upper bound on variations per kit (the pipeline emits 3–4; keep it bounded). */
export const MAX_BRAND_KIT_VARIATIONS = 8;

/** Every GlobalStyles key — a variation's payload must define all of them (completeness invariant above). */
const REQUIRED_GLOBAL_KEYS = Object.keys(DEFAULT_GLOBAL_STYLES) as (keyof Required<GlobalStyles>)[];

/**
 * All the reasons a brand kit violates its contract, as human-readable
 * messages (empty array = valid): non-empty name/font stacks, 1..8 variations
 * with unique non-empty ids, COMPLETE globals payloads (applyTheme replaces
 * `root.properties.globals` wholesale), and WCAG-AA contrast on every guarded
 * pairing. This is the single validation implementation: the module-load
 * guard below runs it against the mock, and convex/brandKits.ts runs it
 * server-side so a failing kit is NEVER stored.
 */
export function getBrandKitValidationErrors(brandKit: BrandKit): string[] {
  const errors: string[] = [];
  if (brandKit.name.trim().length === 0) {
    errors.push("The brand kit needs a non-empty name.");
  }
  if (brandKit.fonts.heading.trim().length === 0) {
    errors.push("The heading font stack must not be empty.");
  }
  if (brandKit.fonts.body.trim().length === 0) {
    errors.push("The body font stack must not be empty.");
  }
  if (brandKit.variations.length === 0) {
    errors.push("The brand kit needs at least one theme variation.");
  }
  if (brandKit.variations.length > MAX_BRAND_KIT_VARIATIONS) {
    errors.push(
      `The brand kit has ${brandKit.variations.length} variations; the maximum is ${MAX_BRAND_KIT_VARIATIONS}.`,
    );
  }
  const seenVariationIds = new Set<string>();
  for (const variation of brandKit.variations) {
    if (variation.id.trim().length === 0 || variation.name.trim().length === 0) {
      errors.push("Every variation needs a non-empty id and name.");
    }
    if (seenVariationIds.has(variation.id)) {
      errors.push(`Duplicate variation id "${variation.id}".`);
    }
    seenVariationIds.add(variation.id);
    const missingKeys = REQUIRED_GLOBAL_KEYS.filter((key) => variation.globals[key] === undefined);
    if (missingKeys.length > 0) {
      errors.push(
        `Variation "${variation.id}" is missing globals: ${missingKeys.join(", ")}. ` +
          "Every variation must be a complete payload (applyTheme replaces globals wholesale).",
      );
      continue; // Contrast pairs would read undefined colors — report the real problem only.
    }
    for (const pair of getVariationContrastPairs(variation)) {
      if (pair.ratio === null || pair.ratio < MIN_THEME_CONTRAST_RATIO) {
        errors.push(
          `Variation "${variation.id}" fails contrast: ${pair.label} is ` +
            `${pair.ratio?.toFixed(2) ?? "unparseable"} (needs ≥ ${MIN_THEME_CONTRAST_RATIO}) — ` +
            `${pair.foreground} on ${pair.background}.`,
        );
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Generate-route contract (POST /api/brand-kit/generate)
// ---------------------------------------------------------------------------

/**
 * The response shape of POST /api/brand-kit/generate ({ url } in): the
 * website-scraper pipeline returns a validated, contrast-guarded kit or a
 * FRIENDLY, user-displayable failure message. The brand kit panel codes
 * against exactly this union.
 */
export type BrandKitGenerateResult =
  | { isOk: true; brandKit: BrandKit }
  | { isOk: false; message: string };

// ---------------------------------------------------------------------------
// Current-theme detection
// ---------------------------------------------------------------------------

/** Stable serialization of a globals object (defined keys only, sorted). */
function serializeGlobals(globals: GlobalStyles | undefined): string {
  if (globals === undefined) {
    return "{}";
  }
  const entries = Object.entries(globals)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify(entries);
}

/**
 * Exact-match equality between two globals payloads (order-insensitive,
 * undefined-valued keys ignored). Used to decide which variation — if any —
 * the document currently matches: `applyTheme` writes the variation's payload
 * verbatim, so the doc matches until any global is edited away from it.
 */
export function areGlobalsEqual({
  a,
  b,
}: {
  a: GlobalStyles | undefined;
  b: GlobalStyles | undefined;
}): boolean {
  return serializeGlobals(a) === serializeGlobals(b);
}

/** The variation a document's raw globals exactly match, or null ("Custom"). */
export function findMatchingVariation({
  brandKit,
  globals,
}: {
  brandKit: BrandKit;
  globals: GlobalStyles | undefined;
}): ThemeVariation | null {
  return (
    brandKit.variations.find((variation) => areGlobalsEqual({ a: globals, b: variation.globals })) ??
    null
  );
}

// ---------------------------------------------------------------------------
// Mock brand kit (stands in for pipeline output — see contract above)
// ---------------------------------------------------------------------------

const SANS_STACK = "Helvetica, Arial, sans-serif";
const SERIF_STACK = "Georgia, 'Times New Roman', serif";

/** Layout + spacing keys every variation shares (renderer defaults — themes recolor, never reflow). */
const SHARED_LAYOUT = {
  contentWidth: 600,
  baseSpacing: 24,
  buttonBorderSize: 0,
  buttonHorizontalPadding: 24,
  buttonVerticalPadding: 12,
  heading1TextAlign: "left",
  heading2TextAlign: "left",
  heading3TextAlign: "left",
  paragraphTextAlign: "left",
} as const;

/**
 * The mocked brand kit. Shaped exactly like future pipeline output; the
 * variations are hand-tuned but obey the same contract the agent will.
 */
export const MOCK_BRAND_KIT: BrandKit = {
  name: "Tandem Demo Brand",
  fonts: {
    heading: SANS_STACK,
    body: SANS_STACK,
  },
  variations: [
    {
      id: "classic-light",
      name: "Classic Light",
      globals: {
        ...SHARED_LAYOUT,
        emailBackgroundColor: "#eef1f6",
        contentBackgroundColor: "#ffffff",
        buttonBackgroundColor: "#3730a3",
        buttonTextColor: "#ffffff",
        buttonBorderRadius: 6,
        buttonBorderColor: "#3730a3",
        buttonFontFamily: SANS_STACK,
        heading1FontFamily: SANS_STACK,
        heading1TextColor: "#111827",
        heading2FontFamily: SANS_STACK,
        heading2TextColor: "#111827",
        heading3FontFamily: SANS_STACK,
        heading3TextColor: "#111827",
        paragraphFontFamily: SANS_STACK,
        paragraphTextColor: "#374151",
        linkTextColor: "#3730a3",
        dividerColor: "#e5e7eb",
      },
    },
    {
      id: "warm-sand",
      name: "Warm Sand",
      globals: {
        ...SHARED_LAYOUT,
        emailBackgroundColor: "#f1e8da",
        contentBackgroundColor: "#fdf9f2",
        buttonBackgroundColor: "#9a3412",
        buttonTextColor: "#ffffff",
        buttonBorderRadius: 999,
        buttonBorderColor: "#9a3412",
        buttonFontFamily: SANS_STACK,
        heading1FontFamily: SERIF_STACK,
        heading1TextColor: "#3d2c1e",
        heading2FontFamily: SERIF_STACK,
        heading2TextColor: "#3d2c1e",
        heading3FontFamily: SERIF_STACK,
        heading3TextColor: "#3d2c1e",
        paragraphFontFamily: SANS_STACK,
        paragraphTextColor: "#52402f",
        linkTextColor: "#9a3412",
        dividerColor: "#e4d5bf",
      },
    },
    {
      id: "midnight",
      name: "Midnight",
      globals: {
        ...SHARED_LAYOUT,
        emailBackgroundColor: "#0b1120",
        contentBackgroundColor: "#151c2c",
        buttonBackgroundColor: "#38bdf8",
        buttonTextColor: "#0b1120",
        buttonBorderRadius: 6,
        buttonBorderColor: "#38bdf8",
        buttonFontFamily: SANS_STACK,
        heading1FontFamily: SANS_STACK,
        heading1TextColor: "#f8fafc",
        heading2FontFamily: SANS_STACK,
        heading2TextColor: "#f8fafc",
        heading3FontFamily: SANS_STACK,
        heading3TextColor: "#f8fafc",
        paragraphFontFamily: SANS_STACK,
        paragraphTextColor: "#cbd5e1",
        linkTextColor: "#7dd3fc",
        dividerColor: "#2b3548",
      },
    },
    {
      id: "evergreen",
      name: "Evergreen",
      globals: {
        ...SHARED_LAYOUT,
        emailBackgroundColor: "#123f33",
        contentBackgroundColor: "#ffffff",
        buttonBackgroundColor: "#166534",
        buttonTextColor: "#ffffff",
        buttonBorderRadius: 4,
        buttonBorderColor: "#166534",
        buttonFontFamily: SANS_STACK,
        heading1FontFamily: SERIF_STACK,
        heading1TextColor: "#123f33",
        heading2FontFamily: SERIF_STACK,
        heading2TextColor: "#123f33",
        heading3FontFamily: SERIF_STACK,
        heading3TextColor: "#123f33",
        paragraphFontFamily: SANS_STACK,
        paragraphTextColor: "#2f4a41",
        linkTextColor: "#166534",
        dividerColor: "#d8e5df",
      },
    },
  ],
};

// Dev-time guard: the mock (and any kit swapped in during development) must
// honor the whole contract — completeness AND contrast. Computed, not
// eyeballed; same implementation the server enforces on save.
if (process.env.NODE_ENV !== "production") {
  const mockKitErrors = getBrandKitValidationErrors(MOCK_BRAND_KIT);
  if (mockKitErrors.length > 0) {
    throw new Error(`MOCK_BRAND_KIT violates the brand kit contract:\n${mockKitErrors.join("\n")}`);
  }
}
