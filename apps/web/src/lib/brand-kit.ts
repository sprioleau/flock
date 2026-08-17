import { DEFAULT_GLOBAL_STYLES, type GlobalStyles } from "@flock/email-sdk";
import type { BrandSocialLink } from "./social-links";

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
  /*
    SOFT DELETION (brand-kit-user-control §14.5b). Set when the user deleted
    this theme; the row survives so the id — which is what every draft pointer
    names — survives with it. Restoring clears the field and every draft that
    pointed here is linked again, overrides intact, without a single document
    write. A hard delete could not offer that: a re-created theme slugs to a
    NEW id, so the link would be gone forever.

    Absent means live. Every read that answers "what themes does this kit
    have" filters through {@link getLiveThemeVariations} — the dropdown, the
    8-theme cap, propagation targets and {@link findMatchingVariation} — so a
    deleted theme cannot be picked, matched, targeted, or counted.
  */
  deletedAtMs?: number;
}

/**
 * The soft-deletion flag on its own — the minimum a caller has to carry to be
 * filtered. Declared separately because a Convex ROW's variation is typed
 * `globals: Record<string, any>` (the table validator's deliberate `v.any()`),
 * not `Required<GlobalStyles>`, so a filter constrained to the full
 * {@link ThemeVariation} would force a cast at every server call site. This is
 * the honest constraint: filtering reads one optional number and nothing else.
 */
export interface SoftDeletableVariation {
  deletedAtMs?: number;
}

/** True while a variation has not been soft-deleted. */
export function isThemeVariationLive(variation: SoftDeletableVariation): boolean {
  return variation.deletedAtMs === undefined;
}

/*
  The themes a kit actually HAS, as against the rows it still stores. THE
  filter for soft deletion: every surface that offers, matches, targets or
  counts a theme goes through here, so "a deleted theme is invisible" is one
  function rather than a rule each call site has to remember. Generic in the
  element type, so it hands back exactly what it was given.
*/
export function getLiveThemeVariations<Variation extends SoftDeletableVariation>(
  variations: Variation[],
): Variation[] {
  return variations.filter((variation) => isThemeVariationLive(variation));
}

/**
 * Where a piece of kit data came from — the re-scrape reconciliation key
 * (brand-kit-user-control §8.2). "scraped" = deterministic extraction,
 * "agent" = the model proposed it, "user" = a human authored or overrode it.
 * Anything marked "user" (or carrying `userEditedAtMs`) SURVIVES a re-scrape.
 */
export type BrandDataOrigin = "scraped" | "agent" | "user";

/** Brand role a color plays. Fixed enum on purpose — see the note below. */
export type BrandColorCategory = "primary" | "secondary" | "accent";

/**
 * One AUTHORED brand color (brand-kit-user-control §3.2).
 *
 * This is a curated PALETTE — a named source for the color picker and for the
 * agent — NOT a token layer. Documents store literal hex values, so editing a
 * hex here never repaints an existing draft; the panel says so in words.
 * Renaming and deleting are always safe for the same reason.
 */
export interface BrandColor {
  /** Stable id; survives renames and recolors. */
  id: string;
  /** Normalized #rrggbb — the only value that ever renders. */
  hex: string;
  /** Human-meaningful name ("Banana"). Agent-proposed, human-overridable. */
  name: string;
  /** Brand role (fixed enum: the agent needs a reliable "the primary color"). */
  category: BrandColorCategory;
  /** Ordering within a category. */
  orderIndex: number;
  origin: BrandDataOrigin;
  /** The CSS custom property the scrape saw this color declared as ("--banana"). */
  sourceVariableName?: string;
  /** Harvested usage count (RankedColor.count) — provenance for "why this color?". */
  sourceUsageCount?: number;
  /** Set when a human touched this entry — the re-scrape lock (§8.2). */
  userEditedAtMs?: number;
}

/** How formal the brand's copy reads. */
export type BrandVoiceFormality = "casual" | "neutral" | "formal";
/** Whether the brand speaks as "we" or refers to itself in the third person. */
export type BrandVoicePerson = "first-person-plural" | "third-person";

