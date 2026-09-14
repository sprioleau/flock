export interface BrandKitGenerationIntent {
  sourceUrl: string;
}

const WEBSITE_URL_PATTERN =
  /(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d{2,5})?(?:\/[^\s<>"']*)?/gi;
const BRAND_KIT_PATTERN = /\bbrand[\s-]?kit\b/i;
const BRAND_KIT_ACTION_PATTERN =
  /\b(?:add|build|create|generate|pull|refresh|redo|rebuild|repull|scrape|update)\b/i;
const SOURCE_CUE_PATTERN = /\b(?:based\s+on|for|from|using|with)\b/i;

/*
  Remove sentence punctuation that is commonly attached to a URL in chat
  without changing punctuation that belongs to a query or path.
*/
function trimWebsiteUrlCandidate(candidate: string): string {
  return candidate.replace(/[),.;!?]+$/g, "");
}

/*
  Canonicalize only the public URL shape. The generation route remains the
  authority for SSRF checks and resource caps; this helper only decides
  whether a user's message is an explicit brand-kit request.
*/
function normalizeWebsiteUrl(candidate: string): string | null {
  const trimmedCandidate = trimWebsiteUrlCandidate(candidate);
  const withProtocol = /^https?:\/\//i.test(trimmedCandidate)
    ? trimmedCandidate
    : `https://${trimmedCandidate}`;
  try {
    const parsedUrl = new URL(withProtocol);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null;
    }
    if (parsedUrl.hostname.length === 0) {
      return null;
    }
    const path = parsedUrl.pathname === "/" ? "" : parsedUrl.pathname;
    return `${parsedUrl.protocol}//${parsedUrl.host}${path}${parsedUrl.search}${parsedUrl.hash}`;
  } catch {
    return null;
  }
}

export function readBrandKitGenerationIntent(text: string): BrandKitGenerationIntent | null {
  if (
    !BRAND_KIT_PATTERN.test(text) ||
    !BRAND_KIT_ACTION_PATTERN.test(text) ||
    !SOURCE_CUE_PATTERN.test(text)
  ) {
    return null;
  }

  const websiteUrl = text
    .match(WEBSITE_URL_PATTERN)
    ?.map(normalizeWebsiteUrl)
    .find((url): url is string => url !== null);
  return websiteUrl === undefined ? null : { sourceUrl: websiteUrl };
}
