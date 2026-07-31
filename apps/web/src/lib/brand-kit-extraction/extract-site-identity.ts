/**
 * Deterministic site-identity extraction — logo, company name, social card.
 * Pure head-first HTML parsing, NO LLM (owner decision: "the HTML <head> is
 * AUTHORITATIVE — if the author included meta tags, those are the things
 * they want to convey"). Runs on the already-fetched page; nothing here
 * fetches anything.
 *
 * Logo priority ladder (first hit wins):
 *   1. <meta property="og:logo">
 *   2. JSON-LD Organization.logo (string | ImageObject)
 *   3. <link rel*="icon"> family — SVG assets preferred, then
 *      apple-touch-icon, then other icons by declared size
 *   4. Body fallback: header/nav/menu masthead scan for a logo-looking
 *      <img> (alt/class/src/id containing "logo") or inline <svg>; a bare
 *      first masthead image/svg is the last resort. Inline SVG is
 *      serialized and returned as a data: URI so it renders in an <img>.
 *
 * Company-name ladder: og:site_name → JSON-LD Organization.name → cleaned
 * <title> ("CNN — Breaking News…" → "CNN").
 *
 * Social card: the og:image URL is captured as metadata — owner-explicit
 * scope: the logo and the social-card URL only, never content images.
 *
 * Every emitted URL passes the same SSRF syntax guard as the page fetch, so
 * a page can never plant a private-network URL on the brand-kit row.
 */

import {
  classifySocialUrl,
  dedupeSocialLinks,
  type BrandSocialLink,
} from "@/lib/social-links";
import {
  decodeBasicEntities,
  findMetaContent,
  findPageTitle,
  findTags,
  getAttribute,
  resolveUrl,
} from "./html-utils";
import { validateUrlSyntax } from "./url-guard";

export interface SiteIdentity {
  /** Deterministically extracted company/site name, or null. */
  siteName: string | null;
  /**
   * The brand logo: an absolute https(s) URL, or a `data:image/svg+xml`
   * URI when the logo was an inline <svg> in the page's masthead.
   */
  logoUrl: string | null;
  /** og:image social-card URL — kit metadata only, never a harvested asset. */
  socialImageUrl: string | null;
  /**
   * The brand's social profile links (item 26), at most one per platform.
   * Ladder: JSON-LD Organization `sameAs` (canonical) → footer/nav anchor
   * scan for known social domains. Share/intent URLs are never profiles.
   */
  socialLinks: BrandSocialLink[];
}

/** Inline SVGs beyond this many characters are decoration, not a logo. */
const MAX_INLINE_SVG_CHARS = 20_000;
/** Bound each masthead region so regex scans stay cheap on huge pages. */
const MAX_MASTHEAD_REGION_CHARS = 60_000;
const MAX_JSON_LD_BLOCKS = 8;
const MAX_TITLE_SEGMENT_CHARS = 60;

/** Resolve + SSRF-syntax-check a raw URL; null when unusable or blocked. */
function resolveGuardedUrl({ raw, baseUrl }: { raw: string | null; baseUrl: string }): string | null {
  if (raw === null || raw.length === 0) {
    return null;
  }
  const resolved = resolveUrl({ raw, baseUrl });
  if (resolved === null) {
    return null;
  }
  return validateUrlSyntax(resolved).isAllowed ? resolved : null;
}

// ---------------------------------------------------------------------------
// JSON-LD (schema.org Organization)
// ---------------------------------------------------------------------------

interface JsonLdOrganization {
  name: string | null;
  logo: string | null;
  /** Raw `sameAs` URLs (profile links on other sites) — classified later. */
  sameAsUrls: string[];
}

function isOrganizationType(typeValue: unknown): boolean {
  const types = Array.isArray(typeValue) ? typeValue : [typeValue];
  return types.some(
    (candidate) => typeof candidate === "string" && candidate.toLowerCase().includes("organization"),
  );
}

/** Pull a logo URL out of Organization.logo (string or ImageObject). */
function readJsonLdLogo(logoValue: unknown): string | null {
  if (typeof logoValue === "string" && logoValue.length > 0) {
    return logoValue;
  }
  if (typeof logoValue === "object" && logoValue !== null) {
    const url = (logoValue as Record<string, unknown>).url;
    if (typeof url === "string" && url.length > 0) {
      return url;
    }
  }
  return null;
}

