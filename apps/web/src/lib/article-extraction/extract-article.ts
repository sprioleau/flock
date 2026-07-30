import type { FetchWebContentResult, WebContentConfidence } from "@tandem/agent";

/**
 * Article extraction (Phase 7.4a) — pure HTML → the page's ACTUAL main
 * content, no network, no LLM, no DOM dependency.
 *
 * Readability-style heuristics at regex scale (the same honest-harvesting
 * philosophy as ../brand-kit-extraction/harvest.ts — every sentence in the
 * output was literally present in the fetched markup):
 *
 * 1. Scope: prefer the largest <article> element, then <main>, then <body>.
 * 2. Strip non-content subtrees (script/style/nav/aside/footer/header/forms/
 *    figures) plus any element whose class/id smells like ads, comments,
 *    menus, share bars, or newsletter promos — depth-aware tag matching, so
 *    whole subtrees go, not just tags.
 * 3. Keep paragraph-shaped blocks (h1–h3, p, li, blockquote) that read like
 *    prose: enough text, low link density, no boilerplate phrasing. This is
 *    what keeps menus and "related stories" link farms out of mainText.
 * 4. Honest failures: paywall/sign-in stubs and pages with no readable prose
 *    return a structured refusal — never a fabricated article (plan §7.4).
 *
 * Metadata (title/byline/date/source/hero image/canonical URL) comes from
 * OpenGraph tags, JSON-LD Article objects, and standard fallbacks.
 */

// ---------------------------------------------------------------------------
// Budgets & thresholds
// ---------------------------------------------------------------------------

/** Context-window budget for mainText (chars, ~1.2k tokens). */
export const MAX_MAIN_TEXT_CHARS = 5_000;

/** Marker appended when mainText hits the cap (isTruncated is also set). */
export const TRUNCATION_MARKER = "[content truncated — the full article is at the source]";

/** Below this much extracted prose the page is treated as not-an-article. */
const MIN_MAIN_TEXT_CHARS = 300;

const MAX_EXCERPT_CHARS = 300;

// ---------------------------------------------------------------------------
// Small HTML utilities (no DOM)
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  eacute: "é",
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

/** Strip every tag, decode entities, collapse whitespace. */
function toPlainText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** One attribute's value from a single raw tag string. */
function getAttribute({ tag, name }: { tag: string; name: string }): string | undefined {
  const match = tag.match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"),
  );
  return match === null ? undefined : decodeHtmlEntities((match[1] ?? match[2] ?? "").trim());
}

interface TagToken {
  index: number;
  length: number;
  isClosing: boolean;
  isSelfClosing: boolean;
  rawTag: string;
}

function tokenizeTag(tagName: string, html: string): TagToken[] {
  const pattern = new RegExp(`<(/?)${tagName}(?=[\\s>/])[^>]*>`, "gi");
  const tokens: TagToken[] = [];
  for (const match of html.matchAll(pattern)) {
    tokens.push({
      index: match.index,
      length: match[0].length,
      isClosing: match[1] === "/",
      isSelfClosing: match[0].endsWith("/>"),
      rawTag: match[0],
    });
  }
  return tokens;
}

/**
 * Remove every `<tagName>…</tagName>` subtree (depth-aware, so nested
 * same-name tags don't truncate the removal early).
 */
function removeTagBlocks({ html, tagName }: { html: string; tagName: string }): string {
  const tokens = tokenizeTag(tagName, html);
  if (tokens.length === 0) {
    return html;
  }
  let result = "";
  let keptUpTo = 0;
  let depth = 0;
  for (const token of tokens) {
    if (!token.isClosing) {
      if (depth === 0) {
        result += html.slice(keptUpTo, token.index);
        keptUpTo = html.length; // provisional: dropped until the matching close
      }
      if (!token.isSelfClosing) {
        depth += 1;
      } else if (depth === 0) {
        keptUpTo = token.index + token.length;
      }
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0) {
        keptUpTo = token.index + token.length;
      }
    }
  }
  if (keptUpTo < html.length) {
    result += html.slice(keptUpTo);
  }
  return result;
}

