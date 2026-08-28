/**
 * Deterministic brand-signal harvesting — no LLM, no rendering. Regex-scale
 * scanning of the fetched HTML (plus a bounded number of same-origin
 * stylesheets) for candidate brand signals:
 *
 * - site identity: <title>, og:site_name
 * - <meta name="theme-color">
 * - font families: Google Fonts <link>s + font-family declarations in CSS
 * - colors: hex/rgb() tokens across inline styles, <style> blocks and
 *   fetched CSS, frequency-ranked, near-white/near-black noise filtered
 * - logo candidates: header/nav <img> with logo-ish hints, favicons,
 *   apple-touch-icon, og:image
 *
 * This is honest signal harvesting for the LLM step — every color and URL in
 * the output was literally present in the page's markup/CSS. Nothing here is
 * invented.
 */

import { getChroma, isNearBlack, isNearWhite, normalizeCssColor } from "./color-utils";
import { findMetaContent, findPageTitle, findTags, getAttribute, resolveUrl } from "./html-utils";

export interface LogoCandidate {
  /** Absolute URL. */
  url: string;
  /** Where it came from ("header img alt=…", "apple-touch-icon", …). */
  hint: string;
}

export interface RankedColor {
  color: string;
  /** Effective usage count: raw occurrences + var(--…) references. */
  count: number;
  /**
   * The CSS custom property this color was declared as (e.g. "--ui-accent-1"),
   * when it was — a strong brand-role hint passed through to the model.
   */
  variableName: string | null;
}

export interface BrandSignals {
  siteName: string | null;
  pageTitle: string | null;
  themeColor: string | null;
  /** Distinct font family names seen in CSS / Google Fonts links. */
  fontFamilies: string[];
  /**
   * Normalized #rrggbb colors, noise filtered, ordered by a vibrancy-boosted
   * usage score (NOT raw frequency — signature accents are used sparingly).
   */
  rankedColors: RankedColor[];
  /**
   * The high-chroma subset of rankedColors — likely signature accents. Kept
   * as a separate list so the model is explicitly pointed at them.
   */
  accentCandidates: RankedColor[];
  logoCandidates: LogoCandidate[];
}

const MAX_STYLESHEETS = 3;
const MAX_RANKED_COLORS = 24;
const MAX_FONT_FAMILIES = 12;
const MAX_LOGO_CANDIDATES = 8;

/** Injectable stylesheet fetcher so fixture tests never hit the network. */
export type CssFetcher = (url: string) => Promise<string | null>;

// HTML scanning helpers (findTags/getAttribute/findMetaContent/…) live in
// html-utils.ts — shared with the deterministic site-identity extractor.

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

const GENERIC_FONT_KEYWORDS = new Set([
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "inherit",
  "initial",
  "unset",
  "emoji",
  "math",
  "-apple-system",
  "blinkmacsystemfont",
]);

function isIconOrSystemFont(family: string): boolean {
  const lower = family.toLowerCase();
  return (
    GENERIC_FONT_KEYWORDS.has(lower) ||
    lower.includes("icon") ||
    lower.includes("awesome") ||
    lower.includes("emoji") ||
    lower.startsWith("var(")
  );
}

function harvestGoogleFontFamilies({ html, baseUrl }: { html: string; baseUrl: string }): string[] {
  const families: string[] = [];
  for (const tag of findTags({ html, tagName: "link" })) {
    const href = getAttribute({ tag, name: "href" });
    if (href === null) {
      continue;
    }
    const resolved = resolveUrl({ raw: href, baseUrl });
    if (resolved === null || !resolved.includes("fonts.googleapis.com")) {
      continue;
    }
    try {
      const url = new URL(resolved);
      for (const familyParam of url.searchParams.getAll("family")) {
        for (const familySpec of familyParam.split("|")) {
          const familyName = familySpec.split(":")[0].replace(/\+/g, " ").trim();
          if (familyName.length > 0) {
            families.push(familyName);
          }
        }
      }
    } catch {
      // Malformed URL — skip.
    }
  }
  return families;
}

