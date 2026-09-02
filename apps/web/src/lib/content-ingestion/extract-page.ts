import type {
  ImageCandidate,
  ImageOrigin,
  PageScrape,
  ProseBlock,
  ScrapedList,
} from "./page-scrape";

/*
  Generic page extraction — pure HTML → a `PageScrape`, with NO idea what kind
  of page it was reading. No network, no LLM, no DOM.

  This is the parser that `extract-article.ts` and `extract-person.ts` always
  shared, plus three channels those two readers threw away:

    - `lists`   — judged per LIST rather than per item, so a skills list
                  survives and a link menu does not (see LIST_LINK_DENSITY_MAX).
    - `imageCandidates` — every image the page offers, as evidence with hints,
                  rather than one image already chosen as "the" hero/portrait.
    - `structuredData`  — every JSON-LD node, with no type filter at all.

  THE RULE: nothing below branches on what kind of page this is. There is no
  page type at this layer — that is a later step's OUTPUT. The heuristics here
  are about SHAPE (link density, text length, document position), never about
  subject matter. `PORTRAIT_HINT_PATTERN` is the closest thing to a subject
  keyword left, and it is deliberately demoted to a hint string that decides
  nothing.
*/

export type { ProseBlock } from "./page-scrape";

/*
  ---------------------------------------------------------------------------
  Budgets & thresholds
  ---------------------------------------------------------------------------
*/

/*
  Context-window budget for everything the page said (chars, ~2k tokens).
*/
export const MAX_PAGE_CONTENT_CHARS = 8_000;

/*
  Below this much extracted prose the page is treated as unreadable.
*/
export const MIN_MAIN_TEXT_CHARS = 300;

/*
  How much UNLINKED text of its own a block must carry to be admitted as prose
  despite scoring past the link-density cut. A navigation block's own words are
  the separators between its links, so this is far out of a menu's reach while
  being ordinary for a paragraph that happens to cite a lot.
*/
const MIN_CROSS_LINKED_PROSE_CHARS = 200;

/*
  A paywall signal only refuses when there is also little prose — plenty of
  fully readable articles mention subscribing somewhere on the page.
*/
export const MAX_PAYWALLED_TEASER_CHARS = 1_200;

/*
  Same budget the article extractor puts on its excerpt.
*/
const MAX_DESCRIPTION_CHARS = 300;

/*
  The list admission threshold. Judged on the list AS A WHOLE, because that is
  the only place the signal actually lives: "TypeScript" is indistinguishable
  from "Careers" as a single item, but the LISTS they sit in are not — a
  navigation list is near 1.00 link text and a skills list is near 0.00.

  0.5 rather than a tighter number, for two reasons.

  First, it is the same line `collectProseBlocks` already draws for a `<p>`
  (`linkDensity <= 0.5`), so prose and lists are judged by one standard instead
  of two pieces of folklore. The meaning of that line is: past half, the text
  exists to be clicked — it is the NAME OF SOMEWHERE ELSE — and below half the
  links are annotations inside something the page itself wrote.

  Second, the failure modes are asymmetric. Admitting a menu costs a few junk
  strings that a later step can ignore, and it is caught anyway by two firewalls
  upstream (`<nav>` removal and the junk class/id pattern). Rejecting a real
  list destroys evidence that nothing downstream can recover, which is the exact
  bug this channel exists to fix. So the threshold leans toward admitting.

  Known miss, accepted: a skills list whose every item links to a tag page reads
  as 1.00 and is refused. Density cannot separate that from a menu, and
  `headingBefore` is the only remaining signal — a later step's problem, not
  this one's.
*/
const LIST_LINK_DENSITY_MAX = 0.5;

/*
  Roughly 200 characters of context around an image tag.
*/
const SURROUNDING_TEXT_CHARS = 200;

/*
  How much raw markup to look through to find that context.
*/
const SURROUNDING_SCAN_CHARS = 1_200;

/*
  ---------------------------------------------------------------------------
  Small HTML utilities (no DOM)
  ---------------------------------------------------------------------------
*/

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

