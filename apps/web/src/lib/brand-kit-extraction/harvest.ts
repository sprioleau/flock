/*
  Deterministic brand-signal harvesting — no LLM, no rendering. Regex-scale
  scanning of the fetched HTML (plus a bounded number of same-origin
  stylesheets) for candidate brand signals:

  - site identity: <title>, og:site_name
  - <meta name="theme-color">
  - font families: Google Fonts <link>s + font-family declarations in CSS
  - colors: hex/rgb() tokens across inline styles, <style> blocks and
    fetched CSS, frequency-ranked, near-white/near-black noise filtered
  - logo candidates: header/nav <img> with logo-ish hints, favicons,
    apple-touch-icon, og:image

  This is honest signal harvesting for the LLM step — every color and URL in
  the output was literally present in the page's markup/CSS. Nothing here is
  invented.
*/

import { getChroma, isNearBlack, isNearWhite, normalizeCssColor } from "./color-utils";
import { findMetaContent, findPageTitle, findTags, getAttribute, resolveUrl } from "./html-utils";

export interface LogoCandidate {
  /*
    Absolute URL.
  */
  url: string;
  /*
    Where it came from ("header img alt=…", "apple-touch-icon", …).
  */
  hint: string;
}

export interface RankedColor {
  color: string;
  /*
    Effective usage count: raw occurrences + var(--…) references.
  */
  count: number;
  /*
    The CSS custom property this color was declared as (e.g. "--ui-accent-1"),
    when it was — a strong brand-role hint passed through to the model.
  */
  variableName: string | null;
}

export interface BrandSignals {
  siteName: string | null;
  pageTitle: string | null;
  themeColor: string | null;
  /*
    Distinct font family names seen in CSS / Google Fonts links.
  */
  fontFamilies: string[];
  /*
    Normalized #rrggbb colors, noise filtered, ordered by a vibrancy-boosted
    usage score (NOT raw frequency — signature accents are used sparingly).
  */
  rankedColors: RankedColor[];
  /*
    The high-chroma subset of rankedColors — likely signature accents. Kept
    as a separate list so the model is explicitly pointed at them.
  */
  accentCandidates: RankedColor[];
  logoCandidates: LogoCandidate[];
}

const MAX_STYLESHEETS = 3;
const MAX_RANKED_COLORS = 24;
const MAX_FONT_FAMILIES = 12;
const MAX_LOGO_CANDIDATES = 8;

/*
  Injectable stylesheet fetcher so fixture tests never hit the network.
*/
export type CssFetcher = (url: string) => Promise<string | null>;

/*
  HTML scanning helpers (findTags/getAttribute/findMetaContent/…) live in
  html-utils.ts — shared with the deterministic site-identity extractor.
*/

/*
  ---------------------------------------------------------------------------
  Fonts
  ---------------------------------------------------------------------------
*/

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
      /*
        Malformed URL — skip.
      */
    }
  }
  return families;
}