/**
 * The vocabulary the "Sounds like" field offers (brand-kit-v2 §4). Picking
 * from a set beats a free-text box here: a person asked to describe a voice
 * in their own words either freezes or writes a sentence, and the model reads
 * these words better when they are drawn from a small, consistent list — the
 * scrape proposes from the SAME list (generate-brand-kit.ts).
 *
 * `descriptors` stays `string[]` on the row on purpose: kits saved before
 * this list existed (and any future addition to it) keep their words instead
 * of being silently dropped. The editor shows an off-vocabulary word as a
 * selected chip the user can turn off.
 */
export const BRAND_VOICE_DESCRIPTOR_OPTIONS = [
  "serious",
  "playful",
  "energetic",
  "warm",
  "authoritative",
  "irreverent",
  "plainspoken",
  "optimistic",
  "technical",
] as const;

export type BrandVoiceDescriptor = (typeof BRAND_VOICE_DESCRIPTOR_OPTIONS)[number];

/** A descriptor as it reads in the UI ("plainspoken" → "Plainspoken"). */
export function getBrandVoiceDescriptorLabel(descriptor: string): string {
  return descriptor.charAt(0).toUpperCase() + descriptor.slice(1);
}

/**
 * The words the editor offers: the vocabulary, plus anything already stored
 * that is not in it (an older kit, or a scrape from before the vocabulary
 * existed). An unknown stored word stays visible and removable instead of
 * disappearing the first time the panel is opened.
 */
export function getBrandVoiceDescriptorChoices(selected: string[]): string[] {
  const vocabulary: string[] = [...BRAND_VOICE_DESCRIPTOR_OPTIONS];
  return [...vocabulary, ...selected.filter((descriptor) => !vocabulary.includes(descriptor))];
}

/**
 * Turn one word on or off. Selecting past {@link MAX_VOICE_DESCRIPTORS} is a
 * no-op (the chip is disabled too — the cap is shown, never enforced by
 * silently dropping the user's earlier picks). Deselecting always works, so a
 * kit that arrived over the cap can be edited back down.
 */
export function toggleBrandVoiceDescriptor({
  selected,
  descriptor,
}: {
  selected: string[];
  descriptor: string;
}): string[] {
  if (selected.includes(descriptor)) {
    return selected.filter((entry) => entry !== descriptor);
  }
  if (selected.length >= MAX_VOICE_DESCRIPTORS) {
    return selected;
  }
  return [...selected, descriptor];
}

/**
 * The brand's tone of voice (brand-kit-user-control §5.2): coarse axes with
 * enough structure to be usable deterministically, plus the freeform space
 * that actually carries nuance.
 *
 * SECURITY NOTE: `guidance` and `avoid` are the first kit fields whose content
 * is PROSE the model reads. When scraped they are untrusted page-derived
 * content — format them as a delimited data block, never as imperative system
 * instructions (see lib/brand-voice.ts, which is the only sanctioned way to
 * put this in front of a model).
 */
