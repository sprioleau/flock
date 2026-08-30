/*
  The /brand workspace's section registry — the sub-nav down the left of the
  immersive brand page (brand-memory-and-scrape-confidence §1/§8).

  React-free on purpose so the slug<->section resolution is unit-testable in
  apps/web's node environment (there is no DOM here; see AGENTS.md). The page
  and its layout both resolve a URL segment through {@link resolveBrandSection}.

  Only sections that actually work this slice are listed. The owner's decision
  was to HIDE what is not built yet (Assets, Image Style, Unsubscribe,
  Settings) rather than show disabled tabs, so adding one later is a matter of
  appending here — no placeholder to remove.

  "Email Design" leads because it is the headline of this work — the CEILING
  (email-design.md) over the structured kit's FLOOR.
*/

export type BrandSectionId =
  | "email-design"
  | "identity"
  | "colors"
  | "fonts"
  | "voice"
  | "links";

export interface BrandSection {
  id: BrandSectionId;
  /*
    URL slug under /brand (e.g. /brand/email-design). Kept identical to `id`
    so there is one string to reason about.
  */
  slug: string;
  label: string;
  /*
    One-line purpose, shown under the section heading.
  */
  description: string;
}

/*
  Display + navigation order.
*/
export const BRAND_SECTIONS: readonly BrandSection[] = [
  {
    id: "email-design",
    slug: "email-design",
    label: "Email Design",
    description: "Standing guidance the agent follows when it builds your emails.",
  },
  {
    id: "identity",
    slug: "identity",
    label: "Identity",
    description: "Your brand's name and where it was scraped from.",
  },
  {
    id: "colors",
    slug: "colors",
    label: "Colors",
    description: "The palette every email and theme draws from.",
  },
  {
    id: "fonts",
    slug: "fonts",
    label: "Fonts",
    description: "The heading and body type your emails are set in.",
  },
  {
    id: "voice",
    slug: "voice",
    label: "Voice",
    description: "How the brand writes — the tone the agent adopts for copy.",
  },
  {
    id: "links",
    slug: "links",
    label: "Links",
    description: "Social profiles surfaced in email footers.",
  },
] as const;

/*
  The section shown at bare /brand.
*/
export const DEFAULT_BRAND_SECTION: BrandSection = BRAND_SECTIONS[0];

/*
  Resolve an optional URL segment (the first element of an optional catch-all)
  to a section. Anything unknown — including undefined for bare /brand — falls
  back to the default rather than 404ing, so a stale link degrades to a usable
  page instead of an error.
*/
export function resolveBrandSection(slug: string | undefined): BrandSection {
  if (slug === undefined) {
    return DEFAULT_BRAND_SECTION;
  }
  return BRAND_SECTIONS.find((section) => section.slug === slug) ?? DEFAULT_BRAND_SECTION;
}