function harvestFontFamiliesFromCss(cssText: string): string[] {
  const families: string[] = [];
  const declarations = cssText.match(/font-family\s*:\s*[^;}"']{0,200}[^;}]*/gi) ?? [];
  for (const declaration of declarations) {
    const value = declaration.replace(/font-family\s*:\s*/i, "");
    /*
      First family in the stack is the intent; the rest are fallbacks.
    */
    const first = value.split(",")[0].trim().replace(/^["']|["']$/g, "");
    if (first.length > 1 && first.length < 50 && !isIconOrSystemFont(first)) {
      families.push(first);
    }
  }
  return families;
}

/*
  ---------------------------------------------------------------------------
  Colors
  ---------------------------------------------------------------------------
*/

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

interface CssRule {
  selector: string;
  declarations: string;
  atRuleContext: string[];
}

interface MarkupSelectors {
  classNames: Set<string>;
  idNames: Set<string>;
  tagNames: Set<string>;
}

/*
  The old extractor scanned the entire HTML document. That made colors in
  scripts, source maps, unused framework rules, and hover/gradient states look
  like rendered brand signals. Keep a small CSS parser here instead of adding
  a dependency to the ingestion path: it only needs selectors, declarations,
  and nested at-rule boundaries.
*/
function findClosingBrace(text: string, openingIndex: number): number {
  let depth = 1;
  for (let index = openingIndex + 1; index < text.length; index += 1) {
    if (text[index] === "{") {
      depth += 1;
    } else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return text.length;
}

function parseCssRules(cssText: string): CssRule[] {
  const text = cssText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<\/?style\b[^>]*>/gi, "");
  const rules: CssRule[] = [];
  function visit({ start, end, atRuleContext }: { start: number; end: number; atRuleContext: string[] }): void {
    let cursor = start;
    while (cursor < end) {
      const opening = text.indexOf("{", cursor);
      if (opening < 0 || opening >= end) {
        return;
      }
      const closing = Math.min(findClosingBrace(text, opening), end - 1);
      const prelude = text.slice(cursor, opening).trim();
      const body = text.slice(opening + 1, closing);
      if (prelude.startsWith("@")) {
        visit({ start: opening + 1, end: closing, atRuleContext: [...atRuleContext, prelude.toLowerCase()] });
      } else if (body.includes("{")) {
        visit({ start: opening + 1, end: closing, atRuleContext });
      } else if (prelude.length > 0) {
        rules.push({ selector: prelude, declarations: body, atRuleContext });
      }
      cursor = closing + 1;
    }
  }
  visit({ start: 0, end: text.length, atRuleContext: [] });
  return rules;
}

function collectMarkupSelectors(html: string): MarkupSelectors {
  const classNames = new Set<string>();
  const idNames = new Set<string>();
  const tagNames = new Set<string>();
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const [, tagName, attributes = ""] = match;
    tagNames.add(tagName.toLowerCase());
    const classValue = attributes.match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2] ?? "";
    for (const className of classValue.split(/\s+/).filter(Boolean)) {
      classNames.add(className);
    }
    const idValue = attributes.match(/\bid\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (idValue !== undefined) {
      idNames.add(idValue);
    }
  }
  return { classNames, idNames, tagNames };
}

const STATE_SELECTOR_PATTERN = /:(?:hover|focus|focus-visible|active|visited|target|checked|disabled|enabled|selected)\b/i;
const SYNTAX_SELECTOR_PATTERN = /(?:\.token\b|\.hljs\b|\.prism\b|\bsyntax(?:-|\b)|\bhighlight(?:-|\b)|\blanguage-[\w-]+)/i;
const HIDDEN_SELECTOR_PATTERN = /(?:\[hidden\]|\bhidden\b|aria-hidden\s*=\s*["']?true)/i;

function isPotentiallyVisibleSelector({
  selector,
  atRuleContext,
  markup,
}: {
  selector: string;
  atRuleContext: string[];
  markup: MarkupSelectors;
}): boolean {
  const normalized = selector.trim();
  if (
    normalized.length === 0 ||
    STATE_SELECTOR_PATTERN.test(normalized) ||
    SYNTAX_SELECTOR_PATTERN.test(normalized) ||
    HIDDEN_SELECTOR_PATTERN.test(normalized) ||
    atRuleContext.some((context) => /keyframes|property|font-face/i.test(context))
  ) {
    return false;
  }
  const selectors = normalized.split(",");
  return selectors.some((candidate) => {
    const classes = [...candidate.matchAll(/\.([a-z_][\w-]*)/gi)].map((match) => match[1]);
    const ids = [...candidate.matchAll(/#([a-z_][\w-]*)/gi)].map((match) => match[1]);
    if (classes.length > 0 || ids.length > 0) {
      return (
        classes.some((className) => markup.classNames.has(className)) ||
        ids.some((idName) => markup.idNames.has(idName))
      );
    }
    const element = candidate.match(/^\s*([a-z][a-z0-9-]*)\b/i)?.[1]?.toLowerCase();
    return element === undefined || element === "root" || markup.tagNames.has(element);
  });
}

const COLOR_PROPERTY_PATTERN = /^(?:accent-color|background(?:-color)?|border(?:-\w+)?|caret-color|color|column-rule(?:-color)?|fill|outline(?:-color)?|stroke|text-decoration-color|text-emphasis-color|text-shadow)$/i;

function extractDeclarations(declarations: string): Array<{ property: string; value: string }> {
  return [...declarations.matchAll(/((?:--)?[a-z][\w-]*)\s*:\s*([^;}]*)/gi)].map((match) => ({
    property: match[1].toLowerCase(),
    value: match[2],
  }));
}

interface CustomPropertyColor {
  variableName: string;
  color: string;
  /*
    How many times `var(--name)` is used in eligible declarations.
  */
  referenceCount: number;
}

interface VisibleColorSignals {
  colors: string[];
  customPropertyColors: CustomPropertyColor[];
}

function extractInlineStyleAttributes(html: string): string[] {
  return [...html.matchAll(/\bstyle\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2]);
}

function extractInlineSvgColors(html: string): string[] {
  const colors: string[] = [];
  for (const tag of html.matchAll(/<(?:svg|path|circle|ellipse|rect|line|polyline|polygon)\b[^>]*>/gi)) {
    for (const attribute of tag[0].matchAll(/\b(?:fill|stroke|color)\s*=\s*(["'])(.*?)\1/gi)) {
      colors.push(...harvestColorTokens(attribute[2]));
    }
  }
  return colors;
}

function extractVisibleColorSignals({ html, cssText }: { html: string; cssText: string }): VisibleColorSignals {
  const markup = collectMarkupSelectors(html);
  const colors: string[] = [];
  const definitions = new Map<string, { color: string; referenceCount: number }>();
  const visibleReferences = new Map<string, number>();
  const consumeDeclarations = ({
    declarations,
    shouldCountReferences,
    shouldCountColors,
  }: {
    declarations: string;
    shouldCountReferences: boolean;
    shouldCountColors: boolean;
  }): void => {
    for (const { property, value } of extractDeclarations(declarations)) {
      if (property.startsWith("--")) {
        const color = normalizeCssColor(value);
        if (shouldCountReferences && color !== null && !definitions.has(property)) {
          definitions.set(property, { color, referenceCount: 0 });
        }
        continue;
      }
      if (!COLOR_PROPERTY_PATTERN.test(property) || /(?:gradient|url\s*\()/i.test(value)) {
        continue;
      }
      const references = [...value.matchAll(/var\(\s*(--[a-z0-9_-]+)/gi)].map((match) => match[1]);
      if (shouldCountReferences) {
        for (const variableName of references) {
          visibleReferences.set(variableName, (visibleReferences.get(variableName) ?? 0) + 1);
        }
      }
      if (!shouldCountColors) {
        continue;
      }
      colors.push(...harvestColorTokens(value));
    }
  };

  for (const rule of parseCssRules(cssText)) {
    const isVisibleRule = isPotentiallyVisibleSelector({
      selector: rule.selector,
      atRuleContext: rule.atRuleContext,
      markup,
    });
    const isRootRule = /^\s*:root(?:\b|\s|$)/i.test(rule.selector);
    if (!isVisibleRule && !isRootRule) {
      continue;
    }
    const declarations = extractDeclarations(rule.declarations);
    if (declarations.some(({ property, value }) => property === "display" && value.trim() === "none")) {
      continue;
    }
    if (declarations.some(({ property, value }) => property === "visibility" && value.trim() === "hidden")) {
      continue;
    }
    if (declarations.some(({ property, value }) => property === "opacity" && value.trim() === "0")) {
      continue;
    }
    consumeDeclarations({
      declarations: rule.declarations,
      shouldCountReferences: true,
      shouldCountColors: isVisibleRule,
    });
  }
  for (const styleAttribute of extractInlineStyleAttributes(html)) {
    consumeDeclarations({ declarations: styleAttribute, shouldCountReferences: true, shouldCountColors: true });
  }
  colors.push(...extractInlineSvgColors(html));

  const customPropertyColors = [...definitions.entries()]
    .map(([variableName, definition]) => ({
      variableName,
      color: definition.color,
      referenceCount:
        (visibleReferences.get(variableName) ?? 0) > 0
          ? (visibleReferences.get(variableName) ?? 0) + 1
          : 0,
    }))
    .filter(({ referenceCount }) => referenceCount > 0);
  return { colors, customPropertyColors };
}

/*
  Chroma at or above this marks a color as a potential signature accent.
*/
export const ACCENT_CHROMA_THRESHOLD = 0.35;
const MAX_ACCENT_CANDIDATES = 6;

/*
  Rank colors by a vibrancy-boosted usage score. Custom-property references
  count as uses, while visible declarations are the only direct color input.
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
    /*
      Keep the most-referenced variable name per color.
    */
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

/*
  ---------------------------------------------------------------------------
  Logos
  ---------------------------------------------------------------------------
*/

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

  /*
    <img> with logo-ish src/class/id, or a SHORT alt naming the logo (long
    alt sentences that merely mention "logo" are photos, not logos).
  */
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
  /*
    Icon links (favicon / apple-touch-icon) and og:image as weaker fallbacks.
  */
  for (const tag of findTags({ html, tagName: "link" })) {
    const rel = (getAttribute({ tag, name: "rel" }) ?? "").toLowerCase();
    if (rel.includes("icon")) {
      push({ raw: getAttribute({ tag, name: "href" }), hint: rel });
    }
  }
  push({ raw: findMetaContent({ html, key: "og:image" }), hint: "og:image" });

  return candidates.slice(0, MAX_LOGO_CANDIDATES);
}

/*
  ---------------------------------------------------------------------------
  Stylesheets
  ---------------------------------------------------------------------------
*/

/*
  Linked stylesheet URLs, same-origin ones first (most likely to be the
  site's own styles), then cross-origin (modern sites serve their CSS from
  CDNs — e.g. stripe.com's styles live on b.stripecdn.com). Every fetch
  still goes through the SSRF guard and byte caps in fetch-page.ts.
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
    /*
      Google Fonts CSS is skipped — families are parsed from its URL instead.
    */
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

/*
  ---------------------------------------------------------------------------
  Entry point
  ---------------------------------------------------------------------------
*/

/*
  Harvest brand signals from a fetched page. `fetchCss` is injected by the
  caller (the pipeline passes the guarded `fetchTextResource`; tests pass a
  stub) — pass `null` to skip stylesheet fetching entirely.
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

  /*
  Colors are scanned from visible CSS declarations, inline SVG presentation
  attributes, and style attributes. This deliberately excludes script text,
  source maps, and non-content states from the brand palette.
  */
  const visibleColorSignals = extractVisibleColorSignals({ html, cssText: allCss });
  const { rankedColors, accentCandidates } = rankColors({
    colors: [
      ...(themeColor === null ? [] : [themeColor]),
      ...visibleColorSignals.colors,
    ],
    customPropertyColors: visibleColorSignals.customPropertyColors,
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