/** Recursion guard for nested JSON-LD (typed nodes nest freely in practice). */
const MAX_JSON_LD_DEPTH = 5;

/**
 * Flatten a parsed JSON-LD document into candidate typed nodes: arrays,
 * @graph, AND nested node values — real-world markup embeds the Organization
 * inside e.g. a WebPage's `publisher` (CNN does exactly this), so a
 * top-level-only walk misses the canonical `sameAs`/logo/name.
 */
function flattenJsonLdNodes(parsed: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > MAX_JSON_LD_DEPTH) {
    return [];
  }
  if (Array.isArray(parsed)) {
    return parsed.flatMap((entry) => flattenJsonLdNodes(entry, depth + 1));
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const node = parsed as Record<string, unknown>;
  const nestedNodes = Object.values(node).flatMap((value) =>
    typeof value === "object" && value !== null ? flattenJsonLdNodes(value, depth + 1) : [],
  );
  return node["@type"] === undefined ? nestedNodes : [node, ...nestedNodes];
}

/** First schema.org Organization's name + logo across the page's JSON-LD. */
function extractJsonLdOrganization(html: string): JsonLdOrganization {
  const blocks =
    html.match(
      /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ) ?? [];
  const result: JsonLdOrganization = { name: null, logo: null, sameAsUrls: [] };
  for (const block of blocks.slice(0, MAX_JSON_LD_BLOCKS)) {
    const jsonText = block.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      continue; // malformed JSON-LD — skip the block
    }
    for (const node of flattenJsonLdNodes(parsed)) {
      if (!isOrganizationType(node["@type"])) {
        continue;
      }
      if (result.name === null && typeof node.name === "string" && node.name.length > 0) {
        result.name = decodeBasicEntities(node.name);
      }
      if (result.logo === null) {
        result.logo = readJsonLdLogo(node.logo);
      }
      const sameAs = node.sameAs;
      for (const candidate of Array.isArray(sameAs) ? sameAs : [sameAs]) {
        if (typeof candidate === "string" && candidate.length > 0) {
          result.sameAsUrls.push(candidate);
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// <link rel*="icon"> ladder — SVG first, then apple-touch-icon, then size
// ---------------------------------------------------------------------------

interface IconCandidate {
  href: string;
  isSvg: boolean;
  isAppleTouchIcon: boolean;
  declaredSize: number;
}

function parseDeclaredSize(sizesAttribute: string | null): number {
  const match = (sizesAttribute ?? "").match(/(\d+)x\d+/i);
  return match === null ? 0 : Number(match[1]);
}

function extractIconLogo({ html, baseUrl }: { html: string; baseUrl: string }): string | null {
  const candidates: IconCandidate[] = [];
  for (const tag of findTags({ html, tagName: "link" })) {
    const rel = (getAttribute({ tag, name: "rel" }) ?? "").toLowerCase();
    if (!rel.includes("icon")) {
      continue;
    }
    const href = getAttribute({ tag, name: "href" });
    if (href === null) {
      continue;
    }
    const type = (getAttribute({ tag, name: "type" }) ?? "").toLowerCase();
    const isSvg = type.includes("svg") || /\.svg(\?|#|$)/i.test(href);
    candidates.push({
      href,
      isSvg,
      isAppleTouchIcon: rel.includes("apple-touch-icon"),
      declaredSize: parseDeclaredSize(getAttribute({ tag, name: "sizes" })),
    });
  }
  // SVG beats everything (scales cleanly); apple-touch-icon beats raster
  // favicons (it's the largest raster the site ships); then declared size.
  candidates.sort((a, b) => {
    if (a.isSvg !== b.isSvg) {
      return a.isSvg ? -1 : 1;
    }
    if (a.isAppleTouchIcon !== b.isAppleTouchIcon) {
      return a.isAppleTouchIcon ? -1 : 1;
    }
    return b.declaredSize - a.declaredSize;
  });
  for (const candidate of candidates) {
    const resolved = resolveGuardedUrl({ raw: candidate.href, baseUrl });
    if (resolved !== null) {
      return resolved;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Body fallback: masthead (header/nav/menu) scan
// ---------------------------------------------------------------------------

/** The page's masthead-ish regions: <header>, <nav>, and *menu* containers. */
function findMastheadRegions(html: string): string[] {
  const regions: string[] = [];
  for (const pattern of [
    /<header\b[\s\S]*?<\/header>/gi,
    /<nav\b[\s\S]*?<\/nav>/gi,
    /<(?:div|section)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:menu|masthead|navbar)[^"']*["'][^>]*>[\s\S]{0,4000}/gi,
  ]) {
    for (const match of html.match(pattern)?.slice(0, 2) ?? []) {
      regions.push(match.slice(0, MAX_MASTHEAD_REGION_CHARS));
    }
  }
  return regions;
}

function isLogoLookingImgTag(tag: string): boolean {
  const src = getAttribute({ tag, name: "src" }) ?? "";
  const alt = getAttribute({ tag, name: "alt" }) ?? "";
  const className = getAttribute({ tag, name: "class" }) ?? "";
  const id = getAttribute({ tag, name: "id" }) ?? "";
  const attributeHaystack = `${src} ${className} ${id}`.toLowerCase();
  // Long alt sentences that merely mention "logo" are photos, not logos.
  return attributeHaystack.includes("logo") || (alt.toLowerCase().includes("logo") && alt.length <= 50);
}

/** The opening tag + full markup of each inline <svg> in a region. */
function findInlineSvgs(region: string): string[] {
  return region.match(/<svg\b[\s\S]*?<\/svg>/gi) ?? [];
}

function isLogoLookingSvg(svgMarkup: string): boolean {
  const openingTag = svgMarkup.match(/^<svg\b[^>]*>/i)?.[0] ?? "";
  const labels = [
    getAttribute({ tag: openingTag, name: "class" }),
    getAttribute({ tag: openingTag, name: "id" }),
    getAttribute({ tag: openingTag, name: "aria-label" }),
    svgMarkup.match(/<title[^>]*>([\s\S]{0,120}?)<\/title>/i)?.[1],
  ];
  return labels.some((label) => label !== null && label !== undefined && label.toLowerCase().includes("logo"));
}

/** Serialize an inline SVG to a renderable data: URI (xmlns injected if missing). */
function serializeInlineSvg(svgMarkup: string): string | null {
  if (svgMarkup.length > MAX_INLINE_SVG_CHARS) {
    return null; // giant SVGs are illustrations, not logos
  }
  const hasXmlns = /<svg\b[^>]*\bxmlns\s*=/i.test(svgMarkup);
  const standalone = hasXmlns
    ? svgMarkup
    : svgMarkup.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml;base64,${Buffer.from(standalone, "utf-8").toString("base64")}`;
}

/**
 * Scan the masthead for the brand logo: logo-hinted <img>/<svg> first, then
 * the region's first image/svg (the masthead's leading image is almost
 * always the logo).
 */
function extractMastheadLogo({ html, baseUrl }: { html: string; baseUrl: string }): string | null {
  const regions = findMastheadRegions(html);
  // Pass 1 — explicit "logo" hints, across all regions before any bare fallback.
  for (const region of regions) {
    for (const tag of findTags({ html: region, tagName: "img" })) {
      if (isLogoLookingImgTag(tag)) {
        const resolved = resolveGuardedUrl({ raw: getAttribute({ tag, name: "src" }), baseUrl });
        if (resolved !== null) {
          return resolved;
        }
      }
    }
    for (const svgMarkup of findInlineSvgs(region)) {
      if (isLogoLookingSvg(svgMarkup)) {
        const serialized = serializeInlineSvg(svgMarkup);
        if (serialized !== null) {
          return serialized;
        }
      }
    }
  }
  // Pass 2 — the masthead's first image, else its first inline SVG.
  for (const region of regions) {
    const firstImg = findTags({ html: region, tagName: "img" })[0];
    if (firstImg !== undefined) {
      const resolved = resolveGuardedUrl({ raw: getAttribute({ tag: firstImg, name: "src" }), baseUrl });
      if (resolved !== null) {
        return resolved;
      }
    }
    const firstSvg = findInlineSvgs(region)[0];
    if (firstSvg !== undefined) {
      const serialized = serializeInlineSvg(firstSvg);
      if (serialized !== null) {
        return serialized;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Social profile links (item 26)
// ---------------------------------------------------------------------------

/** Footer regions complement the masthead for the anchor fallback scan. */
function findFooterRegions(html: string): string[] {
  return (html.match(/<footer\b[\s\S]*?<\/footer>/gi) ?? [])
    .slice(0, 2)
    .map((region) => region.slice(0, MAX_MASTHEAD_REGION_CHARS));
}

/**
 * The brand's social profile links. Ladder (first source per platform wins):
 * 1. JSON-LD Organization `sameAs` — the canonical, author-declared list.
 * 2. Fallback: anchors in footer/nav/header regions pointing at known
 *    social domains (share/intent chrome filtered by the classifier).
 * Every kept URL passes the SSRF syntax guard; one link per platform.
 */
function extractSocialLinks({
  html,
  baseUrl,
  sameAsUrls,
}: {
  html: string;
  baseUrl: string;
  sameAsUrls: string[];
}): BrandSocialLink[] {
  const candidates: BrandSocialLink[] = [];
  const pushCandidate = (rawUrl: string): void => {
    const resolved = resolveGuardedUrl({ raw: rawUrl, baseUrl });
    if (resolved === null) {
      return;
    }
    const classified = classifySocialUrl(resolved);
    if (classified !== null && validateUrlSyntax(classified.url).isAllowed) {
      candidates.push(classified);
    }
  };
  // Rung 1 — author-declared profiles.
  for (const url of sameAsUrls) {
    pushCandidate(url);
  }
  // Rung 2 — footer first (social rows live there), then masthead/nav.
  for (const region of [...findFooterRegions(html), ...findMastheadRegions(html)]) {
    for (const anchorTag of findTags({ html: region, tagName: "a" })) {
      const href = getAttribute({ tag: anchorTag, name: "href" });
      if (href !== null) {
        pushCandidate(href);
      }
    }
  }
  return dedupeSocialLinks(candidates);
}

// ---------------------------------------------------------------------------
// Company name
// ---------------------------------------------------------------------------

/**
 * Clean a <title> down to the brand segment: split on the first separator
 * (em/en dash, pipe, bullet, colon-pair, or spaced hyphen) and keep the
 * leading segment — "CNN — Breaking News, Latest News and Videos" → "CNN".
 */
export function cleanTitleToBrandName(title: string): string | null {
  const [firstSegment] = title.split(/\s*(?:—|–|\||·|•|::)\s*|\s+-\s+/);
  const cleaned = firstSegment.trim();
  if (cleaned.length === 0 || cleaned.length > MAX_TITLE_SEGMENT_CHARS) {
    return null;
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Extract the site's identity (name, logo, social card) — deterministic. */
export function extractSiteIdentity({
  html,
  baseUrl,
}: {
  html: string;
  baseUrl: string;
}): SiteIdentity {
  const organization = extractJsonLdOrganization(html);

  const logoUrl =
    resolveGuardedUrl({ raw: findMetaContent({ html, key: "og:logo" }), baseUrl }) ??
    resolveGuardedUrl({ raw: organization.logo, baseUrl }) ??
    extractIconLogo({ html, baseUrl }) ??
    extractMastheadLogo({ html, baseUrl });

  const siteName =
    findMetaContent({ html, key: "og:site_name" }) ??
    organization.name ??
    (() => {
      const title = findPageTitle(html);
      return title === null ? null : cleanTitleToBrandName(title);
    })();

  const socialImageUrl = resolveGuardedUrl({
    raw: findMetaContent({ html, key: "og:image" }),
    baseUrl,
  });

  const socialLinks = extractSocialLinks({
    html,
    baseUrl,
    sameAsUrls: organization.sameAsUrls,
  });

  return { siteName, logoUrl, socialImageUrl, socialLinks };
}
