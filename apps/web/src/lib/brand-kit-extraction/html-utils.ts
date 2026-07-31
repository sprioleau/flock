/**
 * Shared regex-scale HTML scanning helpers for the brand-kit extraction
 * pipeline — used by both the signal harvester (harvest.ts) and the
 * deterministic site-identity extractor (extract-site-identity.ts).
 *
 * Deliberately NOT a real HTML parser: bounded regex scanning is enough for
 * the head-metadata and attribute reads these modules do, and it keeps the
 * pipeline dependency-free.
 */

/** Decode the handful of entities that show up in titles/attributes. */
export function decodeBasicEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** All <tag …> matches for a tag name (self-closing or not), as raw strings. */
export function findTags({ html, tagName }: { html: string; tagName: string }): string[] {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  return html.match(pattern) ?? [];
}

/** Read one attribute value from a raw tag string. */
export function getAttribute({ tag, name }: { tag: string; name: string }): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = tag.match(pattern);
  if (match === null) {
    return null;
  }
  return decodeBasicEntities(match[2] ?? match[3] ?? match[4] ?? "");
}

/** Resolve a candidate URL against the page URL; http(s) absolute URLs only. */
export function resolveUrl({ raw, baseUrl }: { raw: string; baseUrl: string }): string | null {
  if (raw.startsWith("data:")) {
    return null;
  }
  try {
    const resolved = new URL(raw, baseUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.toString()
      : null;
  } catch {
    return null;
  }
}

/** The content of the first <meta name|property="key"> (case-insensitive). */
export function findMetaContent({ html, key }: { html: string; key: string }): string | null {
  for (const tag of findTags({ html, tagName: "meta" })) {
    const name = getAttribute({ tag, name: "name" }) ?? getAttribute({ tag, name: "property" });
    if (name?.toLowerCase() === key) {
      const content = getAttribute({ tag, name: "content" });
      if (content !== null && content.length > 0) {
        return content;
      }
    }
  }
  return null;
}

/** The page's <title> text, entity-decoded, or null. */
export function findPageTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  return match === null ? null : decodeBasicEntities(match[1]) || null;
}
