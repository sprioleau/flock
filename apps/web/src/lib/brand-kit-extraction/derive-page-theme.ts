/**
 * The page's own colours and fonts, as a theme — derived from HTML that has
 * ALREADY been fetched, and WITHOUT a model call.
 *
 * WHY THIS IS NOT `generateBrandKit`. The brand-kit pipeline answers a bigger
 * question than a draft asks: it names colours ("Banana"), categorises them,
 * picks a logo, reads tone of voice, and proposes three or four alternative
 * variations. All of that is the brand-kit PANEL's value, and all of it is
 * what its one Gemini call buys. A draft built from a URL needs exactly one
 * theme — an accent, a canvas, text that reads on it, and a font — and every
 * one of those is decidable from signals `harvestBrandSignals` already
 * collects. So this path spends NO model quota, on a free tier of 15 RPM / 500
 * per day that is shared five ways with production, and on a URL draft that
 * already spends one call on the page classifier and more on the chat turn.
 *
 * The second reason is failure. `generateBrandKit` has no fallback: a 503 on
 * its one call abandons generation and the caller gets a 502. A theme that
 * cannot be derived must never fail the draft, so everything here degrades to
 * `null` — and a null theme simply leaves the draft wearing the theme it
 * already had.
 *
 * WHAT IS REUSED, rather than rewritten:
 * - `harvestBrandSignals` — the whole extractor (ranked colours with their
 *   declared CSS variable names, vibrancy-aware scoring, theme-color, font
 *   families, bounded stylesheet fetching through the SSRF-guarded fetcher).
 * - `expandSemanticVariation` — the deterministic expansion into a COMPLETE
 *   `Required<GlobalStyles>` payload plus WCAG-AA contrast repair. Contrast is
 *   computed here too, never eyeballed.
 * - `EMAIL_SAFE_FONT_OPTIONS` — the same stacks every font surface resolves to.
 *
 * WHAT IS NEW is only the ASSIGNMENT step: which harvested colour is the
 * accent, which is the canvas, which is the text. `generateBrandKit` asks a
 * model; this asks the page, using the names the page gave its own colours.
 */

import { DEFAULT_GLOBAL_STYLES, type GlobalStyles } from "@flock/email-sdk";
import { EMAIL_SAFE_FONT_OPTIONS } from "@/components/studio/text-editor/email-safe-fonts";
import type { BrandKitFonts } from "@/lib/brand-kit";
import { getChroma, getRelativeLuminance, mixHexColors } from "./color-utils";
import { expandSemanticVariation } from "./expand-variations";
import {
  ACCENT_CHROMA_THRESHOLD,
  harvestBrandSignals,
  type BrandSignals,
  type CssFetcher,
  type RankedColor,
} from "./harvest";

/** A theme the page itself supplied, ready to apply. */
export interface PageTheme {
  /**
   * The COMPLETE globals payload — the exact `applyTheme` argument. Complete
   * because `applyTheme` replaces `root.properties.globals` wholesale, so an
   * omitted key silently reverts to a renderer default.
   */
  globals: Required<GlobalStyles>;
  /**
   * One line naming the page signals this theme was built from, so the
   * behaviour explains itself instead of arriving as unattributed colour.
   */
  source: string;
}

/*
  The names a page gives its own colours are the strongest role signal there
  is, and the only one that survives a component library.

  MEASURED on sprioleau.dev: react-toastify ships its own `:root` palette
  (`--toastify-color-info/success/warning/error`), every entry as vivid as the
  brand's, and on a small site those library colours can easily be referenced
  more often than the brand accent. Frequency cannot separate them. The name
  can: `--ui-accent-1` says what it is.

  Substring matching on a CSS custom property name is NOT the keyword matching
  this codebase deleted — that was matching the USER'S SENTENCE to choose a
  pipeline before anything had been fetched. This reads a declaration the page
  author wrote, from bytes we fetched, and it decides nothing about which code
  path runs.
*/
const ACCENT_NAME_HINTS = ["accent", "brand", "primary"];
const BACKGROUND_NAME_HINTS = ["bg", "background", "surface", "canvas", "paper"];
const TEXT_NAME_HINTS = ["text", "fg", "foreground", "ink"];

function hasNameHint({
  color,
  hints,
}: {
  color: RankedColor;
  hints: readonly string[];
}): boolean {
  const name = color.variableName?.toLowerCase();
  return name !== undefined && hints.some((hint) => name.includes(hint));
}

/** A colour is "vivid" at the same threshold the harvest uses for accents. */
function isVivid(color: string): boolean {
  return (getChroma(color) ?? 0) >= ACCENT_CHROMA_THRESHOLD;
}

function isLight(color: string): boolean {
  return (getRelativeLuminance(color) ?? 1) > 0.5;
}

interface PickedColor {
  color: string;
  /** Where it came from, for the `source` line. */
  origin: string;
}