export interface BrandToneOfVoice {
  /** 1–3 short adjectives ("warm", "irreverent", "precise"). */
  descriptors: string[];
  formality?: BrandVoiceFormality;
  person?: BrandVoicePerson;
  /** Freeform direction, shown to the model verbatim inside a data block. */
  guidance?: string;
  /** Words/phrases the brand does not use — the highest-signal field in practice. */
  avoid?: string[];
  origin: BrandDataOrigin;
  userEditedAtMs?: number;
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
   * Brand logo. Until confirmed: an extraction SUGGESTION (absolute URL from
   * the site's head metadata / masthead, or a `data:image/svg+xml` URI).
   * After confirmation (confirm-asset route): the durable Convex storage
   * serving URL. Owner decision 4: only CONFIRMED assets may enter documents
   * — gate all document-writing reads through getConfirmedBrandAssetUrl.
   */
  logoUrl?: string;
  /** Set (server-side) when the logo was confirmed into Convex storage. */
  logoConfirmedAtMs?: number;
  /** The site's og:image social-card URL — same suggestion→confirmed lifecycle. */
  socialImageUrl?: string;
  /** Set (server-side) when the social card was confirmed into Convex storage. */
  socialImageConfirmedAtMs?: number;
  /** Monotonic save counter (server-managed; absent on unsaved/mock kits). */
  revision?: number;
  /**
   * True while this row is the untouched Flock STARTER kit (§14.5c) — the kit
   * seeded so a user whose site cannot be scraped still has something to edit.
   *
   * Drives exactly one thing: the panel's "Starter" badge and the copy beside
   * it. Server-managed, and cleared by the two gestures that make the kit the
   * user's own — renaming it, or replacing it with a scrape.
   */
  isStarterKit?: boolean;
  /**
   * The brand's social profile links (item 26), one per platform, extracted
   * deterministically (JSON-LD sameAs → footer/nav scan). Used by the footer
   * fill affordance and exposed to the chat agent's per-request context.
   */
  socialLinks?: BrandSocialLink[];
  /**
   * The AUTHORED palette (§3). When present and non-empty it REPLACES the
   * derived palette in {@link getBrandKitPalette}; absent means legacy/mock
   * kits keep today's derivation, so nothing needs migrating.
   */
  colors?: BrandColor[];
  /** The brand's tone of voice (§5) — kit metadata; nothing renders from it. */
  toneOfVoice?: BrandToneOfVoice;
  /** 3–4 agent-generated color variations; the theme dropdown's content. */
  variations: ThemeVariation[];
  /**
   * The themes the user SOFT-DELETED (§14.5b), newest deletion last. Present
   * only on kits read from a stored row, and never on a scrape's output.
   *
   * KIT METADATA, NOT CONTENT. Nothing renders it, nothing applies it, and it
   * is deliberately kept OUT of {@link variations} so every existing consumer
   * — the dropdown, the palette derivation, contrast validation, propagation
   * — keeps meaning "the themes this kit has" without knowing deletion exists.
   * Two surfaces need it: the panel's Restore affordance (the payoff of soft
   * deletion, and the reason an undo outlives the click that caused it), and
   * id uniqueness — a deleted row still occupies its id, so the add form has
   * to count it as taken or the server would refuse the collision.
   */
  deletedVariations?: ThemeVariation[];
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
  /*
    COUNTED ON THE LIVE SET, checked on all of them. A soft-deleted variation
    is not a theme this kit has, so it must not fill a slot in the cap and must
    not satisfy "at least one" — but its payload is still stored and can still
    be restored, so completeness and contrast below run over every row.
  */
  const liveVariations = getLiveThemeVariations(brandKit.variations);
  if (liveVariations.length === 0) {
    errors.push("The brand kit needs at least one theme variation.");
  }
  if (liveVariations.length > MAX_BRAND_KIT_VARIATIONS) {
    errors.push(
      `The brand kit has ${liveVariations.length} variations; the maximum is ${MAX_BRAND_KIT_VARIATIONS}.`,
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
  errors.push(...getBrandColorsValidationErrors(brandKit.colors));
  errors.push(...getToneOfVoiceValidationErrors(brandKit.toneOfVoice));
  return errors;
}

// ---------------------------------------------------------------------------
// Authored colors — the palette a human curates (brand-kit-user-control §3)
// ---------------------------------------------------------------------------

/**
 * Upper bound on authored colors per kit. Deliberately NOT the owner's 2+2+2:
 * the counts are a shape the scrape TARGETS, not a cardinality it pads to
 * (§3.3). A monochrome brand gets three colors and no empty slots; a rainbow
 * brand gets its accents. The cap keeps the panel, the picker row and the
 * agent prompt bounded.
 */
export const MAX_BRAND_COLORS = 12;

/** How many colors per category the scrape aims for before it stops. */
export const TARGET_COLORS_PER_CATEGORY = 2;

/** Longest name a human (or the agent) may give a color. */
export const MAX_BRAND_COLOR_NAME_LENGTH = 24;

/** The three categories in panel display order (labeled groups, top to bottom). */
export const BRAND_COLOR_CATEGORIES: readonly BrandColorCategory[] = [
  "primary",
  "secondary",
  "accent",
];

/** User-facing category names — never render the raw keys. */
export const BRAND_COLOR_CATEGORY_LABELS: Record<BrandColorCategory, string> = {
  primary: "Primary",
  secondary: "Secondary",
  accent: "Accent",
};

/**
 * Category order for the PICKER row (as opposed to the panel): primaries and
 * accents lead, because the row is capped at 6 and those are the colors a
 * person reaches for. The panel still groups primary → secondary → accent.
 */
const PICKER_CATEGORY_ORDER: readonly BrandColorCategory[] = ["primary", "accent", "secondary"];

/** Hard (blocking) problems with an authored palette. Empty array = valid. */
export function getBrandColorsValidationErrors(colors: BrandColor[] | undefined): string[] {
  if (colors === undefined) {
    return [];
  }
  const errors: string[] = [];
  if (colors.length > MAX_BRAND_COLORS) {
    errors.push(`A brand kit can hold ${MAX_BRAND_COLORS} colors; this one has ${colors.length}.`);
  }
  const seenIds = new Set<string>();
  for (const color of colors) {
    if (color.id.trim().length === 0) {
      errors.push("Every brand color needs an id.");
    } else if (seenIds.has(color.id)) {
      errors.push(`Duplicate brand color id "${color.id}".`);
    }
    seenIds.add(color.id);
    if (normalizeHexColor(color.hex) === null) {
      errors.push(`"${color.hex}" isn't a color we can read — use a hex value like #ffc400.`);
    }
    if (color.name.trim().length === 0) {
      errors.push("Every brand color needs a name.");
    }
    if (color.name.length > MAX_BRAND_COLOR_NAME_LENGTH) {
      errors.push(
        `Color names can be up to ${MAX_BRAND_COLOR_NAME_LENGTH} characters — "${color.name}" is longer.`,
      );
    }
  }
  return errors;
}

/** Longest freeform voice guidance we store (and hand to the model). */
export const MAX_VOICE_GUIDANCE_LENGTH = 400;
/** At most this many descriptors / avoid-words (a chore beyond that). */
export const MAX_VOICE_DESCRIPTORS = 3;
export const MAX_VOICE_AVOID_WORDS = 12;

/** Hard (blocking) problems with a tone-of-voice payload. */
export function getToneOfVoiceValidationErrors(tone: BrandToneOfVoice | undefined): string[] {
  if (tone === undefined) {
    return [];
  }
  const errors: string[] = [];
  if (tone.descriptors.length > MAX_VOICE_DESCRIPTORS) {
    errors.push(`Keep tone of voice to ${MAX_VOICE_DESCRIPTORS} descriptors or fewer.`);
  }
  if ((tone.guidance ?? "").length > MAX_VOICE_GUIDANCE_LENGTH) {
    errors.push(`Voice guidance can be up to ${MAX_VOICE_GUIDANCE_LENGTH} characters.`);
  }
  if ((tone.avoid ?? []).length > MAX_VOICE_AVOID_WORDS) {
    errors.push(`Keep the "avoid" list to ${MAX_VOICE_AVOID_WORDS} entries or fewer.`);
  }
  return errors;
}

/**
 * Prefix noise stripped when deriving a name from a CSS custom property:
 * `--ui-accent-1` is the site calling it "accent 1", not "ui accent 1".
 */
const COLOR_VARIABLE_NOISE_WORDS = new Set([
  "ui",
  "color",
  "colour",
  "c",
  "clr",
  "theme",
  "brand",
  "token",
  "palette",
  "var",
  "global",
  "ds",
]);

/**
 * A human-meaningful name derived from the CSS custom property a color was
 * declared as — the owner's `--banana` → "Banana" (§3.4, rung 1). Honest and
 * boring: it names the color what the site itself called it. Returns null
 * when nothing meaningful survives (`--c-4`, `--x`).
 */
export function deriveColorNameFromVariable(variableName: string): string | null {
  const words = variableName
    .replace(/^-+/, "")
    .split(/[-_]+/)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length > 0);
  // Leading noise words only: "--ui-accent" loses "ui"; "--brand" keeps
  // "brand" rather than deriving nothing at all.
  let start = 0;
  while (start < words.length - 1 && COLOR_VARIABLE_NOISE_WORDS.has(words[start]!)) {
    start += 1;
  }
  const meaningful = words.slice(start).filter((word) => !/^\d+$/.test(word) || words.length > 1);
  if (meaningful.length === 0) {
    return null;
  }
  // A name that is only digits or a single letter says nothing.
  const isMeaningless = meaningful.every((word) => /^\d+$/.test(word) || word.length < 2);
  if (isMeaningless) {
    return null;
  }
  const name = meaningful
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return name.slice(0, MAX_BRAND_COLOR_NAME_LENGTH);
}

/** Hue buckets for the last-resort deterministic name. */
const HUE_NAMES: ReadonlyArray<{ maxDegrees: number; name: string }> = [
  { maxDegrees: 15, name: "Red" },
  { maxDegrees: 45, name: "Orange" },
  { maxDegrees: 70, name: "Yellow" },
  { maxDegrees: 100, name: "Lime" },
  { maxDegrees: 160, name: "Green" },
  { maxDegrees: 200, name: "Teal" },
  { maxDegrees: 250, name: "Blue" },
  { maxDegrees: 280, name: "Indigo" },
  { maxDegrees: 320, name: "Violet" },
  { maxDegrees: 345, name: "Pink" },
  { maxDegrees: 360, name: "Red" },
];

/**
 * A plain description of the color itself ("Deep Navy" territory: "Deep Blue",
 * "Pale Yellow", "Charcoal") — the final fallback when there is no declared
 * variable name and no model-proposed name. Never invents brand mythology:
 * it describes what the color IS.
 */
export function describeHexColor(hex: string): string {
  const rgb = parseHexColor(hex);
  if (rgb === null) {
    return "Brand color";
  }
  const [red, green, blue] = rgb.map((channel) => channel / 255) as [number, number, number];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const chroma = max - min;
  if (chroma < 0.08) {
    if (lightness > 0.9) return "Off White";
    if (lightness > 0.65) return "Light Gray";
    if (lightness > 0.35) return "Gray";
    if (lightness > 0.12) return "Charcoal";
    return "Near Black";
  }
  let hue: number;
  if (max === red) {
    hue = ((green - blue) / chroma) % 6;
  } else if (max === green) {
    hue = (blue - red) / chroma + 2;
  } else {
    hue = (red - green) / chroma + 4;
  }
  const degrees = ((hue * 60) % 360 + 360) % 360;
  const hueName = HUE_NAMES.find(({ maxDegrees }) => degrees <= maxDegrees)?.name ?? "Blue";
  if (lightness > 0.78) return `Pale ${hueName}`;
  if (lightness > 0.6) return `Light ${hueName}`;
  if (lightness < 0.22) return `Deep ${hueName}`;
  if (lightness < 0.4) return `Dark ${hueName}`;
  return hueName;
}

/**
 * The name a scraped color should carry, in the spec's order of preference
 * (§3.4): the model's proposal (which the prompt constrains to the declared
 * variable name or a plain color description) → the deterministic derivation
 * from the CSS custom property → a description of the color itself. There is
 * always a name; a human can always overwrite it.
 */
export function resolveBrandColorName({
  proposedName,
  variableName,
  hex,
}: {
  proposedName?: string;
  variableName?: string;
  hex: string;
}): string {
  const trimmedProposal = (proposedName ?? "").trim();
  if (trimmedProposal.length > 0) {
    return trimmedProposal.slice(0, MAX_BRAND_COLOR_NAME_LENGTH);
  }
  const derived = variableName === undefined ? null : deriveColorNameFromVariable(variableName);
  return derived ?? describeHexColor(hex);
}

/** Authored colors in panel order: category group, then orderIndex. */
export function sortBrandColorsForDisplay(colors: BrandColor[]): BrandColor[] {
  return [...colors].sort((a, b) => {
    const categoryDelta =
      BRAND_COLOR_CATEGORIES.indexOf(a.category) - BRAND_COLOR_CATEGORIES.indexOf(b.category);
    return categoryDelta !== 0 ? categoryDelta : a.orderIndex - b.orderIndex;
  });
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
// Confirmed-asset gate (owner decision 4, brand-kit architecture proposal)
// ---------------------------------------------------------------------------

/** The two confirmable brand-kit asset kinds. */
export type BrandKitAssetKind = "logo" | "socialCard";

/**
 * THE gate for reading brand assets anywhere that writes into documents
 * (Stage M: the "Logo" add-block preset, propagation re-sourcing). Returns
 * the asset URL only when it has been CONFIRMED into Convex storage — an
 * unconfirmed suggestion is a third-party hotlink and may only be previewed
 * in kit UI (owner decision 4). Do not read `brandKit.logoUrl` directly from
 * document-writing code.
 */
export function getConfirmedBrandAssetUrl({
  brandKit,
  kind,
}: {
  brandKit: BrandKit;
  kind: BrandKitAssetKind;
}): string | null {
  if (kind === "logo") {
    return brandKit.logoConfirmedAtMs !== undefined && brandKit.logoUrl !== undefined
      ? brandKit.logoUrl
      : null;
  }
  return brandKit.socialImageConfirmedAtMs !== undefined && brandKit.socialImageUrl !== undefined
    ? brandKit.socialImageUrl
    : null;
}

// ---------------------------------------------------------------------------
// Brand color palette (color-picker swatches)
// ---------------------------------------------------------------------------

/** One clickable brand swatch: a normalized color + its user-facing name. */
export interface BrandPaletteSwatch {
  /** Normalized #rrggbb. */
  color: string;
  /** Tooltip label, e.g. "Accent — Midnight". */
  label: string;
}

/** Small on purpose (owner, item 24): "the most prominent, their primary colors". */
export const MAX_BRAND_PALETTE_SWATCHES = 6;

/**
 * Which globals carry brand color, with a PROMINENCE weight: the roles a
 * brand's primary colors occupy (accent/link/heading) rank far above
 * chrome-ish roles (divider, button label). Labels are user-facing tooltip
 * words. Frequency does the rest — a color repeated across variations and
 * roles accumulates weight.
 */
const PALETTE_ROLES: ReadonlyArray<{ key: keyof GlobalStyles; label: string; weight: number }> = [
  { key: "buttonBackgroundColor", label: "Accent", weight: 5 },
  { key: "linkTextColor", label: "Link", weight: 4 },
  { key: "heading1TextColor", label: "Heading text", weight: 3 },
  { key: "heading2TextColor", label: "Heading text", weight: 2 },
  { key: "heading3TextColor", label: "Heading text", weight: 2 },
  { key: "paragraphTextColor", label: "Body text", weight: 2 },
  { key: "contentBackgroundColor", label: "Content background", weight: 2 },
  { key: "emailBackgroundColor", label: "Email background", weight: 1.5 },
  { key: "buttonTextColor", label: "Button text", weight: 1 },
  { key: "buttonBorderColor", label: "Button border", weight: 0.5 },
  { key: "dividerColor", label: "Divider", weight: 0.5 },
];

/**
 * Two colors closer than this (RGB Euclidean distance) are near-duplicates —
 * tints of the same brand color, not distinct palette entries. 36 merges
 * near-black navies with near-blacks and off-whites with whites while
 * keeping genuinely different hues apart.
 */
const NEAR_DUPLICATE_RGB_DISTANCE = 36;

/** Normalize any hex form to #rrggbb, or null for non-hex values. */
function normalizeHexColor(color: string): string | null {
  const rgb = parseHexColor(color);
  if (rgb === null) {
    return null;
  }
  return `#${rgb.map((component) => component.toString(16).padStart(2, "0")).join("")}`;
}

function getRgbDistance(colorA: string, colorB: string): number {
  const rgbA = parseHexColor(colorA);
  const rgbB = parseHexColor(colorB);
  if (rgbA === null || rgbB === null) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.hypot(rgbA[0] - rgbB[0], rgbA[1] - rgbB[1], rgbA[2] - rgbB[2]);
}

interface ScoredPaletteColor {
  color: string;
  label: string;
  /** Prominence: sum of role weights across every occurrence in the kit. */
  score: number;
  /** Weight of the occurrence that named this color (labels follow rank). */
  labelWeight: number;
}

/**
 * The kit's palette as clickable, labeled swatches — the "Brand colors" row
 * inside the color-picker popover.
 *
 * READ RULE (brand-kit-user-control §3.2): when the kit carries an AUTHORED
 * palette (`colors[]`), that palette IS the answer — verbatim names, human
 * ordering, no re-derivation and no near-duplicate merging (a human who
 * curated two close tints meant to). Only kits without one (legacy rows, the
 * mock) fall through to the derivation below, so nothing needs migrating.
 *
 * The derived path, unchanged:
 * 1. The SIGNATURE ACCENT (first variation's button background — where the
 *    scraper's accentColor lands) is always first.
 * 2. Everything else ranks by prominence: role weight × frequency across
 *    every variation's globals.
 * 3. Near-duplicate tints (small RGB distance) merge into the stronger
 *    color rather than crowding the row.
 * 4. Capped at {@link MAX_BRAND_PALETTE_SWATCHES}.
 */
export function getBrandKitPalette(brandKit: BrandKit): BrandPaletteSwatch[] {
  const authoredColors = brandKit.colors ?? [];
  if (authoredColors.length > 0) {
    return [...authoredColors]
      .sort((a, b) => {
        const categoryDelta =
          PICKER_CATEGORY_ORDER.indexOf(a.category) - PICKER_CATEGORY_ORDER.indexOf(b.category);
        return categoryDelta !== 0 ? categoryDelta : a.orderIndex - b.orderIndex;
      })
      .flatMap((color) => {
        const normalized = normalizeHexColor(color.hex);
        return normalized === null ? [] : [{ color: normalized, label: color.name }];
      })
      .slice(0, MAX_BRAND_PALETTE_SWATCHES);
  }

  // 1. Score every occurrence.
  const scoredByColor = new Map<string, ScoredPaletteColor>();
  for (const variation of brandKit.variations) {
    for (const { key, label, weight } of PALETTE_ROLES) {
      const rawValue = variation.globals[key];
      if (typeof rawValue !== "string") {
        continue;
      }
      const color = normalizeHexColor(rawValue);
      if (color === null) {
        continue;
      }
      const existing = scoredByColor.get(color);
      if (existing === undefined) {
        scoredByColor.set(color, {
          color,
          label: `${label} — ${variation.name}`,
          score: weight,
          labelWeight: weight,
        });
      } else {
        existing.score += weight;
        if (weight > existing.labelWeight) {
          existing.label = `${label} — ${variation.name}`;
          existing.labelWeight = weight;
        }
      }
    }
  }

  // 2. The signature accent pins the front of the ranking.
  const firstVariation = brandKit.variations[0];
  const signatureAccent =
    firstVariation === undefined ||
    typeof firstVariation.globals.buttonBackgroundColor !== "string"
      ? null
      : normalizeHexColor(firstVariation.globals.buttonBackgroundColor);

  const ranked = [...scoredByColor.values()].sort((a, b) => {
    if (a.color === signatureAccent) return -1;
    if (b.color === signatureAccent) return 1;
    return b.score - a.score;
  });

  // 3. Greedy near-duplicate clustering: walking in rank order, a color too
  //    close to an already-kept one is a tint of it — skipped.
  const kept: ScoredPaletteColor[] = [];
  for (const candidate of ranked) {
    if (kept.length >= MAX_BRAND_PALETTE_SWATCHES) {
      break;
    }
    const isNearDuplicate = kept.some(
      ({ color }) => getRgbDistance(color, candidate.color) < NEAR_DUPLICATE_RGB_DISTANCE,
    );
    if (!isNearDuplicate) {
      kept.push(candidate);
    }
  }
  return kept.map(({ color, label }) => ({ color, label }));
}

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

/*
  The variation a document's raw globals exactly match, or null ("Custom").

  LIVE ONLY. A draft still rendering a deleted theme's payload byte for byte
  keeps rendering it — deletion never touches a document — but it stops being
  an INSTANCE of that theme, because the theme is gone. Matching it here would
  put a deleted theme back on the dropdown's trigger label and back in
  `pickTargetVariation`, which is precisely the unlink this is supposed to be.
*/
export function findMatchingVariation({
  brandKit,
  globals,
}: {
  brandKit: BrandKit;
  globals: GlobalStyles | undefined;
}): ThemeVariation | null {
  return (
    getLiveThemeVariations(brandKit.variations).find((variation) =>
      areGlobalsEqual({ a: globals, b: variation.globals }),
    ) ?? null
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
  imageBorderRadius: 0,
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
  name: "Flock Demo Brand",
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
