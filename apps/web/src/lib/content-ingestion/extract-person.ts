import {
  asText,
  collectProseBlocks,
  getAttribute,
  hasJsonLdType,
  NON_CONTENT_TAGS,
  readJsonLdNodes,
  readPageMetadata,
  removeJunkBlocks,
  removeTagBlocks,
  selectContentScope,
  toAbsoluteHttpUrl,
  toPlainText,
} from "./extract-page";

/**
 * Person-profile extraction (Phase 7.4b) — pure HTML → who the page says this
 * person is. No network, no LLM, no DOM.
 *
 * Same honest-harvesting philosophy as the article extractor: every string
 * that comes out was literally present in the fetched markup. Nothing is
 * inferred — not a pronoun, not a seniority level, not a field of study. A
 * profile page that doesn't state a role yields no role.
 *
 * Sources, in preference order:
 *   1. JSON-LD `Person` (name, jobTitle, worksFor, image, description) — the
 *      publisher's own structured statement about the person.
 *   2. OpenGraph / meta tags (og:title, og:image, description, profile:*).
 *   3. Page structure: the first h1, a nearby role line, the prose body.
 */

/** Bio budget — a spotlight paragraph, not a résumé. */
const MAX_BIO_CHARS = 600;

/** Per-fact budget; longer prose blocks are trimmed at a word boundary. */
const MAX_FACT_CHARS = 320;

/** How many page-derived facts we hand the model. */
const MAX_PAGE_FACTS = 6;

/** Below this much prose the page isn't a readable profile. */
const MIN_PROFILE_TEXT_CHARS = 80;

/** Roles read like "Professor of X", "Head of Y", "Founder & CEO". */
const ROLE_LINE_PATTERN =
  /\b(professor|lecturer|instructor|researcher|scientist|fellow|dean|chair|director|head of|founder|co-founder|ceo|cto|coo|cfo|president|vice president|vp|manager|engineer|designer|editor|reporter|correspondent|analyst|partner|principal|counsel|attorney|physician|doctor|dr\.|nurse|curator|coach|advisor|adviser|consultant|specialist|associate|assistant)\b/i;

/** Class/id hints that an element holds the person's title line. */
const ROLE_CLASS_PATTERN = /\b(title|role|position|job-?title|subtitle|designation|affiliation)\b/i;

/** Class/id/alt hints that an image is the person's portrait. */
const PORTRAIT_HINT_PATTERN = /\b(portrait|headshot|avatar|profile|photo|person|bio|staff|faculty)\b/i;

export interface PersonPageFact {
  text: string;
  sourceUrl: string;
}

export interface ExtractedPerson {
  name: string;
  role?: string;
  organization?: string;
  sourceName: string;
  profileUrl: string;
  /** The ORIGINAL image URL as found on the page — the caller rehosts it. */
  photoSourceUrl?: string;
  bio?: string;
  facts: PersonPageFact[];
}

export type ExtractPersonResult =
  | { isOk: true; person: ExtractedPerson }
  | { isOk: false; reason: string; message: string };

export interface ExtractPersonInput {
  /** The fetched page HTML (already capped by fetchPage). */
  html: string;
  /** The post-redirect URL — the base for resolving relative URLs. */
  finalUrl: string;
  /** The name the user gave, when they gave one. Used only as a fallback. */
  personName?: string;
}