/**
 * The brand accent: the colour buttons and links take.
 *
 * Order of evidence, strongest first: a vivid colour the page NAMED as its
 * accent/brand/primary; a vivid `theme-color` meta tag; the highest-scoring
 * vivid colour on the page. No accent means no theme — one colour is a
 * background, not a visual identity.
 */
function pickAccentColor(signals: BrandSignals): PickedColor | null {
  const named = signals.accentCandidates.find((candidate) =>
    hasNameHint({ color: candidate, hints: ACCENT_NAME_HINTS }),
  );
  if (named !== undefined) {
    return { color: named.color, origin: named.variableName ?? "declared accent" };
  }
  if (signals.themeColor !== null && isVivid(signals.themeColor)) {
    return { color: signals.themeColor, origin: "theme-color" };
  }
  const [topCandidate] = signals.accentCandidates;
  return topCandidate === undefined
    ? null
    : { color: topCandidate.color, origin: topCandidate.variableName ?? "harvested palette" };
}

/**
 * The canvas the email's content sits on.
 *
 * `theme-color` is the best background signal a page gives — but ONLY when it
 * is muted. wesbos.com/about declares `theme-color: #ffc600`, a saturated
 * yellow that is plainly the brand accent, not a page background; painting an
 * email's content area in it would be unreadable, and the contrast repair
 * would then "fix" it by mixing the brand colour away to near-black.
 *
 * Null means the page gave no usable background signal, and the renderer
 * default stands. That is deliberately conservative: an email on a light
 * canvas with the brand's accent is right far more often than an email
 * repainted in whatever dark colour happened to rank.
 */
function pickBackgroundColor({
  signals,
  accent,
}: {
  signals: BrandSignals;
  accent: string;
}): PickedColor | null {
  if (signals.themeColor !== null && !isVivid(signals.themeColor) && signals.themeColor !== accent) {
    return { color: signals.themeColor, origin: "theme-color" };
  }
  const named = signals.rankedColors.find(
    (candidate) =>
      candidate.color !== accent && hasNameHint({ color: candidate, hints: BACKGROUND_NAME_HINTS }),
  );
  return named === undefined
    ? null
    : { color: named.color, origin: named.variableName ?? "harvested palette" };
}

/**
 * The body/heading text colour. A page that named a text colour gets it; the
 * rest fall back to the renderer's own pair, chosen for the canvas's
 * lightness. Either way `expandSemanticVariation` verifies and repairs the
 * result against the canvas — contrast is computed, never assumed.
 */
function pickTextColor({
  signals,
  accent,
  contentBackgroundColor,
}: {
  signals: BrandSignals;
  accent: string;
  contentBackgroundColor: string;
}): PickedColor {
  const named = signals.rankedColors.find(
    (candidate) =>
      candidate.color !== accent &&
      candidate.color !== contentBackgroundColor &&
      hasNameHint({ color: candidate, hints: TEXT_NAME_HINTS }),
  );
  if (named !== undefined) {
    return { color: named.color, origin: named.variableName ?? "harvested palette" };
  }
  return isLight(contentBackgroundColor)
    ? { color: DEFAULT_GLOBAL_STYLES.paragraphTextColor, origin: "renderer default" }
    : { color: "#ffffff", origin: "derived from a dark canvas" };
}

/*
  Family name → the closest email-safe stack. Web fonts do not ship in email,
  so this is the same mapping generate-brand-kit.ts asks its model to make,
  written out: geometric/grotesque sans → Helvetica, humanist sans → Verdana /
  Tahoma / Trebuchet, serif → Georgia, monospace → Courier New.

  Matched on substrings of the declared family name because that is all a page
  gives us. Anything unrecognised lands on Helvetica, which is the SDK's own
  default stack — an unknown font changes nothing rather than guessing wrong.
*/
const MONOSPACE_HINTS = ["mono", "code", "courier", "consol"];
const SERIF_HINTS = [
  "serif",
  "georgia",
  "times",
  "garamond",
  "baskerville",
  "playfair",
  "merriweather",
  "lora",
  "quando",
  "slab",
  "didot",
  "bodoni",
  "caslon",
];
const HUMANIST_SANS_LABELS: Record<string, string> = {
  verdana: "Verdana",
  tahoma: "Tahoma",
  trebuchet: "Trebuchet MS",
  arial: "Arial",
};

function findFontStack(label: string): string {
  const option = EMAIL_SAFE_FONT_OPTIONS.find((candidate) => candidate.label === label);
  return option?.value ?? EMAIL_SAFE_FONT_OPTIONS[0].value;
}

function toEmailSafeStack(family: string): string {
  const name = family.toLowerCase();
  if (MONOSPACE_HINTS.some((hint) => name.includes(hint))) {
    return findFontStack("Courier New");
  }
  if (SERIF_HINTS.some((hint) => name.includes(hint))) {
    return findFontStack("Georgia");
  }
  const humanist = Object.entries(HUMANIST_SANS_LABELS).find(([hint]) => name.includes(hint));
  return findFontStack(humanist === undefined ? "Helvetica" : humanist[1]);
}

