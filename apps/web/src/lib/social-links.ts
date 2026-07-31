/**
 * Social profile link classification — shared by the brand-kit extraction
 * ladder (server), the kit card, and the footer fill affordance (client).
 * Pure string/URL logic: NO node imports (must stay client-safe).
 *
 * Canonicalization stance: scheme forced to https, host lowercased with a
 * leading "www." stripped, query/hash/trailing-slash dropped. The HOST the
 * site published is kept (twitter.com is not rewritten to x.com — we never
 * invent URLs the brand didn't publish); the PLATFORM key still classifies
 * both hosts as "x".
 */

/** The platforms the brand kit recognizes (owner list, item 26). */
export type SocialPlatform =
  | "x"
  | "facebook"
  | "instagram"
  | "linkedin"
  | "youtube"
  | "github"
  | "tiktok";

/** One brand social profile: platform key + canonical profile URL. */
export interface BrandSocialLink {
  platform: SocialPlatform;
  url: string;
}

/** User-facing platform names (link labels/chips — never the raw keys). */
export const SOCIAL_PLATFORM_LABELS: Record<SocialPlatform, string> = {
  x: "X",
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  github: "GitHub",
  tiktok: "TikTok",
};

/** Display/priority order for chips, fills, and dedupe (owner's big three first). */
export const SOCIAL_PLATFORM_ORDER: readonly SocialPlatform[] = [
  "x",
  "facebook",
  "instagram",
  "linkedin",
  "youtube",
  "github",
  "tiktok",
];

interface PlatformRule {
  platform: SocialPlatform;
  hosts: string[];
  /** Path prefixes that are share/intent chrome, never a profile. */
  blockedPathPrefixes: string[];
  /** When set, the first path segment must match to count as a profile. */
  requiredFirstSegmentPattern?: RegExp;
}

const PLATFORM_RULES: PlatformRule[] = [
  {
    platform: "x",
    hosts: ["x.com", "twitter.com"],
    blockedPathPrefixes: ["intent", "share", "home", "search", "hashtag", "i"],
  },
  {
    platform: "facebook",
    hosts: ["facebook.com", "fb.com"],
    blockedPathPrefixes: ["sharer", "sharer.php", "share", "share.php", "dialog", "plugins", "groups"],
  },
  {
    platform: "instagram",
    hosts: ["instagram.com"],
    blockedPathPrefixes: ["p", "reel", "reels", "explore", "share"],
  },
  {
    platform: "linkedin",
    hosts: ["linkedin.com"],
    blockedPathPrefixes: ["sharearticle", "sharing", "shareactive", "feed"],
    // Profiles live under /company/, /in/, /school/ or /showcase/.
    requiredFirstSegmentPattern: /^(company|in|school|showcase)$/,
  },
  {
    platform: "youtube",
    hosts: ["youtube.com", "youtu.be"],
    blockedPathPrefixes: ["watch", "embed", "shorts", "playlist", "results", "feed"],
  },
  {
    platform: "github",
    hosts: ["github.com"],
    blockedPathPrefixes: ["features", "topics", "search", "login", "signup", "sponsors", "marketplace"],
  },
  {
    platform: "tiktok",
    hosts: ["tiktok.com"],
    blockedPathPrefixes: ["share", "discover", "tag"],
  },
];

/**
 * Classify a URL as a social PROFILE link, canonicalized — or null for
 * anything else (share/intent chrome, posts, non-social hosts, bare
 * platform homepages).
 */
export function classifySocialUrl(rawUrl: string): BrandSocialLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const rule = PLATFORM_RULES.find(
    ({ hosts }) => hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`)),
  );
  if (rule === undefined) {
    return null;
  }
  const pathSegments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const [firstSegment] = pathSegments;
  if (firstSegment === undefined) {
    return null; // a bare platform homepage is not the brand's profile
  }
  if (rule.blockedPathPrefixes.includes(firstSegment.toLowerCase())) {
    return null;
  }
  if (
    rule.requiredFirstSegmentPattern !== undefined &&
    !rule.requiredFirstSegmentPattern.test(firstSegment.toLowerCase())
  ) {
    return null;
  }
  const canonicalPath = `/${pathSegments.join("/")}`;
  return { platform: rule.platform, url: `https://${host}${canonicalPath}` };
}

/**
 * Dedupe to at most ONE link per platform (first occurrence wins — callers
 * order candidates by source authority), sorted in platform display order.
 */
export function dedupeSocialLinks(links: BrandSocialLink[]): BrandSocialLink[] {
  const byPlatform = new Map<SocialPlatform, BrandSocialLink>();
  for (const link of links) {
    if (!byPlatform.has(link.platform)) {
      byPlatform.set(link.platform, link);
    }
  }
  return SOCIAL_PLATFORM_ORDER.flatMap((platform) => {
    const link = byPlatform.get(platform);
    return link === undefined ? [] : [link];
  });
}