function harvestFontFamiliesFromCss(cssText: string): string[] {
  const families: string[] = [];
  const declarations = cssText.match(/font-family\s*:\s*[^;}"']{0,200}[^;}]*/gi) ?? [];
  for (const declaration of declarations) {
    const value = declaration.replace(/font-family\s*:\s*/i, "");
    // First family in the stack is the intent; the rest are fallbacks.
    const first = value.split(",")[0].trim().replace(/^["']|["']$/g, "");
    if (first.length > 1 && first.length < 50 && !isIconOrSystemFont(first)) {
      families.push(first);
    }
  }
  return families;
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

function harvestColorTokens(cssOrHtml: string): string[] {
  const tokens =
    cssOrHtml.match(
      /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([\d\s.,%]{5,40}\)|hsla?\([\d\s.,%deg/]{5,40}\)/gi,
    ) ?? [];
  const normalized: string[] = [];
  for (const token of tokens) {
    const color = normalizeCssColor(token);
    if (color !== null) {
      normalized.push(color);
    }
  }
  return normalized;
}

interface CustomPropertyColor {
  variableName: string;
  color: string;
  /** How many times `var(--name)` is used across the scanned text. */
  referenceCount: number;
}

const MAX_CUSTOM_PROPERTIES = 200;

/**
 * CSS custom properties that hold a color, with their var() reference counts.
 * This is how design-system sites actually express their palette: the brand
 * accent is DECLARED once (`--ui-accent-1: #ffc400`) and referenced dozens of
 * times via var() — invisible to raw color-token frequency. The reference
 * count restores the color's true weight, and the variable name itself
 * ("accent", "brand", …) is a role hint for the model.
 */
function harvestCustomPropertyColors(text: string): CustomPropertyColor[] {
  const definitions =
    text.match(
      /--[a-zA-Z0-9_-]+\s*:\s*(?:#[0-9a-f]{3,6}\b|rgba?\([\d\s.,%]{5,40}\)|hsla?\([\d\s.,%deg/]{5,40}\))/gi,
    ) ?? [];
  const results: CustomPropertyColor[] = [];
  const seenNames = new Set<string>();
  for (const definition of definitions.slice(0, MAX_CUSTOM_PROPERTIES)) {
    const [rawName, ...valueParts] = definition.split(":");
    const variableName = rawName.trim();
    const color = normalizeCssColor(valueParts.join(":"));
    if (color === null || seenNames.has(variableName)) {
      continue;
    }
    seenNames.add(variableName);
    // Bounded count of `var(--name)` / `var(--name,` occurrences.
    const referencePattern = new RegExp(
      `var\\(\\s*${variableName.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\s*[,)]`,
      "g",
    );
    const referenceCount = (text.match(referencePattern) ?? []).length;
    results.push({ variableName, color, referenceCount });
  }
  return results;
}

/** Chroma at or above this marks a color as a potential signature accent. */
export const ACCENT_CHROMA_THRESHOLD = 0.35;
const MAX_ACCENT_CANDIDATES = 6;

/**
 * Rank colors by a vibrancy-boosted usage score. Two deliberate departures
 * from raw frequency (both learned from real sites):
 * - custom-property var() references count as uses (see above);
 * - score = count × (1 + 2 × chroma): brand accents are low-frequency,
 *   high-saturation colors, so a vivid yellow seen 3× outranks a gray
 *   seen 40×. Raw frequency buried exactly the colors that matter.
 */
function rankColors({
  colors,
  customPropertyColors,
}: {
  colors: string[];
  customPropertyColors: CustomPropertyColor[];
}): { rankedColors: RankedColor[]; accentCandidates: RankedColor[] } {
  const counts = new Map<string, number>();
  for (const color of colors) {
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  const variableNames = new Map<string, string>();
  for (const { variableName, color, referenceCount } of customPropertyColors) {
    counts.set(color, (counts.get(color) ?? 0) + referenceCount);
    // Keep the most-referenced variable name per color.
    const existing = customPropertyColors.find(
      (candidate) => candidate.variableName === variableNames.get(color),
    );
    if (existing === undefined || referenceCount > existing.referenceCount) {
      variableNames.set(color, variableName);
    }
  }
  const scored = [...counts.entries()]
    .filter(([color]) => !isNearWhite(color) && !isNearBlack(color))
    .map(([color, count]) => {
      const chroma = getChroma(color) ?? 0;
      return {
        color,
        count,
        variableName: variableNames.get(color) ?? null,
        chroma,
        score: count * (1 + 2 * chroma),
      };
    })
    .sort((a, b) => b.score - a.score);
  const rankedColors = scored
    .slice(0, MAX_RANKED_COLORS)
    .map(({ color, count, variableName }) => ({ color, count, variableName }));
  const accentCandidates = scored
    .filter(({ chroma }) => chroma >= ACCENT_CHROMA_THRESHOLD)
    .slice(0, MAX_ACCENT_CANDIDATES)
    .map(({ color, count, variableName }) => ({ color, count, variableName }));
  return { rankedColors, accentCandidates };
}

// ---------------------------------------------------------------------------
// Logos
// ---------------------------------------------------------------------------

function harvestLogoCandidates({
  html,
  baseUrl,
}: {
  html: string;
  baseUrl: string;
}): LogoCandidate[] {
  const candidates: LogoCandidate[] = [];
  const seenUrls = new Set<string>();
  const push = ({ raw, hint }: { raw: string | null; hint: string }) => {
    if (raw === null) {
      return;
    }
    const url = resolveUrl({ raw, baseUrl });
    if (url !== null && !seenUrls.has(url)) {
      seenUrls.add(url);
      candidates.push({ url, hint });
    }
  };

  // <img> with logo-ish src/class/id, or a SHORT alt naming the logo (long
  // alt sentences that merely mention "logo" are photos, not logos).
  for (const tag of findTags({ html, tagName: "img" })) {
    const src = getAttribute({ tag, name: "src" });
    const alt = getAttribute({ tag, name: "alt" }) ?? "";
    const className = getAttribute({ tag, name: "class" }) ?? "";
    const id = getAttribute({ tag, name: "id" }) ?? "";
    const attributeHaystack = `${src ?? ""} ${className} ${id}`.toLowerCase();
    const isLogoish =
      attributeHaystack.includes("logo") ||
      (alt.toLowerCase().includes("logo") && alt.length <= 50);
    if (isLogoish) {
      push({ raw: src, hint: `img${alt.length > 0 ? ` alt="${alt.slice(0, 60)}"` : ""}` });
    }
  }
  // Icon links (favicon / apple-touch-icon) and og:image as weaker fallbacks.
  for (const tag of findTags({ html, tagName: "link" })) {
    const rel = (getAttribute({ tag, name: "rel" }) ?? "").toLowerCase();
    if (rel.includes("icon")) {
      push({ raw: getAttribute({ tag, name: "href" }), hint: rel });
    }
  }
  push({ raw: findMetaContent({ html, key: "og:image" }), hint: "og:image" });

  return candidates.slice(0, MAX_LOGO_CANDIDATES);
}

// ---------------------------------------------------------------------------
// Stylesheets
// ---------------------------------------------------------------------------

/**
 * Linked stylesheet URLs, same-origin ones first (most likely to be the
 * site's own styles), then cross-origin (modern sites serve their CSS from
 * CDNs — e.g. stripe.com's styles live on b.stripecdn.com). Every fetch
 * still goes through the SSRF guard and byte caps in fetch-page.ts.
 */
function findStylesheetUrls({ html, baseUrl }: { html: string; baseUrl: string }): string[] {
  const pageOrigin = new URL(baseUrl).origin;
  const sameOriginUrls: string[] = [];
  const crossOriginUrls: string[] = [];
  for (const tag of findTags({ html, tagName: "link" })) {
    const rel = (getAttribute({ tag, name: "rel" }) ?? "").toLowerCase();
    if (!rel.split(/\s+/).includes("stylesheet")) {
      continue;
    }
    const href = getAttribute({ tag, name: "href" });
    if (href === null) {
      continue;
    }
    const resolved = resolveUrl({ raw: href, baseUrl });
    // Google Fonts CSS is skipped — families are parsed from its URL instead.
    if (resolved === null || resolved.includes("fonts.googleapis.com")) {
      continue;
    }
    (new URL(resolved).origin === pageOrigin ? sameOriginUrls : crossOriginUrls).push(resolved);
  }
  return [...sameOriginUrls, ...crossOriginUrls].slice(0, MAX_STYLESHEETS);
}

function extractInlineCss(html: string): string {
  const styleBlocks = html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? [];
  const styleAttributes = html.match(/\bstyle\s*=\s*("[^"]{0,500}"|'[^']{0,500}')/gi) ?? [];
  return `${styleBlocks.join("\n")}\n${styleAttributes.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Harvest brand signals from a fetched page. `fetchCss` is injected by the
 * caller (the pipeline passes the guarded `fetchTextResource`; tests pass a
 * stub) — pass `null` to skip stylesheet fetching entirely.
 */
export async function harvestBrandSignals({
  html,
  finalUrl,
  fetchCss,
}: {
  html: string;
  finalUrl: string;
  fetchCss: CssFetcher | null;
}): Promise<BrandSignals> {
  const inlineCss = extractInlineCss(html);
  const externalCssTexts: string[] = [];
  if (fetchCss !== null) {
    const stylesheetUrls = findStylesheetUrls({ html, baseUrl: finalUrl });
    const fetched = await Promise.all(stylesheetUrls.map((url) => fetchCss(url)));
    for (const cssText of fetched) {
      if (cssText !== null) {
        externalCssTexts.push(cssText);
      }
    }
  }
  const allCss = [inlineCss, ...externalCssTexts].join("\n");

  const fontFamilies = [
    ...harvestGoogleFontFamilies({ html, baseUrl: finalUrl }),
    ...harvestFontFamiliesFromCss(allCss),
  ];
  const uniqueFontFamilies = [...new Set(fontFamilies)].slice(0, MAX_FONT_FAMILIES);

  const themeColorRaw = findMetaContent({ html, key: "theme-color" });
  const themeColor = themeColorRaw === null ? null : normalizeCssColor(themeColorRaw);

  // Colors are scanned across the WHOLE document plus external CSS — brand
  // colors frequently live outside <style> blocks (inline SVG fills, style
  // attributes, framework-inlined props). <style> blocks are part of html.
  const documentAndCss = [html, ...externalCssTexts].join("\n");
  const { rankedColors, accentCandidates } = rankColors({
    colors: [
      ...(themeColor === null ? [] : [themeColor]),
      ...harvestColorTokens(documentAndCss),
    ],
    customPropertyColors: harvestCustomPropertyColors(documentAndCss),
  });

  return {
    siteName: findMetaContent({ html, key: "og:site_name" }),
    pageTitle: findPageTitle(html),
    themeColor,
    fontFamilies: uniqueFontFamilies,
    rankedColors,
    accentCandidates,
    logoCandidates: harvestLogoCandidates({ html, baseUrl: finalUrl }),
  };
}