/**
 * The page's font, for headings and body alike.
 *
 * ONE family on purpose. `harvestBrandSignals` reports the families a page
 * declares, in the order it declared them, with no notion of which one its
 * headings use — so splitting the list into a heading font and a body font
 * would be a coin flip dressed as extraction. Taking the leading family for
 * both is what the page actually gives us. A page whose only family is a
 * monospace (a code-heavy site) keeps the renderer default for body text
 * rather than setting an email in Courier.
 */
function pickFonts(signals: BrandSignals): { fonts: BrandKitFonts; origin: string | null } {
  const [family] = signals.fontFamilies;
  if (family === undefined) {
    return {
      fonts: {
        heading: DEFAULT_GLOBAL_STYLES.heading1FontFamily,
        body: DEFAULT_GLOBAL_STYLES.paragraphFontFamily,
      },
      origin: null,
    };
  }
  const stack = toEmailSafeStack(family);
  return { fonts: { heading: stack, body: stack }, origin: family };
}

/**
 * A canvas that sits behind the content area — the page background nudged
 * slightly darker, so the email reads as a card on a surface rather than as
 * one flat field. Skipped entirely when the page gave no background.
 */
function deriveEmailBackgroundColor(contentBackgroundColor: string): string {
  return mixHexColors({ base: contentBackgroundColor, target: "#000000", amount: 0.12 });
}

export interface DerivePageThemeInput {
  /** The page's HTML — ALREADY FETCHED by the caller. Never re-fetched here. */
  html: string;
  /** The URL after redirects; relative stylesheet hrefs resolve against it. */
  finalUrl: string;
  /**
   * Stylesheet fetcher, injected exactly as `harvestBrandSignals` takes it.
   * Null skips external CSS entirely — which, measured on both judged pages,
   * costs the whole palette and every font (see derive-page-theme.test.ts).
   */
  fetchCss: CssFetcher | null;
}

/**
 * Derive the page's theme, or null.
 *
 * NULL IS A NORMAL ANSWER, not an error: it means the page gave nothing worth
 * applying, and the draft keeps the theme it already had. Nothing here throws.
 */
export async function derivePageTheme({
  html,
  finalUrl,
  fetchCss,
}: DerivePageThemeInput): Promise<PageTheme | null> {
  let signals: BrandSignals;
  try {
    signals = await harvestBrandSignals({
      html,
      finalUrl,
      /*
        Auxiliary fetches fail SOFT. `fetchTextResource` already returns null
        for an unreachable stylesheet, but an injected fetcher that REJECTS
        would otherwise reject the whole Promise.all inside the harvest and
        cost a page its theme over one dead CDN link.
      */
      fetchCss: fetchCss === null ? null : (url) => fetchCss(url).catch(() => null),
    });
  } catch {
    return null;
  }

  const accent = pickAccentColor(signals);
  if (accent === null) {
    return null;
  }
  const background = pickBackgroundColor({ signals, accent: accent.color });
  const contentBackgroundColor =
    background?.color ?? DEFAULT_GLOBAL_STYLES.contentBackgroundColor;
  const text = pickTextColor({ signals, accent: accent.color, contentBackgroundColor });
  const { fonts, origin: fontOrigin } = pickFonts(signals);

  const variation = expandSemanticVariation({
    semantic: {
      name: signals.siteName ?? signals.pageTitle ?? finalUrl,
      emailBackgroundColor:
        background === null
          ? DEFAULT_GLOBAL_STYLES.emailBackgroundColor
          : deriveEmailBackgroundColor(contentBackgroundColor),
      contentBackgroundColor,
      accentColor: accent.color,
      headingTextColor: text.color,
      paragraphTextColor: text.color,
    },
    fonts,
    /*
      The shape is a placeholder: nothing harvested tells us what the page's
      buttons look like, so the radius is put straight back to the renderer
      default below. Guessing at a shape would restyle a draft on no evidence —
      the same stance expand-variations.ts already takes for imageBorderRadius.
    */
    buttonShape: "rounded",
  });
  if (variation === null) {
    return null;
  }

  const globals: Required<GlobalStyles> = {
    ...variation.globals,
    buttonBorderRadius: DEFAULT_GLOBAL_STYLES.buttonBorderRadius,
  };

  const sourceParts = [
    `accent ${accent.color} (${accent.origin})`,
    background === null
      ? "background left at the email default (the page named none)"
      : `background ${background.color} (${background.origin})`,
    `text ${text.color} (${text.origin})`,
    fontOrigin === null ? "fonts left at the email default" : `font ${fontOrigin}`,
  ];

  return { globals, source: sourceParts.join(", ") };
}