/** Trim to a budget at a word boundary, with an ellipsis when cut. */
function condense({ text, maxChars }: { text: string; maxChars: number }): string {
  if (text.length <= maxChars) {
    return text;
  }
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > maxChars / 2 ? lastSpace : maxChars).trimEnd()}…`;
}

/** The first JSON-LD node describing a Person. */
function readJsonLdPerson(html: string): Record<string, unknown> | undefined {
  return readJsonLdNodes(html).find((node) => hasJsonLdType({ node, pattern: /^person$/i }));
}

/** The text of the first h1 on the page, when it has one. */
function readFirstHeading(html: string): string | undefined {
  const match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const text = match === null ? "" : toPlainText(match[1]);
  return text.length === 0 || text.length > 120 ? undefined : text;
}

/**
 * A role/title line: an element whose class or id says so, else the first
 * short line in the page's prose that reads like a job title.
 */
function findRoleLine({ html, proseTexts }: { html: string; proseTexts: string[] }): string | undefined {
  const taggedPattern = /<(p|h2|h3|span|div)\b([^>]*)>([\s\S]{0,300}?)<\/\1>/gi;
  for (const match of html.matchAll(taggedPattern)) {
    const attributes = match[2];
    const classAndId = `${getAttribute({ tag: `<x ${attributes}>`, name: "class" }) ?? ""} ${
      getAttribute({ tag: `<x ${attributes}>`, name: "id" }) ?? ""
    }`;
    if (!ROLE_CLASS_PATTERN.test(classAndId)) {
      continue;
    }
    const text = toPlainText(match[3]);
    if (text.length >= 3 && text.length <= 120) {
      return text;
    }
  }
  return proseTexts.find((text) => text.length <= 120 && ROLE_LINE_PATTERN.test(text));
}

/** The most portrait-like image on the page, as an absolute URL. */
function findPortraitUrl({ html, finalUrl }: { html: string; finalUrl: string }): string | undefined {
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const hints = `${getAttribute({ tag, name: "class" }) ?? ""} ${
      getAttribute({ tag, name: "id" }) ?? ""
    } ${getAttribute({ tag, name: "alt" }) ?? ""}`;
    if (!PORTRAIT_HINT_PATTERN.test(hints)) {
      continue;
    }
    const absolute = toAbsoluteHttpUrl({
      candidate: getAttribute({ tag, name: "src" }),
      baseUrl: finalUrl,
    });
    if (absolute !== undefined) {
      return absolute;
    }
  }
  return undefined;
}

/**
 * Extract one person's public profile from a fetched page, or refuse
 * honestly. Pure and deterministic — safe to unit-test on saved fixtures.
 */
export function extractPerson({
  html,
  finalUrl,
  personName,
}: ExtractPersonInput): ExtractPersonResult {
  const metadata = readPageMetadata(html);
  const ldPerson = readJsonLdPerson(html);

  const { scopeHtml } = selectContentScope(html);
  let cleanedScope = removeJunkBlocks(scopeHtml);
  for (const tagName of NON_CONTENT_TAGS) {
    cleanedScope = removeTagBlocks({ html: cleanedScope, tagName });
  }
  const proseBlocks = collectProseBlocks(cleanedScope);
  const paragraphTexts = proseBlocks
    .filter((block) => block.kind === "paragraph")
    .map((block) => block.text);
  const allProseTexts = proseBlocks.map((block) => block.text);
  const proseLength = paragraphTexts.join(" ").length;

  const sourceHostname = new URL(finalUrl).hostname.replace(/^www\./i, "");
  const sourceName = metadata.ogSiteName ?? sourceHostname;

  // Name: the publisher's structured claim, then the page's own headline,
  // then the og:title with the site suffix stripped, then what the user said.
  let name =
    asText(ldPerson?.name) ??
    readFirstHeading(html) ??
    (metadata.ogTitle === undefined
      ? undefined
      : metadata.ogTitle
          .replace(
            new RegExp(`\\s*[|–—-]\\s*${sourceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"),
            "",
          )
          .trim()) ??
    personName;

  if (name === undefined || name.length === 0) {
    return {
      isOk: false,
      reason: "no_person_found",
      message:
        "That page doesn't name a person we could read — it may be a directory, a listing, or a page that loads its content after opening. Try a direct link to their profile.",
    };
  }
  name = condense({ text: name, maxChars: 120 });

  if (proseLength < MIN_PROFILE_TEXT_CHARS && metadata.description === undefined) {
    return {
      isOk: false,
      reason: "no_profile_content",
      message: `That page names ${name} but has no readable description of them, so there was nothing to build a spotlight from. Try their fuller bio page, or tell us what you'd like the section to say.`,
    };
  }

  const profileUrl =
    toAbsoluteHttpUrl({ candidate: metadata.canonicalHref, baseUrl: finalUrl }) ??
    toAbsoluteHttpUrl({ candidate: metadata.ogUrl, baseUrl: finalUrl }) ??
    finalUrl;

  const role = asText(ldPerson?.jobTitle) ?? findRoleLine({ html, proseTexts: allProseTexts });
  const organization = asText(ldPerson?.worksFor) ?? asText(ldPerson?.affiliation);

  const bioSource =
    asText(ldPerson?.description) ??
    (paragraphTexts.length > 0 ? paragraphTexts.slice(0, 2).join(" ") : metadata.description);
  const bio = bioSource === undefined ? undefined : condense({ text: bioSource, maxChars: MAX_BIO_CHARS });

  // Facts: the page's own paragraphs, each attributed to the profile URL. The
  // bio paragraphs are excluded so the model isn't handed the same sentence
  // twice and pad the section with it.
  const factTexts = paragraphTexts.slice(bioSource === metadata.description ? 0 : 2);
  const facts: PersonPageFact[] = factTexts
    .slice(0, MAX_PAGE_FACTS)
    .map((text) => ({ text: condense({ text, maxChars: MAX_FACT_CHARS }), sourceUrl: profileUrl }));

  const photoSourceUrl =
    toAbsoluteHttpUrl({ candidate: asText(ldPerson?.image), baseUrl: finalUrl }) ??
    findPortraitUrl({ html, finalUrl }) ??
    toAbsoluteHttpUrl({ candidate: metadata.ogImage, baseUrl: finalUrl });

  return {
    isOk: true,
    person: {
      name,
      ...(role === undefined ? {} : { role: condense({ text: role, maxChars: 160 }) }),
      ...(organization === undefined ? {} : { organization }),
      sourceName,
      profileUrl,
      ...(photoSourceUrl === undefined ? {} : { photoSourceUrl }),
      ...(bio === undefined ? {} : { bio }),
      facts,
    },
  };
}
