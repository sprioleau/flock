/*
  Human editing of the kit's social links (brand-kit-user-control §7.2).

  The array is extracted, stored, shown as chips, offered as a footer fill and
  handed to the chat agent — and until now there was no way to change it. A
  brand whose LinkedIn the scrape missed, or whose footer linked the CEO's
  personal X account, had no recourse but a re-scrape that would do the same
  thing again.

  THE VALIDATION STANCE, and why it is not "accept whatever they typed":
  `classifySocialUrl` is already the single definition of what counts as a
  brand profile link — it canonicalizes the scheme/host/path and rejects
  share-and-intent chrome (`/intent/`, `/sharer.php`, …) so a "Share this on X"
  button never becomes the brand's X profile. Reusing it for typed input means
  a hand-entered link and a scraped one are the same kind of value, stored the
  same way. A free-text field that skipped it would let a person paste the
  share URL the scraper is specifically built to reject.

  Pure (no React, no ctx): the Convex mutation and the editor share one
  implementation, and the rules are unit-tested here rather than through UI.
*/

import {
  classifySocialUrl,
  dedupeSocialLinks,
  SOCIAL_PLATFORM_LABELS,
  SOCIAL_PLATFORM_ORDER,
  type BrandSocialLink,
  type SocialPlatform,
} from "./social-links";

/*
  One row of the editor: the platform the user chose and what they typed.
*/
export interface SocialLinkDraft {
  platform: SocialPlatform;
  url: string;
}

export type SocialLinksPlan =
  | { isValid: true; links: BrandSocialLink[] }
  | { isValid: false; message: string };

/*
  True when a stored platform key is one this build knows how to render.
*/
export function isKnownSocialPlatform(platform: string): platform is SocialPlatform {
  return (SOCIAL_PLATFORM_ORDER as readonly string[]).includes(platform);
}

/*
  Turn the editor's rows into the array to store, or the first problem worth
  saying out loud.

  - A row whose URL is blank is DROPPED, not an error: clearing the field is
    how a person removes a link, and making them hunt for a separate × for the
    same intent is friction with no payoff.
  - A URL that does not classify is refused with the platform named, because
    "that isn't a valid URL" is useless when the real problem is that a
    LinkedIn feed URL is not a LinkedIn profile.
  - A URL that classifies as a DIFFERENT platform than the row claims is
    refused rather than silently re-filed, so the list never quietly disagrees
    with what the user is looking at.
  - Survivors are deduped to one per platform in display order, which is the
    same invariant the extraction ladder produces.
*/
export function planSocialLinksUpdate(drafts: SocialLinkDraft[]): SocialLinksPlan {
  const classified: BrandSocialLink[] = [];
  for (const draft of drafts) {
    const trimmedUrl = draft.url.trim();
    if (trimmedUrl.length === 0) {
      continue;
    }
    const link = classifySocialUrl(trimmedUrl);
    if (link === null) {
      return {
        isValid: false,
        message: `That doesn't look like a ${SOCIAL_PLATFORM_LABELS[draft.platform]} profile link — paste the address of the profile page.`,
      };
    }
    if (link.platform !== draft.platform) {
      return {
        isValid: false,
        message: `That's a ${SOCIAL_PLATFORM_LABELS[link.platform]} link, not a ${SOCIAL_PLATFORM_LABELS[draft.platform]} one.`,
      };
    }
    classified.push(link);
  }
  return { isValid: true, links: dedupeSocialLinks(classified) };
}

/*
  The platforms still available to add: the ones no row already claims. The
  editor holds at most one row per platform because the stored shape does —
  `dedupeSocialLinks` would silently drop a second X row, and a control that
  silently discards what you typed is worse than one that never offered it.
*/
export function getAvailableSocialPlatforms(taken: SocialPlatform[]): SocialPlatform[] {
  const claimed = new Set(taken);
  return SOCIAL_PLATFORM_ORDER.filter((platform) => !claimed.has(platform));
}