/** Inner HTML of every top-level `<tagName>` block. */
function extractTagBlocks({ html, tagName }: { html: string; tagName: string }): string[] {
  const tokens = tokenizeTag(tagName, html);
  const blocks: string[] = [];
  let depth = 0;
  let openEndsAt = -1;
  for (const token of tokens) {
    if (!token.isClosing && !token.isSelfClosing) {
      if (depth === 0) {
        openEndsAt = token.index + token.length;
      }
      depth += 1;
    } else if (token.isClosing && depth > 0) {
      depth -= 1;
      if (depth === 0 && openEndsAt >= 0) {
        blocks.push(html.slice(openEndsAt, token.index));
      }
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Junk removal (ads / menus / comments / promo chrome)
// ---------------------------------------------------------------------------

const NON_CONTENT_TAGS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "form",
  "nav",
  "aside",
  "footer",
  "header",
  "button",
  "select",
  "textarea",
  "figure",
  "dialog",
];

const JUNK_CLASS_OR_ID_PATTERN =
  /\b(ad|ads|advert\w*|sponsor\w*|promo\w*|banner|comment\w*|disqus|sidebar|related|recommend\w*|trending|popular|share|social|newsletter|subscribe|signup|sign-up|cookie|consent|breadcrumb\w*|menu|nav|navigation|masthead|footer|popup|modal|paywall|meter|outbrain|taboola)\b/i;

/** Tags worth junk-scanning by class/id (structural containers + lists). */
const JUNK_SCAN_TAGS = ["div", "section", "ul", "ol"];

/** Remove subtrees whose opening tag's class/id matches the junk pattern. */
function removeJunkBlocks(html: string): string {
  let cleaned = html;
  for (const tagName of JUNK_SCAN_TAGS) {
    // Re-scan until stable: removing an outer block can expose nothing new for
    // the same tag, but junk blocks of the same tag can be siblings.
    let hasRemoved = true;
    while (hasRemoved) {
      hasRemoved = false;
      const tokens = tokenizeTag(tagName, cleaned);
      let depth = 0;
      let junkOpensAt = -1;
      let junkDepth = -1;
      for (const token of tokens) {
        if (!token.isClosing && !token.isSelfClosing) {
          depth += 1;
          if (junkOpensAt < 0) {
            const classAndId = `${getAttribute({ tag: token.rawTag, name: "class" }) ?? ""} ${
              getAttribute({ tag: token.rawTag, name: "id" }) ?? ""
            }`;
            if (JUNK_CLASS_OR_ID_PATTERN.test(classAndId)) {
              junkOpensAt = token.index;
              junkDepth = depth;
            }
          }
        } else if (token.isClosing && depth > 0) {
          if (junkOpensAt >= 0 && depth === junkDepth) {
            cleaned =
              cleaned.slice(0, junkOpensAt) + cleaned.slice(token.index + token.length);
            hasRemoved = true;
            break;
          }
          depth -= 1;
        }
      }
      if (!hasRemoved) {
        break;
      }
    }
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Metadata (OpenGraph, JSON-LD, standard fallbacks)
// ---------------------------------------------------------------------------

interface PageMetadata {
  ogTitle?: string;
  ogSiteName?: string;
  ogImage?: string;
  ogUrl?: string;
  description?: string;
  metaAuthor?: string;
  publishedTime?: string;
  canonicalHref?: string;
  titleTag?: string;
  ldHeadline?: string;
  ldAuthor?: string;
  ldDatePublished?: string;
  ldImage?: string;
  ldPublisher?: string;
  isDeclaredPaywalled: boolean;
}

function readMetaTags(html: string): Map<string, string> {
  const metaByKey = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = (
      getAttribute({ tag, name: "property" }) ??
      getAttribute({ tag, name: "name" }) ??
      ""
    ).toLowerCase();
    const content = getAttribute({ tag, name: "content" });
    if (key.length > 0 && content !== undefined && content.length > 0 && !metaByKey.has(key)) {
      metaByKey.set(key, content);
    }
  }
  return metaByKey;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return asText(value[0]);
  }
  if (isRecord(value)) {
    return asText(value.name ?? value.url ?? value["@id"]);
  }
  return undefined;
}

/** The first JSON-LD object whose @type is an Article flavor, flattened. */
function readJsonLdArticle(html: string): Record<string, unknown> | undefined {
  const scriptPattern =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const candidates: Record<string, unknown>[] = [];
  for (const match of html.matchAll(scriptPattern)) {
    try {
      const parsed: unknown = JSON.parse(match[1].trim());
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        if (!isRecord(node)) continue;
        candidates.push(node);
        if (Array.isArray(node["@graph"])) {
          for (const graphNode of node["@graph"]) {
            if (isRecord(graphNode)) candidates.push(graphNode);
          }
        }
      }
    } catch {
      // Malformed JSON-LD is common in the wild — skip it, never throw.
    }
  }
  const isArticleType = (value: unknown): boolean => {
    const types = Array.isArray(value) ? value : [value];
    return types.some(
      (type) =>
        typeof type === "string" && /(news|blog|report|scholarly)?article|blogposting/i.test(type),
    );
  };
  return candidates.find((candidate) => isArticleType(candidate["@type"]));
}

function readPageMetadata(html: string): PageMetadata {
  const meta = readMetaTags(html);
  const ldArticle = readJsonLdArticle(html);

  let canonicalHref: string | undefined;
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (/^canonical$/i.test(getAttribute({ tag, name: "rel" }) ?? "")) {
      canonicalHref = getAttribute({ tag, name: "href" });
      break;
    }
  }

  const titleTagMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);

  const accessibleForFree = ldArticle?.isAccessibleForFree;
  const isDeclaredPaywalled =
    accessibleForFree === false ||
    (typeof accessibleForFree === "string" && /^false$/i.test(accessibleForFree.trim()));

  return {
    ogTitle: meta.get("og:title"),
    ogSiteName: meta.get("og:site_name"),
    ogImage: meta.get("og:image") ?? meta.get("og:image:url") ?? meta.get("twitter:image"),
    ogUrl: meta.get("og:url"),
    description: meta.get("og:description") ?? meta.get("description"),
    metaAuthor: meta.get("author") ?? meta.get("article:author"),
    publishedTime:
      meta.get("article:published_time") ?? meta.get("og:article:published_time"),
    canonicalHref,
    titleTag: titleTagMatch === null ? undefined : toPlainText(titleTagMatch[1]),
    ldHeadline: asText(ldArticle?.headline),
    ldAuthor: asText(ldArticle?.author),
    ldDatePublished: asText(ldArticle?.datePublished),
    ldImage: asText(ldArticle?.image),
    ldPublisher: asText(ldArticle?.publisher),
    isDeclaredPaywalled,
  };
}