/*
  Strip every tag, decode entities, collapse whitespace.
*/
export function toPlainText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/*
  One attribute's value from a single raw tag string.
*/
export function getAttribute({ tag, name }: { tag: string; name: string }): string | undefined {
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

/*
  Remove every `<tagName>…</tagName>` subtree (depth-aware, so nested
  same-name tags don't truncate the removal early).
*/
export function removeTagBlocks({ html, tagName }: { html: string; tagName: string }): string {
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
        keptUpTo = html.length; /* provisional: dropped until the matching close */
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

interface TagBlock {
  innerHtml: string;
  startIndex: number;
}

/*
  Inner HTML and document position of every `<tagName>` block, including
  same-name blocks nested inside another one.

  Keeping the nested blocks is load-bearing for component-built publishing
  pages. They commonly use `<article>` both for a page region and for cards
  inside that region; the page's actual story may be another nested article.
  Returning only the outer block makes the focused story impossible to choose.
*/
function extractTagBlocks({ html, tagName }: { html: string; tagName: string }): TagBlock[] {
  const tokens = tokenizeTag(tagName, html);
  const blocks: TagBlock[] = [];
  const openings: TagToken[] = [];
  for (const token of tokens) {
    if (!token.isClosing && !token.isSelfClosing) {
      openings.push(token);
    } else if (token.isClosing) {
      const opening = openings.pop();
      if (opening === undefined) continue;
      blocks.push({
        innerHtml: html.slice(opening.index + opening.length, token.index),
        startIndex: opening.index,
      });
    }
  }
  return blocks.sort((left, right) => left.startIndex - right.startIndex);
}

/*
  Blank out a region's markup while KEEPING the document's length, so every
  index computed against the result still points at the same character of the
  original. Image candidates carry positions (document order, nearest heading,
  surrounding text), so the masking trick is what lets them be read out of a
  document that has had its scripts and comments neutralised.
*/
function maskRegions({ html, pattern }: { html: string; pattern: RegExp }): string {
  return html.replace(pattern, (match: string) => " ".repeat(match.length));
}

/*
  ---------------------------------------------------------------------------
  Junk removal (ads / menus / comments / promo chrome)
  ---------------------------------------------------------------------------
*/

export const NON_CONTENT_TAGS = [
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

/*
  Tags worth junk-scanning by class/id (structural containers + lists).
*/
const JUNK_SCAN_TAGS = ["div", "section", "ul", "ol"];

/*
  Remove subtrees whose opening tag's class/id matches the junk pattern.
*/
export function removeJunkBlocks(html: string): string {
  let cleaned = html;
  for (const tagName of JUNK_SCAN_TAGS) {
    /*
      Re-scan until stable: removing an outer block can expose nothing new for
      the same tag, but junk blocks of the same tag can be siblings.
    */
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

/*
  ---------------------------------------------------------------------------
  Metadata (OpenGraph, JSON-LD, standard fallbacks)
  ---------------------------------------------------------------------------
*/

export interface PageMetadata {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asText(value: unknown): string | undefined {
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

/*
  Every JSON-LD object on the page, `@graph` members flattened in.
*/
export function readJsonLdNodes(html: string): Record<string, unknown>[] {
  const scriptPattern =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const nodes: Record<string, unknown>[] = [];
  for (const match of html.matchAll(scriptPattern)) {
    try {
      const parsed: unknown = JSON.parse(match[1].trim());
      const parsedNodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of parsedNodes) {
        if (!isRecord(node)) continue;
        nodes.push(node);
        if (Array.isArray(node["@graph"])) {
          for (const graphNode of node["@graph"]) {
            if (isRecord(graphNode)) nodes.push(graphNode);
          }
        }
      }
    } catch {
      /*
        Malformed JSON-LD is common in the wild — skip it, never throw.
      */
    }
  }
  return nodes;
}

/*
  True when a JSON-LD node's `@type` (string or array) matches `pattern`.
*/
export function hasJsonLdType({ node, pattern }: { node: Record<string, unknown>; pattern: RegExp }): boolean {
  const rawType = node["@type"];
  const types = Array.isArray(rawType) ? rawType : [rawType];
  return types.some((type) => typeof type === "string" && pattern.test(type));
}

const ARTICLE_TYPE_PATTERN = /(news|blog|report|scholarly)?article|blogposting/i;

/*
  The first JSON-LD object whose @type is an Article flavor, flattened.
*/
function readJsonLdArticle(html: string): Record<string, unknown> | undefined {
  return readJsonLdNodes(html).find((node) =>
    hasJsonLdType({ node, pattern: ARTICLE_TYPE_PATTERN }),
  );
}

export function readPageMetadata(html: string): PageMetadata {
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

export function toAbsoluteHttpUrl({
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

/*
  ---------------------------------------------------------------------------
  Main-content scope + prose block collection
  ---------------------------------------------------------------------------
*/

type ScopeKind = "article" | "main" | "body";

interface ContentScopeCandidate {
  scopeHtml: string;
  scopeKind: Exclude<ScopeKind, "body">;
  startIndex: number;
  plainTextLength: number;
  substantiveTextLength: number;
}

const MIN_CONTENT_SCOPE_CHARS = 250;

function cleanContentScope(scopeHtml: string): string {
  let cleanedScope = removeJunkBlocks(scopeHtml);
  for (const tagName of NON_CONTENT_TAGS) {
    cleanedScope = removeNonContentTag({ html: cleanedScope, tagName });
  }
  return cleanedScope;
}

/*
  Measure only content that the extractor would actually retain. Raw text
  length rewards link directories, account gates, and card grids precisely
  because they repeat a lot of words; prose/list admission is the existing
  deterministic firewall that distinguishes those words from page content.
*/
function measureSubstantiveText(scopeHtml: string): number {
  const cleanedScope = cleanContentScope(scopeHtml);
  if (PAYWALL_TEXT_PATTERN.test(toPlainText(cleanedScope))) {
    return 0;
  }
  const admittedLists = collectLists(cleanedScope);
  const blocks = collectProseBlocks(
    removeSpans({ html: cleanedScope, spans: admittedLists.map((admitted) => admitted.span) }),
  );
  return [
    ...blocks.map((block) => block.text),
    ...admittedLists.flatMap((admitted) => admitted.list.items),
  ].join("\n\n").length;
}

export function selectContentScope(html: string): { scopeHtml: string; scopeKind: ScopeKind } {
  const candidates: ContentScopeCandidate[] = [];
  for (const scopeKind of ["article", "main"] as const) {
    for (const block of extractTagBlocks({ html, tagName: scopeKind })) {
      candidates.push({
        scopeHtml: block.innerHtml,
        scopeKind,
        startIndex: block.startIndex,
        plainTextLength: toPlainText(block.innerHtml).length,
        substantiveTextLength: measureSubstantiveText(block.innerHtml),
      });
    }
  }

  const selected = candidates
    .filter((candidate) => candidate.substantiveTextLength >= MIN_CONTENT_SCOPE_CHARS)
    .sort((left, right) => {
      const substantiveDifference = right.substantiveTextLength - left.substantiveTextLength;
      if (substantiveDifference !== 0) return substantiveDifference;
      const sizeDifference = left.plainTextLength - right.plainTextLength;
      if (sizeDifference !== 0) return sizeDifference;
      if (left.scopeKind !== right.scopeKind) return left.scopeKind === "article" ? -1 : 1;
      return left.startIndex - right.startIndex;
    })[0];
  if (selected !== undefined) {
    return { scopeHtml: selected.scopeHtml, scopeKind: selected.scopeKind };
  }

  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  return { scopeHtml: bodyMatch === null ? html : bodyMatch[1], scopeKind: "body" };
}

const BOILERPLATE_PATTERN =
  /^(advertisement|sponsored( content)?|share this|follow us|sign up|subscribe( now)?|accept( all)? cookies|we use cookies|related (articles|stories|posts)|read more|more from|comments?|leave a (comment|reply)|skip to)/i;

const LEGAL_CHROME_PATTERN = /all rights reserved|terms of (use|service)|privacy policy/i;

/*
  Link-density-aware prose collection — this is the ads/menus firewall.
*/
export function collectProseBlocks(scopeHtml: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  const blockPattern = /<(h1|h2|h3|p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of scopeHtml.matchAll(blockPattern)) {
    const tagName = match[1].toLowerCase();
    /*
      Drop heading-anchor widgets ("Copy link to heading", "#", "Permalink")
      before flattening — docs/blog platforms nest them inside h2/h3.
    */
    const rawInner = match[2].replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (anchor, anchorInner: string) =>
      /^\s*(copy link( to (heading|section))?|permalink|anchor|#|§)\s*$/i.test(
        toPlainText(anchorInner),
      )
        ? ""
        : anchor,
    );
    const text = toPlainText(rawInner);
    if (text.length === 0 || BOILERPLATE_PATTERN.test(text)) continue;
    if (LEGAL_CHROME_PATTERN.test(text)) continue;

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
      /*
        Menus and index pages are lists of links — only long, prose-like,
        link-light items survive.
      */
      if (text.length >= 60 && linkDensity <= 0.2) {
        blocks.push({ kind: "paragraph", text });
      }
      continue;
    }
    const hasSentencePunctuation = /[.!?…]["'”’]?\s*$/.test(text) || /[.!?…]\s/.test(text);
    const isLongEnough = text.length >= 40 || (text.length >= 15 && hasSentencePunctuation);
    /*
      Link density alone misjudges one real shape: prose that cross-links
      heavily. A project's own homepage describing itself, where every feature
      word links to the page documenting that feature, is content — but it can
      sit right at the menus threshold.

      Measured: sqlite.org's opening paragraph scores 0.501 against a 0.5 cut
      and was discarded, taking the page's entire self-description with it and
      getting the page refused for having no readable content.

      So admit on EITHER low density OR a substantial amount of the block's own
      unlinked words. That separates the two cases the density rule conflates:
      a menu has almost no text of its own, while a cross-linked paragraph has
      plenty. This only ever admits more, so nothing previously kept is lost.
    */
    const ownTextLength = text.length - linkTextLength;
    const hasSubstantialOwnText = ownTextLength >= MIN_CROSS_LINKED_PROSE_CHARS;
    if (isLongEnough && (linkDensity <= 0.5 || hasSubstantialOwnText)) {
      blocks.push({ kind: "paragraph", text });
    }
  }
  /*
    Drop repeats and containments: widgets duplicate teaser paragraphs, and a
    <p> nested in a matched <blockquote> would otherwise be counted twice.

    SAME KIND ONLY, and that restriction is load-bearing. Comparing across
    kinds let a paragraph swallow a heading whenever the paragraph happened to
    mention the heading's words — which is the NORMAL shape of a personal or
    portfolio page, where <h1>Ada Lovelace</h1> is followed by "Ada Lovelace is
    a mathematician…". Measured on a real portfolio: the h1 carrying the
    person's name vanished, leaving the page with no name at all, and the
    content budget's promise that the first heading is never dropped was
    quietly broken upstream of the budget ever running.

    The nested-blockquote case this filter exists for is paragraph-versus-
    paragraph (a <blockquote> is collected as a paragraph), so restricting the
    comparison to matching kinds keeps the de-dup working and stops it eating
    the single most important block on an identity page.
  */
  return blocks.filter((block, index) => {
    const isContainedElsewhere = blocks.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        other.kind === block.kind &&
        other.text.includes(block.text) &&
        (other.text.length > block.text.length || otherIndex < index),
    );
    return !isContainedElsewhere;
  });
}

/*
  ---------------------------------------------------------------------------
  Honest refusals — shared verbatim with the article extractor so the two
  cannot drift apart while both exist.
  ---------------------------------------------------------------------------
*/

export const PAYWALL_TEXT_PATTERN =
  /(subscribe|sign in|log in|register|create (a )?free account|become a member)[^.]{0,60}(to (continue|keep) reading|to read (this|the full)|full (access|story|article))|this (article|story|content) is (exclusively )?for (subscribers|members)|to continue reading, (subscribe|sign in|log in)/i;

/*
  Type-neutral on purpose. These used to say "the story" and "no readable
  article", which was true when only an article extractor could produce them.
  One generic reader serves portfolios, product pages, docs and event pages
  too, and telling someone their portfolio contains no readable article is
  both wrong and confusing. The machine `reason` codes are unchanged.
*/
export const PAYWALL_REFUSAL_MESSAGE =
  "That page is behind a paywall or sign-in, so its content couldn't be read. Nothing was made up in its place — try a publicly readable link to the same page.";

export const NO_MAIN_CONTENT_REFUSAL_MESSAGE =
  "There wasn't enough readable content on that page to work from — it looks like it is mostly navigation, links, or media. Try a direct link to the page whose content you want.";

/*
  ---------------------------------------------------------------------------
  The lists channel
  ---------------------------------------------------------------------------
*/

interface ListSpan {
  startIndex: number;
  endIndex: number;
  innerHtml: string;
}

/*
  Every `<ul>`/`<ol>` block with its position, at EVERY nesting level. A list
  nested inside another list is reported separately, and its items are removed
  from its parent's, so no item is counted twice.
*/
function findListSpans(html: string): ListSpan[] {
  const tokens = [...tokenizeTag("ul", html), ...tokenizeTag("ol", html)].sort(
    (left, right) => left.index - right.index,
  );
  const spans: ListSpan[] = [];
  const openTokens: TagToken[] = [];
  for (const token of tokens) {
    if (token.isSelfClosing) continue;
    if (!token.isClosing) {
      openTokens.push(token);
      continue;
    }
    const openToken = openTokens.pop();
    if (openToken === undefined) continue;
    spans.push({
      startIndex: openToken.index,
      endIndex: token.index + token.length,
      innerHtml: html.slice(openToken.index + openToken.length, token.index),
    });
  }
  return spans.sort((left, right) => left.startIndex - right.startIndex);
}

interface RawListItem {
  text: string;
  linkTextLength: number;
}

/*
  A list's own items. Splitting on the OPENING `<li>` rather than matching
  `<li>…</li>` pairs, because an unclosed `<li>` is valid HTML and extremely
  common — a pair-matching regex silently swallows the rest of the list.
*/
function readListItems(listInnerHtml: string): RawListItem[] {
  const withoutNestedLists = removeTagBlocks({
    html: removeTagBlocks({ html: listInnerHtml, tagName: "ul" }),
    tagName: "ol",
  });
  const openings = [...withoutNestedLists.matchAll(/<li\b[^>]*>/gi)];
  const items: RawListItem[] = [];
  for (const [position, opening] of openings.entries()) {
    const start = opening.index + opening[0].length;
    const nextOpening = openings[position + 1];
    const end = nextOpening === undefined ? withoutNestedLists.length : nextOpening.index;
    let rawHtml = withoutNestedLists.slice(start, end);
    const closingAt = rawHtml.search(/<\/li\s*>/i);
    if (closingAt >= 0) {
      rawHtml = rawHtml.slice(0, closingAt);
    }
    const text = toPlainText(rawHtml);
    if (text.length === 0) continue;
    if (BOILERPLATE_PATTERN.test(text) || LEGAL_CHROME_PATTERN.test(text)) continue;
    let linkTextLength = 0;
    for (const anchorMatch of rawHtml.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
      linkTextLength += toPlainText(anchorMatch[1]).length;
    }
    items.push({ text, linkTextLength });
  }
  return items;
}

/*
  The nearest heading at or above `index`, when the page has one.
*/
function findHeadingBefore({ html, index }: { html: string; index: number }): string | undefined {
  let heading: string | undefined;
  for (const match of html.slice(0, index).matchAll(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = toPlainText(match[2]);
    if (text.length > 0 && text.length <= 200) {
      heading = text;
    }
  }
  return heading;
}

interface AdmittedList {
  list: ScrapedList;
  span: ListSpan;
}

/*
  Collect lists, judging each list AS A WHOLE on link density. This is the
  channel `collectProseBlocks` cannot provide: it asks whether an ITEM reads
  like prose (60+ chars), and a skills list never will.
*/
function collectLists(scopeHtml: string): AdmittedList[] {
  const admitted: AdmittedList[] = [];
  for (const span of findListSpans(scopeHtml)) {
    const items = readListItems(span.innerHtml);
    if (items.length === 0) continue;
    const totalTextLength = items.reduce((sum, item) => sum + item.text.length, 0);
    if (totalTextLength === 0) continue;
    const totalLinkTextLength = items.reduce((sum, item) => sum + item.linkTextLength, 0);
    const linkDensity = Math.min(1, totalLinkTextLength / totalTextLength);
    if (linkDensity > LIST_LINK_DENSITY_MAX) continue;
    const headingBefore = findHeadingBefore({ html: scopeHtml, index: span.startIndex });
    admitted.push({
      list: {
        ...(headingBefore === undefined ? {} : { headingBefore }),
        items: items.map((item) => item.text),
        linkDensity,
      },
      span,
    });
  }
  return admitted;
}

/*
  Cut the admitted lists out of the scope before prose collection, so an item
  cannot arrive twice — once as a list item and once as a paragraph. Outermost
  span wins, so an admitted list nested inside an admitted list is removed once.
*/
function removeSpans({ html, spans }: { html: string; spans: ListSpan[] }): string {
  const ordered = [...spans].sort((left, right) => left.startIndex - right.startIndex);
  const disjoint: ListSpan[] = [];
  let coveredUpTo = -1;
  for (const span of ordered) {
    if (span.startIndex < coveredUpTo) continue;
    disjoint.push(span);
    coveredUpTo = span.endIndex;
  }
  let result = "";
  let keptUpTo = 0;
  for (const span of disjoint) {
    result += html.slice(keptUpTo, span.startIndex);
    keptUpTo = span.endIndex;
  }
  return result + html.slice(keptUpTo);
}

/*
  ---------------------------------------------------------------------------
  Image candidates
  ---------------------------------------------------------------------------
*/

/*
  Class/id/alt/url hints that an image is a picture of a person. Ported from
  the old person extractor, where it CHOSE the portrait. Here it only adds a
  string to `hints` — the same regex, no longer allowed to decide anything.
*/
const PORTRAIT_HINT_PATTERN = /\b(portrait|headshot|avatar|profile|photo|person|bio|staff|faculty)\b/i;

const LOGO_HINT_PATTERN = /\b(logo|brandmark|wordmark)\b/i;

const ICON_HINT_PATTERN = /\b(icon|favicon|glyph|badge)\b/i;

const OG_IMAGE_META_KEYS = ["og:image", "og:image:url", "twitter:image"];

const ICON_LINK_REL_PATTERN = /(^|\s)(shortcut\s+)?(icon|apple-touch-icon(-precomposed)?|mask-icon)(\s|$)/i;

/*
  Schema.org fields that carry a picture rather than a description of one.
*/
const STRUCTURED_DATA_IMAGE_FIELDS = ["image", "logo", "photo", "thumbnailUrl"];

interface RawImageCandidate {
  sourceIndex: number;
  /*
    Length of the tag this was read from, so context can start after it.
  */
  tagLength: number;
  rawUrl: string;
  origin: ImageOrigin;
  alt?: string;
  width?: number;
  height?: number;
  hintSource: string;
  hasContext: boolean;
  /*
    What the element carrying this picture calls itself. Set only where a
    picture HAS a carrying element — a background — and it displaces the
    document-order heading rather than supplementing it.
  */
  carrierLabel?: string;
}

function toPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/*
  The largest entry of a `srcset` descriptor list. Only a partial answer to the
  responsive-image problem — a `<picture>`'s `<source srcset>` and a lazily
  hydrated `data-src` are still invisible to an `<img src>` reader — but it is
  two lines and it recovers the srcset-only `<img>`, which is common.
*/
function readLargestSrcsetUrl(srcset: string): string | undefined {
  let bestUrl: string | undefined;
  let bestWeight = -1;
  for (const entry of srcset.split(",")) {
    const parts = entry.trim().split(/\s+/);
    const url = parts[0];
    if (url === undefined || url.length === 0) continue;
    const descriptorMatch = (parts[1] ?? "").match(/^(\d+(?:\.\d+)?)([wx])$/);
    /*
      A pixel-density descriptor is scaled so it never loses to a width one.
    */
    const weight =
      descriptorMatch === null
        ? 1
        : Number(descriptorMatch[1]) * (descriptorMatch[2] === "x" ? 1_000 : 1);
    if (weight > bestWeight) {
      bestWeight = weight;
      bestUrl = url;
    }
  }
  return bestUrl;
}

/*
  An open tag that carries a quoted `style` attribute. A pre-filter, so the
  attribute reader runs on the handful of tags that could hold a background
  rather than on every tag in the document.
*/
const TAG_WITH_STYLE_ATTRIBUTE_PATTERN =
  /<[a-z][a-z0-9-]*\b[^>]*\sstyle\s*=\s*(?:"[^"]*"|'[^']*')[^>]*>/gi;

/*
  `background` and `background-image` only, so `mask-image`, `list-style-image`
  and `border-image` are left alone. The value is consumed as either a plain
  character or a WHOLE parenthesised group, which is what stops a `data:` URI's
  own semicolons from ending the declaration early and hiding a real layer
  declared after it.
*/
const CSS_BACKGROUND_DECLARATION_PATTERN =
  /(?:^|;)\s*background(?:-image)?\s*:((?:[^;(]|\([^)]*\))*)/gi;

/*
  One `url(…)` token: double-quoted, single-quoted, or bare.
*/
const CSS_URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi;

/*
  Every image a `style` attribute's background declarations point at, in the
  order they were written. A layer that is a gradient contributes nothing, and
  a `data:` URI is left to the URL resolver, which refuses any scheme that is
  not http(s) — so it is dropped by the same rule that drops a `mailto:`.
*/
function readCssBackgroundUrls(style: string): string[] {
  const urls: string[] = [];
  for (const declaration of style.matchAll(CSS_BACKGROUND_DECLARATION_PATTERN)) {
    for (const urlMatch of declaration[1].matchAll(CSS_URL_PATTERN)) {
      const url = (urlMatch[1] ?? urlMatch[2] ?? urlMatch[3] ?? "").trim();
      if (url.length > 0) urls.push(url);
    }
  }
  return urls;
}

/*
  How far past a background-carrying tag the end of that element is looked
  for. An element's own heading sits near the top of it; one whose closing tag
  is further away than this is a container so large that no single heading
  describes it, and the search is abandoned rather than guessed at.
*/
const MAX_CARRIER_SCAN_CHARS = 20_000;

/*
  How long an element's own text may be and still read as a NAME for the
  picture it carries rather than a sentence about it.
*/
const MAX_CARRIER_LABEL_CHARS = 80;

/*
  The same bound `findHeadingBefore` puts on a heading it is willing to use.
*/
const MAX_CARRIER_HEADING_CHARS = 200;

const FIRST_HEADING_PATTERN = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/i;

/*
  What the element carrying a background image calls itself, if anything.

  A background belongs to the element it is painted on, so that element
  describes it better than whatever heading last appeared in the document. The
  difference is not academic: when a card puts its picture above its own title
  — which is the ordinary way to build a card — the heading BEFORE the picture
  is the PREVIOUS card's name, and `nearestHeading` is the only context that
  travels to a later step. A confidently wrong name is worse than none.

  So: a heading inside the element wins, then the element's own text when it is
  short enough to be a label, and otherwise nothing at all — leaving the caller
  with the document-order heading it would have used anyway.
*/
function readCarrierLabel({
  html,
  openTag,
  openTagIndex,
}: {
  html: string;
  openTag: string;
  openTagIndex: number;
}): string | undefined {
  const tagNameMatch = openTag.match(/^<([a-z][a-z0-9-]*)/i);
  if (tagNameMatch === null || openTag.endsWith("/>")) {
    return undefined;
  }
  const innerStart = openTagIndex + openTag.length;
  const scanWindow = html.slice(innerStart, innerStart + MAX_CARRIER_SCAN_CHARS);
  /*
    Depth counting starts at zero because the window begins AFTER the open tag,
    so the first closing tag that is not matched by a nested open one is this
    element's. A void element (an <img> or an <hr> with a background) never has
    one, and falls out of here with nothing, which is correct.
  */
  let depth = 0;
  let innerHtml: string | undefined;
  for (const token of tokenizeTag(tagNameMatch[1], scanWindow)) {
    if (!token.isClosing) {
      if (!token.isSelfClosing) depth += 1;
      continue;
    }
    if (depth === 0) {
      innerHtml = scanWindow.slice(0, token.index);
      break;
    }
    depth -= 1;
  }
  if (innerHtml === undefined) {
    return undefined;
  }
  const headingMatch = innerHtml.match(FIRST_HEADING_PATTERN);
  const heading = headingMatch === null ? "" : toPlainText(headingMatch[2]);
  if (heading.length > 0 && heading.length <= MAX_CARRIER_HEADING_CHARS) {
    return heading;
  }
  const label = toPlainText(innerHtml);
  return label.length > 0 && label.length <= MAX_CARRIER_LABEL_CHARS ? label : undefined;
}

function collectImageUrls({ value, into }: { value: unknown; into: string[] }): void {
  if (typeof value === "string") {
    if (value.trim().length > 0) into.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectImageUrls({ value: entry, into });
    }
    return;
  }
  if (isRecord(value)) {
    const url = asText(value.url) ?? asText(value.contentUrl);
    if (url !== undefined) into.push(url);
  }
}

/*
  The og:image meta tag, with its position, resolved in the same order metadata uses.
*/
function findOgImageTag(html: string): { url: string; index: number } | undefined {
  const byKey = new Map<string, { url: string; index: number }>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = (
      getAttribute({ tag, name: "property" }) ??
      getAttribute({ tag, name: "name" }) ??
      ""
    ).toLowerCase();
    const content = getAttribute({ tag, name: "content" });
    if (content === undefined || content.length === 0) continue;
    if (OG_IMAGE_META_KEYS.includes(key) && !byKey.has(key)) {
      byKey.set(key, { url: content, index: match.index });
    }
  }
  for (const key of OG_IMAGE_META_KEYS) {
    const found = byKey.get(key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function collectRawImageCandidates(maskedHtml: string, html: string): RawImageCandidate[] {
  const raw: RawImageCandidate[] = [];

  const ogImageTag = findOgImageTag(html);
  if (ogImageTag !== undefined) {
    raw.push({
      sourceIndex: ogImageTag.index,
      tagLength: 0,
      rawUrl: ogImageTag.url,
      origin: "og-image",
      hintSource: ogImageTag.url,
      hasContext: false,
    });
  }

  const jsonLdScriptPattern =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const scriptMatch of html.matchAll(jsonLdScriptPattern)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(scriptMatch[1].trim());
    } catch {
      continue;
    }
    const topLevel = Array.isArray(parsed) ? parsed : [parsed];
    const nodes: Record<string, unknown>[] = [];
    for (const node of topLevel) {
      if (!isRecord(node)) continue;
      nodes.push(node);
      if (Array.isArray(node["@graph"])) {
        for (const graphNode of node["@graph"]) {
          if (isRecord(graphNode)) nodes.push(graphNode);
        }
      }
    }
    const urls: string[] = [];
    for (const node of nodes) {
      for (const field of STRUCTURED_DATA_IMAGE_FIELDS) {
        collectImageUrls({ value: node[field], into: urls });
      }
    }
    for (const url of urls) {
      raw.push({
        sourceIndex: scriptMatch.index,
        tagLength: 0,
        rawUrl: url,
        origin: "structured-data",
        hintSource: url,
        hasContext: false,
      });
    }
  }

  for (const linkMatch of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = linkMatch[0];
    if (!ICON_LINK_REL_PATTERN.test(getAttribute({ tag, name: "rel" }) ?? "")) continue;
    const href = getAttribute({ tag, name: "href" });
    if (href === undefined) continue;
    raw.push({
      sourceIndex: linkMatch.index,
      tagLength: 0,
      rawUrl: href,
      origin: "link-icon",
      hintSource: `icon ${href}`,
      hasContext: false,
    });
  }

  /*
    Inline images are read from the WHOLE document rather than the content
    scope. The scope exists to protect prose from menus; an image is not prose,
    and the picture a page leads with often sits in a header or a figure that
    the scope deliberately throws away. Recall wins here because a candidate
    decides nothing — origin and hints are what a later step judges it on.
  */
  for (const imgMatch of maskedHtml.matchAll(/<img\b[^>]*>/gi)) {
    const tag = imgMatch[0];
    const src = getAttribute({ tag, name: "src" });
    const srcset = getAttribute({ tag, name: "srcset" });
    const rawUrl =
      src !== undefined && src.length > 0
        ? src
        : srcset === undefined
          ? undefined
          : readLargestSrcsetUrl(srcset);
    if (rawUrl === undefined) continue;
    const alt = getAttribute({ tag, name: "alt" });
    raw.push({
      sourceIndex: imgMatch.index,
      tagLength: tag.length,
      rawUrl,
      origin: "inline",
      ...(alt === undefined || alt.length === 0 ? {} : { alt }),
      ...(toPositiveInteger(getAttribute({ tag, name: "width" })) === undefined
        ? {}
        : { width: toPositiveInteger(getAttribute({ tag, name: "width" })) }),
      ...(toPositiveInteger(getAttribute({ tag, name: "height" })) === undefined
        ? {}
        : { height: toPositiveInteger(getAttribute({ tag, name: "height" })) }),
      hintSource: `${getAttribute({ tag, name: "class" }) ?? ""} ${
        getAttribute({ tag, name: "id" }) ?? ""
      } ${alt ?? ""} ${rawUrl}`,
      hasContext: true,
    });
  }

  /*
    Pictures the page paints instead of marking up. Read from the same masked
    whole document as `<img>`, so a `<style>` block's rules and a framework's
    serialised props inside a `<script>` are both already gone: what is left is
    an inline `style=` attribute, which is the only CSS that arrived with the
    HTML we fetched. An external stylesheet would need a second fetch and is
    deliberately not attempted here.
  */
  for (const tagMatch of maskedHtml.matchAll(TAG_WITH_STYLE_ATTRIBUTE_PATTERN)) {
    const tag = tagMatch[0];
    const style = getAttribute({ tag, name: "style" });
    if (style === undefined) continue;
    const href = getAttribute({ tag, name: "href" });
    const carrierLabel = readCarrierLabel({
      html: maskedHtml,
      openTag: tag,
      openTagIndex: tagMatch.index,
    });
    for (const rawUrl of readCssBackgroundUrls(style)) {
      raw.push({
        sourceIndex: tagMatch.index,
        tagLength: tag.length,
        rawUrl,
        origin: "css-background",
        ...(carrierLabel === undefined ? {} : { carrierLabel }),
        /*
          A background has no `alt` and no `width`/`height` to read, so the
          element it sits on is the whole of what the page said about it — its
          class, its id, and where it links to.
        */
        hintSource: `${getAttribute({ tag, name: "class" }) ?? ""} ${
          getAttribute({ tag, name: "id" }) ?? ""
        } ${href ?? ""} ${rawUrl}`,
        hasContext: true,
      });
    }
  }

  return raw;
}

function readHints({
  hintSource,
  origin,
  width,
  height,
}: {
  hintSource: string;
  origin: ImageOrigin;
  width?: number;
  height?: number;
}): string[] {
  const hints: string[] = [];
  if (PORTRAIT_HINT_PATTERN.test(hintSource)) hints.push("portrait-ish");
  if (LOGO_HINT_PATTERN.test(hintSource)) hints.push("logo-ish");
  if (origin === "link-icon" || ICON_HINT_PATTERN.test(hintSource)) hints.push("icon-ish");
  if (width !== undefined && height !== undefined) {
    const ratio = width / height;
    hints.push(ratio >= 0.9 && ratio <= 1.1 ? "square" : ratio < 0.9 ? "tall" : "wide");
    if (width < 100 && height < 100) hints.push("small");
  }
  return hints;
}

/*
  Roughly `SURROUNDING_TEXT_CHARS` of the page's own words either side of a tag.
*/
function readSurroundingText({
  html,
  startIndex,
  endIndex,
}: {
  html: string;
  startIndex: number;
  endIndex: number;
}): string | undefined {
  const half = Math.floor(SURROUNDING_TEXT_CHARS / 2);
  /*
    A fixed-width window lands mid-tag at both ends, and the halves of a tag it
    leaves behind are not text the page wrote — `toPlainText` cannot strip a
    `<meta ... content="` with no opening `<`. So each window is trimmed back to
    a whole-tag boundary before it is flattened.
  */
  const beforeWindow = html
    .slice(Math.max(0, startIndex - SURROUNDING_SCAN_CHARS), startIndex)
    .replace(/^[^<]*>/, "");
  const afterWindow = html
    .slice(endIndex, endIndex + SURROUNDING_SCAN_CHARS)
    .replace(/<[^>]*$/, "");
  const before = toPlainText(beforeWindow).slice(-half);
  const after = toPlainText(afterWindow).slice(0, half);
  const surroundingText = [before, after]
    .filter((part) => part.length > 0)
    .join(" ")
    .trim()
    .slice(0, SURROUNDING_TEXT_CHARS);
  return surroundingText.length === 0 ? undefined : surroundingText;
}

function collectImageCandidates({
  html,
  maskedHtml,
  finalUrl,
}: {
  html: string;
  maskedHtml: string;
  finalUrl: string;
}): ImageCandidate[] {
  const raw = collectRawImageCandidates(maskedHtml, html).sort(
    (left, right) => left.sourceIndex - right.sourceIndex,
  );
  const candidates: ImageCandidate[] = [];
  const candidateIndexByUrl = new Map<string, number>();
  for (const entry of raw) {
    const sourceUrl = toAbsoluteHttpUrl({ candidate: entry.rawUrl, baseUrl: finalUrl });
    if (sourceUrl === undefined) continue;

    /*
      A picture painted ON an element is described by that element. Everything
      else — an <img>, an og:image, a JSON-LD url — has no carrying element to
      ask, so it keeps the heading that precedes it in the document.
    */
    const nearestHeading =
      entry.carrierLabel ??
      findHeadingBefore({ html: maskedHtml, index: entry.sourceIndex });
    const surroundingText = entry.hasContext
      ? readSurroundingText({
          html: maskedHtml,
          startIndex: entry.sourceIndex,
          endIndex: entry.sourceIndex + entry.tagLength,
        })
      : undefined;
    const hints = readHints({
      hintSource: entry.hintSource,
      origin: entry.origin,
      ...(entry.width === undefined ? {} : { width: entry.width }),
      ...(entry.height === undefined ? {} : { height: entry.height }),
    });

    /*
      The same picture usually appears more than once — as og:image, as a
      JSON-LD `image`, and as the `<img>` itself. Those are one candidate, and
      the earliest wins its id, position, and origin (head-level provenance is
      the stronger claim, and og-image/structured-data are budget-protected).
      But the later sightings are where the alt text, the dimensions, and the
      surrounding prose live, so they are MERGED IN rather than discarded —
      dropping them would throw away the only description the page wrote.
    */
    const existingIndex = candidateIndexByUrl.get(sourceUrl);
    if (existingIndex !== undefined) {
      const existing = candidates[existingIndex];
      candidates[existingIndex] = {
        ...existing,
        ...(existing.alt === undefined && entry.alt !== undefined ? { alt: entry.alt } : {}),
        ...(existing.width === undefined && entry.width !== undefined
          ? { width: entry.width }
          : {}),
        ...(existing.height === undefined && entry.height !== undefined
          ? { height: entry.height }
          : {}),
        ...(existing.nearestHeading === undefined && nearestHeading !== undefined
          ? { nearestHeading }
          : {}),
        ...(existing.surroundingText === undefined && surroundingText !== undefined
          ? { surroundingText }
          : {}),
        hints: [...new Set([...existing.hints, ...hints])],
      };
      continue;
    }

    const documentOrder = candidates.length + 1;
    candidateIndexByUrl.set(sourceUrl, candidates.length);
    candidates.push({
      id: `img_${documentOrder}`,
      sourceUrl,
      ...(entry.alt === undefined ? {} : { alt: entry.alt }),
      ...(entry.width === undefined ? {} : { width: entry.width }),
      ...(entry.height === undefined ? {} : { height: entry.height }),
      documentOrder,
      ...(nearestHeading === undefined ? {} : { nearestHeading }),
      ...(surroundingText === undefined ? {} : { surroundingText }),
      origin: entry.origin,
      hints,
    });
  }
  return candidates;
}

/*
  ---------------------------------------------------------------------------
  The token budget
  ---------------------------------------------------------------------------
*/

/*
  Kept whole when the budget bites, because losing these is losing the page.
*/
const MAX_KEPT_PARAGRAPHS = 2;
const MAX_ITEMS_PER_LIST = 12;
const MAX_LISTS = 6;
const MAX_STRUCTURED_DATA_NODES = 4;
const MAX_IMAGE_CANDIDATES = 12;
const MAX_CANDIDATES_WITH_SURROUNDING_TEXT = 6;

const PRIORITY_STRUCTURED_DATA_TYPE_PATTERN =
  /^(person|organization|corporation|localbusiness|product|event|(news|blog|report|scholarly)?article|blogposting)$/i;

interface BudgetedContent {
  blocks: ProseBlock[];
  lists: ScrapedList[];
  structuredData: Record<string, unknown>[];
  imageCandidates: ImageCandidate[];
}

function measureList(list: ScrapedList): number {
  return (
    (list.headingBefore?.length ?? 0) +
    list.items.reduce((sum, item) => sum + item.length, 0)
  );
}

function measureImageCandidate(candidate: ImageCandidate): number {
  return (
    candidate.sourceUrl.length +
    (candidate.alt?.length ?? 0) +
    (candidate.nearestHeading?.length ?? 0) +
    (candidate.surroundingText?.length ?? 0)
  );
}

/*
  What the budget governs: everything the PAGE said. The identity fields
  (finalUrl, canonicalUrl, siteName, title, description) are deliberately not
  counted, because they are never droppable — charging for something that
  cannot be sold makes the budget unsatisfiable at small values.
*/
function measureContent(content: BudgetedContent): number {
  return (
    content.blocks.reduce((sum, block) => sum + block.text.length, 0) +
    content.lists.reduce((sum, list) => sum + measureList(list), 0) +
    content.structuredData.reduce((sum, node) => sum + JSON.stringify(node).length, 0) +
    content.imageCandidates.reduce((sum, candidate) => sum + measureImageCandidate(candidate), 0)
  );
}

/*
  The first heading and the first two paragraphs — a page states what it is at the top.
*/
function findProtectedBlockIndexes(blocks: ProseBlock[]): Set<number> {
  const protectedIndexes = new Set<number>();
  const firstHeadingIndex = blocks.findIndex((block) => block.kind === "heading");
  if (firstHeadingIndex >= 0) {
    protectedIndexes.add(firstHeadingIndex);
  }
  let keptParagraphs = 0;
  for (const [index, block] of blocks.entries()) {
    if (keptParagraphs >= MAX_KEPT_PARAGRAPHS) break;
    if (block.kind !== "paragraph") continue;
    protectedIndexes.add(index);
    keptParagraphs += 1;
  }
  return protectedIndexes;
}

/*
  Fit the scrape into `maxContentChars` by a strict, deterministic sequence.
  Each step runs only if the ones before it did not free enough, so the order
  IS the policy: prose tail first (a page says what it is at the top), then
  list depth, then list count, then structured data, then images, then the
  context around images.
*/
function applyContentBudget({
  content,
  maxContentChars,
}: {
  content: BudgetedContent;
  maxContentChars: number;
}): BudgetedContent & { isTruncated: boolean } {
  let blocks = content.blocks;
  let lists = content.lists;
  let structuredData = content.structuredData;
  let imageCandidates = content.imageCandidates;
  let hasDropped = false;

  function isOverBudget(): boolean {
    return measureContent({ blocks, lists, structuredData, imageCandidates }) > maxContentChars;
  }

  /*
    1. Trailing prose blocks, later before earlier.
  */
  if (isOverBudget()) {
    const protectedIndexes = findProtectedBlockIndexes(blocks);
    const droppedIndexes = new Set<number>();
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (!isOverBudget()) break;
      if (protectedIndexes.has(index)) continue;
      droppedIndexes.add(index);
      blocks = content.blocks.filter((_, blockIndex) => !droppedIndexes.has(blockIndex));
      hasDropped = true;
    }
  }

  /*
    2. List items beyond MAX_ITEMS_PER_LIST per list.
  */
  if (isOverBudget() && lists.some((list) => list.items.length > MAX_ITEMS_PER_LIST)) {
    lists = lists.map((list) =>
      list.items.length <= MAX_ITEMS_PER_LIST
        ? list
        : { ...list, items: list.items.slice(0, MAX_ITEMS_PER_LIST) },
    );
    hasDropped = true;
  }

  /*
    3. Lists beyond MAX_LISTS, keeping the lowest link density — the least menu-like.
  */
  if (isOverBudget() && lists.length > MAX_LISTS) {
    const keptLists = new Set(
      [...lists]
        .sort((left, right) => left.linkDensity - right.linkDensity)
        .slice(0, MAX_LISTS),
    );
    lists = lists.filter((list) => keptLists.has(list));
    hasDropped = true;
  }

  /*
    4. structuredData beyond MAX_STRUCTURED_DATA_NODES, priority types first, document order kept.
  */
  if (isOverBudget() && structuredData.length > MAX_STRUCTURED_DATA_NODES) {
    const priorityNodes = structuredData.filter((node) =>
      hasJsonLdType({ node, pattern: PRIORITY_STRUCTURED_DATA_TYPE_PATTERN }),
    );
    const otherNodes = structuredData.filter(
      (node) => !hasJsonLdType({ node, pattern: PRIORITY_STRUCTURED_DATA_TYPE_PATTERN }),
    );
    const keptNodes = new Set(
      [...priorityNodes, ...otherNodes].slice(0, MAX_STRUCTURED_DATA_NODES),
    );
    structuredData = structuredData.filter((node) => keptNodes.has(node));
    hasDropped = true;
  }

  /*
    5. imageCandidates beyond MAX_IMAGE_CANDIDATES; og-image and structured-data always survive.
  */
  if (isOverBudget() && imageCandidates.length > MAX_IMAGE_CANDIDATES) {
    const alwaysKept = imageCandidates.filter(
      (candidate) => candidate.origin === "og-image" || candidate.origin === "structured-data",
    );
    const fillable = imageCandidates.filter(
      (candidate) => candidate.origin !== "og-image" && candidate.origin !== "structured-data",
    );
    const keptCandidates = new Set([
      ...alwaysKept,
      ...fillable.slice(0, Math.max(0, MAX_IMAGE_CANDIDATES - alwaysKept.length)),
    ]);
    imageCandidates = imageCandidates.filter((candidate) => keptCandidates.has(candidate));
    hasDropped = true;
  }

  /*
    6. surroundingText on candidates beyond the first MAX_CANDIDATES_WITH_SURROUNDING_TEXT.
  */
  if (
    isOverBudget() &&
    imageCandidates
      .slice(MAX_CANDIDATES_WITH_SURROUNDING_TEXT)
      .some((candidate) => candidate.surroundingText !== undefined)
  ) {
    imageCandidates = imageCandidates.map((candidate, index) => {
      if (index < MAX_CANDIDATES_WITH_SURROUNDING_TEXT) return candidate;
      const withoutContext: ImageCandidate = { ...candidate };
      delete withoutContext.surroundingText;
      return withoutContext;
    });
    hasDropped = true;
  }

  return { blocks, lists, structuredData, imageCandidates, isTruncated: hasDropped };
}

/*
  ---------------------------------------------------------------------------
  The extractor
  ---------------------------------------------------------------------------
*/

export interface ExtractPageInput {
  /*
    The fetched page HTML (already capped by fetchPage).
  */
  html: string;
  /*
    The post-redirect URL — the base for resolving relative URLs.
  */
  finalUrl: string;
  /*
    Override the content budget. Present so the drop order is testable.
  */
  maxContentChars?: number;
}

export type ExtractPageRefusalReason = "paywalled" | "no_main_content";

export type ExtractPageResult =
  | { isOk: true; scrape: PageScrape }
  | { isOk: false; reason: ExtractPageRefusalReason; message: string };

const MASKED_REGION_PATTERNS = [
  /<script\b[^>]*>[\s\S]*?<\/script>/gi,
  /<style\b[^>]*>[\s\S]*?<\/style>/gi,
  /<template\b[^>]*>[\s\S]*?<\/template>/gi,
  /<!--[\s\S]*?-->/g,
];

/*
  Read one fetched page into a `PageScrape`, or refuse honestly. Pure and
  deterministic — safe to unit-test on saved fixtures. A refusal is a normal
  return value; nothing here throws on unreadable input.
*/
/*
  How much of a content scope's text ONE non-content tag may take away before
  the removal is treated as evidence the tag was mismarked.

  `NON_CONTENT_TAGS` encodes a fair assumption — that <nav>, <aside>, <header>,
  <footer>, <figure> and friends hold chrome rather than content. Real sites
  apply those tags far more loosely than the spec intends, and page builders
  are the worst offenders.

  Measured: a university faculty page puts the ENTIRE profile — the biography,
  the research summary, the contact details — inside an <aside>. Stripping it
  took the scope from 1,856 characters to 7, and the page was then refused for
  having no readable content. The tag was not marking a sidebar; it was
  wrapping the page.

  So: chrome is by definition the minority of a content scope. A single tag
  that accounts for almost all of the scope's text is not that scope's chrome,
  whatever it calls itself, and removing it is far more likely to be wrong than
  right. 0.85 leaves ordinary chrome (a nav and a footer inside a body scope
  are nowhere near this) removable, while refusing the pathological case.

  Junk that survives this guard is not thereby promoted to content: the prose
  collector still drops link-dense text, and the list channel still admits a
  list only on its link density. This guard decides what is CONSIDERED, not
  what is kept.
*/
const MAX_NON_CONTENT_REMOVAL_RATIO = 0.85;

/*
  Remove one non-content tag's subtrees, unless doing so would take away
  essentially the whole scope — in which case the tag is mismarked and the
  scope is returned untouched.
*/
function removeNonContentTag({ html, tagName }: { html: string; tagName: string }): string {
  const stripped = removeTagBlocks({ html, tagName });

  /*
    Second guard: a removal that carries off the scope's <h1> is removing the
    page's title, and site chrome does not contain the page's title — a banner
    holds a logo and a menu.

    Measured: a portfolio puts <h1>its owner's name</h1> inside a <header>,
    which is exactly what <header> is FOR in the spec (the header of the
    nearest sectioning content, not necessarily the site banner). Stripping it
    deleted the person's name from a page about that person, and cost far less
    than the ratio guard above catches, so the ratio alone did not save it.

    On a page whose site banner really is chrome, the article's own <h1> lives
    inside <article>/<main> and survives the banner's removal, so this guard
    does not fire and the banner still goes.
  */
  const hasHeadingBefore = /<h1\b/i.test(html);
  if (hasHeadingBefore && !/<h1\b/i.test(stripped)) {
    return html;
  }

  const lengthBefore = toPlainText(html).length;
  if (lengthBefore === 0) {
    return stripped;
  }
  const removedRatio = (lengthBefore - toPlainText(stripped).length) / lengthBefore;
  return removedRatio > MAX_NON_CONTENT_REMOVAL_RATIO ? html : stripped;
}

/*
  Whether a page's declared canonical URL is on the same site as the page that
  was actually fetched.

  A canonical tag is a publisher's claim about its own page, and it is usually
  right — but a stale build can leave one pointing at a host nobody should be
  linked to. Measured on a real portfolio: both the canonical and the og:image
  pointed at a long-dead preview deployment on a different domain entirely, so
  every attribution link built from that page would have sent readers to a
  preview build instead of the site.

  Differing by subdomain, path, or scheme is completely normal (a fetch of
  `example.com` canonicalising to `www.example.com` is the common case) and
  stays trusted. A different registrable domain is not a canonicalisation; it
  is a page pointing somewhere else, and the URL actually fetched is the more
  trustworthy of the two.
*/
function getIsSameSiteCanonical({
  canonicalUrl,
  finalUrl,
}: {
  canonicalUrl: string;
  finalUrl: string;
}): boolean {
  try {
    const canonicalHost = new URL(canonicalUrl).hostname.replace(/^www\./i, "").toLowerCase();
    const finalHost = new URL(finalUrl).hostname.replace(/^www\./i, "").toLowerCase();
    return (
      canonicalHost === finalHost ||
      canonicalHost.endsWith(`.${finalHost}`) ||
      finalHost.endsWith(`.${canonicalHost}`)
    );
  } catch {
    return false;
  }
}

export function extractPage({
  html,
  finalUrl,
  maxContentChars = MAX_PAGE_CONTENT_CHARS,
}: ExtractPageInput): ExtractPageResult {
  const metadata = readPageMetadata(html);

  /*
    Order matters: junk-class subtrees first (they may CONTAIN structural tags
    whose removal would otherwise splice around them), then structural
    non-content tags.
  */
  const { scopeHtml } = selectContentScope(html);
  const cleanedScope = cleanContentScope(scopeHtml);

  /*
    The PAYWALL gate is measured exactly as the article extractor measured it —
    every prose block the collector admits, before any list is moved to its own
    channel. A teaser is prose, and widening this measure would change which
    pages get called paywalled, which is not what this change is for.
  */
  const teaserText = collectProseBlocks(cleanedScope)
    .map((block) => block.text)
    .join("\n\n");

  const hasPaywallSignal =
    metadata.isDeclaredPaywalled || PAYWALL_TEXT_PATTERN.test(toPlainText(cleanedScope));
  if (hasPaywallSignal && teaserText.length < MAX_PAYWALLED_TEASER_CHARS) {
    return { isOk: false, reason: "paywalled", message: PAYWALL_REFUSAL_MESSAGE };
  }

  const admittedLists = collectLists(cleanedScope);
  const blocks = collectProseBlocks(
    removeSpans({ html: cleanedScope, spans: admittedLists.map((admitted) => admitted.span) }),
  );

  /*
    The NO-CONTENT gate counts what this scrape actually recovered: prose AND
    the items of every admitted list.

    Counting prose alone reproduces, at the refusal gate, the exact bug this
    module exists to fix. The list channel was added because a page can carry
    its content as short list items that the prose collector drops; gating on
    prose then throws that page away AFTER successfully reading it. Measured on
    real pages: a project's own homepage with 22 genuine list items worth 670
    characters was refused on 50 characters of prose, and an event page with
    four real headings and no paragraphs was refused too.

    The floor itself does not move, so a page that genuinely has nothing is
    still refused — a link index of 244 links and two sentences of its own
    prose still does not clear it, which is the correct answer for that page.
  */
  const recoveredText = [
    ...blocks.map((block) => block.text),
    ...admittedLists.flatMap((admitted) => admitted.list.items),
  ].join("\n\n");
  if (recoveredText.length < MIN_MAIN_TEXT_CHARS) {
    return {
      isOk: false,
      reason: "no_main_content",
      message: NO_MAIN_CONTENT_REFUSAL_MESSAGE,
    };
  }

  let maskedHtml = html;
  for (const pattern of MASKED_REGION_PATTERNS) {
    maskedHtml = maskRegions({ html: maskedHtml, pattern });
  }

  const budgeted = applyContentBudget({
    content: {
      blocks,
      lists: admittedLists.map((admitted) => admitted.list),
      structuredData: readJsonLdNodes(html),
      imageCandidates: collectImageCandidates({ html, maskedHtml, finalUrl }),
    },
    maxContentChars,
  });

  const sourceHostname = new URL(finalUrl).hostname.replace(/^www\./i, "");
  const siteName = metadata.ogSiteName ?? metadata.ldPublisher ?? sourceHostname;

  let title = metadata.ogTitle ?? metadata.ldHeadline ?? metadata.titleTag ?? siteName;
  const escapedSiteName = siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  title = title.replace(new RegExp(`\\s*[|–—-]\\s*${escapedSiteName}\\s*$`, "i"), "").trim();
  if (title.length === 0) {
    title = siteName;
  }

  const declaredCanonicalUrl =
    toAbsoluteHttpUrl({ candidate: metadata.canonicalHref, baseUrl: finalUrl }) ??
    toAbsoluteHttpUrl({ candidate: metadata.ogUrl, baseUrl: finalUrl });
  const canonicalUrl =
    declaredCanonicalUrl !== undefined &&
    getIsSameSiteCanonical({ canonicalUrl: declaredCanonicalUrl, finalUrl })
      ? declaredCanonicalUrl
      : finalUrl;

  const description =
    metadata.description === undefined
      ? undefined
      : metadata.description.slice(0, MAX_DESCRIPTION_CHARS);

  return {
    isOk: true,
    scrape: {
      finalUrl,
      canonicalUrl,
      siteName,
      title,
      ...(description === undefined ? {} : { description }),
      blocks: budgeted.blocks,
      lists: budgeted.lists,
      structuredData: budgeted.structuredData,
      imageCandidates: budgeted.imageCandidates,
      isTruncated: budgeted.isTruncated,
    },
  };
}