function toAbsoluteHttpUrl({
  candidate,
  baseUrl,
}: {
  candidate: string | undefined;
  baseUrl: string;
}): string | undefined {
  if (candidate === undefined || candidate.trim().length === 0) {
    return undefined;
  }
  try {
    const absolute = new URL(candidate.trim(), baseUrl);
    return absolute.protocol === "http:" || absolute.protocol === "https:"
      ? absolute.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main-content scope + prose block collection
// ---------------------------------------------------------------------------

type ScopeKind = "article" | "main" | "body";

function selectContentScope(html: string): { scopeHtml: string; scopeKind: ScopeKind } {
  for (const tagName of ["article", "main"] as const) {
    const blocks = extractTagBlocks({ html, tagName });
    if (blocks.length === 0) continue;
    const largest = blocks.reduce((best, block) =>
      toPlainText(block).length > toPlainText(best).length ? block : best,
    );
    if (toPlainText(largest).length >= 250) {
      return { scopeHtml: largest, scopeKind: tagName };
    }
  }
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  return { scopeHtml: bodyMatch === null ? html : bodyMatch[1], scopeKind: "body" };
}

const BOILERPLATE_PATTERN =
  /^(advertisement|sponsored( content)?|share this|follow us|sign up|subscribe( now)?|accept( all)? cookies|we use cookies|related (articles|stories|posts)|read more|more from|comments?|leave a (comment|reply)|skip to)/i;

interface ProseBlock {
  kind: "heading" | "paragraph";
  text: string;
}

/** Link-density-aware prose collection — this is the ads/menus firewall. */
function collectProseBlocks(scopeHtml: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  const blockPattern = /<(h1|h2|h3|p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of scopeHtml.matchAll(blockPattern)) {
    const tagName = match[1].toLowerCase();
    // Drop heading-anchor widgets ("Copy link to heading", "#", "Permalink")
    // before flattening — docs/blog platforms nest them inside h2/h3.
    const rawInner = match[2].replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (anchor, anchorInner: string) =>
      /^\s*(copy link( to (heading|section))?|permalink|anchor|#|§)\s*$/i.test(
        toPlainText(anchorInner),
      )
        ? ""
        : anchor,
    );
    const text = toPlainText(rawInner);
    if (text.length === 0 || BOILERPLATE_PATTERN.test(text)) continue;
    if (/all rights reserved|terms of (use|service)|privacy policy/i.test(text)) continue;

    let linkTextLength = 0;
    for (const anchorMatch of rawInner.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
      linkTextLength += toPlainText(anchorMatch[1]).length;
    }
    const linkDensity = linkTextLength / text.length;

    const isHeading = tagName.startsWith("h");
    if (isHeading) {
      if (text.length >= 3 && text.length <= 200 && linkDensity < 0.8) {
        blocks.push({ kind: "heading", text });
      }
      continue;
    }
    if (tagName === "li") {
      // Menus and index pages are lists of links — only long, prose-like,
      // link-light items survive.
      if (text.length >= 60 && linkDensity <= 0.2) {
        blocks.push({ kind: "paragraph", text });
      }
      continue;
    }
    const hasSentencePunctuation = /[.!?…]["'”’]?\s*$/.test(text) || /[.!?…]\s/.test(text);
    const isLongEnough = text.length >= 40 || (text.length >= 15 && hasSentencePunctuation);
    if (isLongEnough && linkDensity <= 0.5) {
      blocks.push({ kind: "paragraph", text });
    }
  }
  // Drop repeats and containments: widgets duplicate teaser paragraphs, and a
  // <p> nested in a matched <blockquote> would otherwise be counted twice.
  return blocks.filter((block, index) => {
    const isContainedElsewhere = blocks.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        other.text.includes(block.text) &&
        (other.text.length > block.text.length || otherIndex < index),
    );
    return !isContainedElsewhere;
  });
}

const PAYWALL_TEXT_PATTERN =
  /(subscribe|sign in|log in|register|create (a )?free account|become a member)[^.]{0,60}(to (continue|keep) reading|to read (this|the full)|full (access|story|article))|this (article|story|content) is (exclusively )?for (subscribers|members)|to continue reading, (subscribe|sign in|log in)/i;

// ---------------------------------------------------------------------------
// The extractor
// ---------------------------------------------------------------------------

export interface ExtractArticleInput {
  /** The fetched page HTML (already capped by fetchPage). */
  html: string;
  /** The post-redirect URL — the base for resolving relative URLs. */
  finalUrl: string;
}

/**
 * Extract the page's main article content, or refuse honestly. Pure and
 * deterministic — safe to unit-test on saved fixtures.
 */
export function extractArticle({ html, finalUrl }: ExtractArticleInput): FetchWebContentResult {
  const metadata = readPageMetadata(html);

  // Order matters: junk-class subtrees first (they may CONTAIN structural
  // tags whose removal would otherwise splice around them), then structural
  // non-content tags.
  const { scopeHtml, scopeKind } = selectContentScope(html);
  let cleanedScope = removeJunkBlocks(scopeHtml);
  for (const tagName of NON_CONTENT_TAGS) {
    cleanedScope = removeTagBlocks({ html: cleanedScope, tagName });
  }

  const proseBlocks = collectProseBlocks(cleanedScope);
  const fullText = proseBlocks.map((block) => block.text).join("\n\n");

  const hasPaywallSignal =
    metadata.isDeclaredPaywalled || PAYWALL_TEXT_PATTERN.test(toPlainText(cleanedScope));
  if (hasPaywallSignal && fullText.length < 1_200) {
    return {
      isOk: false,
      reason: "paywalled",
      message:
        "That page is behind a paywall or sign-in, so the story couldn't be read. Nothing was made up in its place — try a publicly readable link to the same story.",
    };
  }

  if (fullText.length < MIN_MAIN_TEXT_CHARS) {
    return {
      isOk: false,
      reason: "no_main_content",
      message:
        "No readable article was found on that page — it looks like a homepage, an index, or a page that is mostly navigation or media. Try a direct link to the story itself.",
    };
  }

  let mainText = fullText;
  let isTruncated = false;
  if (mainText.length > MAX_MAIN_TEXT_CHARS) {
    const budget = MAX_MAIN_TEXT_CHARS - TRUNCATION_MARKER.length - 2;
    const cut = mainText.slice(0, budget);
    const lastBreak = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
    mainText = `${cut.slice(0, lastBreak > budget / 2 ? lastBreak : budget).trimEnd()}…\n\n${TRUNCATION_MARKER}`;
    isTruncated = true;
  }

  const sourceHostname = new URL(finalUrl).hostname.replace(/^www\./i, "");
  const sourceName = metadata.ogSiteName ?? metadata.ldPublisher ?? sourceHostname;

  let title = metadata.ogTitle ?? metadata.ldHeadline ?? metadata.titleTag ?? sourceName;
  const escapedSourceName = sourceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  title = title.replace(new RegExp(`\\s*[|–—-]\\s*${escapedSourceName}\\s*$`, "i"), "").trim();
  if (title.length === 0) {
    title = sourceName;
  }

  const canonicalUrl =
    toAbsoluteHttpUrl({ candidate: metadata.canonicalHref, baseUrl: finalUrl }) ??
    toAbsoluteHttpUrl({ candidate: metadata.ogUrl, baseUrl: finalUrl }) ??
    finalUrl;
  const heroImageUrl =
    toAbsoluteHttpUrl({ candidate: metadata.ogImage, baseUrl: finalUrl }) ??
    toAbsoluteHttpUrl({ candidate: metadata.ldImage, baseUrl: finalUrl });
  const byline = metadata.metaAuthor ?? metadata.ldAuthor;
  const publishedAt = metadata.publishedTime ?? metadata.ldDatePublished;
  const excerpt =
    metadata.description === undefined
      ? undefined
      : metadata.description.slice(0, MAX_EXCERPT_CHARS);

  const hasStructuredTitle = metadata.ogTitle !== undefined || metadata.ldHeadline !== undefined;
  let confidence: WebContentConfidence;
  if (scopeKind !== "body" && fullText.length >= 1_500 && hasStructuredTitle) {
    confidence = "high";
  } else if (fullText.length >= 600 && (scopeKind !== "body" || hasStructuredTitle)) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  return {
    isOk: true,
    article: {
      title,
      ...(byline === undefined ? {} : { byline }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
      sourceName,
      canonicalUrl,
      ...(heroImageUrl === undefined ? {} : { heroImageUrl }),
      ...(excerpt === undefined ? {} : { excerpt }),
      mainText,
      isTruncated,
      confidence,
    },
  };
}
