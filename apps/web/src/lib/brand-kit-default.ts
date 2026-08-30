/*
  THE STARTER BRAND KIT — Flock's own brand, so a person without a scrapeable
  website is not locked out of the panel (brand-kit-user-control §14.5c).

  THE PROBLEM. Every manual editor in `BrandKitPanel` is gated behind
  `hasSavedKit`, and until now the only way to get a saved kit was a successful
  website scrape. A user whose site is bot-protected, or who has no site at
  all, could open the panel and edit precisely nothing: no colors, no fonts, no
  tone of voice, no themes, no logo — and could not even bind a kit to the
  canvas, because binding requires a saved row too. The mock kit they were
  shown instead was display-only, which is the worst of both: it looks
  editable and is not.

  THE DECISION (the owner's): ship Flock itself as the default. A starter kit
  has to be made of SOMETHING, and every honest option is a real brand. Flock
  is the one brand we can use without misrepresenting anybody — it is the
  product the user is already inside, and it is obviously not theirs, which is
  exactly what makes it safe to replace.

  WHY THIS IS NOT THE `MOCK_BRAND_KIT` OBJECTION. An earlier pass rejected
  seeding from the mock, and was right to: "Flock Demo Brand" is a fiction, and
  installing a fictional company's name and palette as somebody's own brand
  puts a lie on their row that they then have to notice and undo. Nothing in
  that argument survives the change of subject. Flock is real, the logo is the
  repo's real artwork, the palette is the real one, and the kit says "Starter"
  on its face. What we DID keep from the mock is the part that was never the
  problem: its hand-tuned, contract-passing theme set — including Midnight —
  reused verbatim rather than re-authored, because those payloads are already
  complete, already WCAG-AA, and already the themes this app ships with.

  IT IS A STARTING POINT, AND THE ROW SAYS SO. `isStarterKit` marks it until
  the user renames it or replaces it with a scrape — the two gestures that mean
  "this kit is about MY brand now". Until one of them happens the panel shows a
  Starter badge and a line of copy saying whose brand this is. Every field is
  editable the moment the row exists, which is the entire point.

  NOTHING IS RESTYLED BY ANY OF THIS. Seeding inserts one `brandKits` row and
  stops. It binds nothing to a canvas, writes no document, and commits no op —
  a person with existing drafts who starts the kit sees their drafts exactly as
  they were, and the canvas is not even using this kit until they choose it.

  Pure by design (no React, no ctx, no Convex): the payload is a value both the
  seeding mutation and its tests can read, and `apps/web/vitest.config.ts` pins
  `environment: "node"`.
*/

import type { BrandColor, BrandKit, BrandToneOfVoice, ThemeVariation } from "./brand-kit";
import { MOCK_BRAND_KIT } from "./brand-kit";
import { FLOCK_LOGO_DATA_URI } from "./flock-logo-svg";

/*
  The starter kit's name — also the string the panel's Starter badge guards.
*/
export const DEFAULT_BRAND_KIT_NAME = "Flock";

/*
  The Flock palette: dark grey, black, white.

  NAMED AND GROUPED THE WAY A SCRAPED PALETTE IS. `resolveBrandColorName`'s
  last rung describes the color itself ("Charcoal", "Near Black") rather than
  inventing brand mythology, and these names are what that ladder would
  produce for these hexes — so the starter palette reads like every other
  palette in the panel instead of like a special case. Categories follow the
  same reading: the brand's signature color is primary, the surfaces and text
  greys are secondary, and the color a button is painted is the accent.

  ORIGIN IS "agent", NEVER "user", and there is deliberately no
  `userEditedAtMs`. `isHumanOwnedColor` protects user-owned entries from a
  re-scrape, and a starter palette that survived the user's own scrape of their
  own website would be the exact opposite of a starting point — the scrape has
  to be able to sweep it away without asking. The moment the user edits one of
  these, `planBrandColorsUpdate` stamps it "user" server-side and it becomes
  theirs, sticky like any other hand-picked color.
*/
export const DEFAULT_BRAND_COLORS: BrandColor[] = [
  {
    id: "flock-black",
    hex: "#000000",
    name: "Black",
    category: "primary",
    orderIndex: 0,
    origin: "agent",
  },
  {
    id: "flock-charcoal",
    hex: "#3a3a3c",
    name: "Charcoal",
    category: "secondary",
    orderIndex: 0,
    origin: "agent",
  },
  {
    id: "flock-white",
    hex: "#ffffff",
    name: "White",
    category: "secondary",
    orderIndex: 1,
    origin: "agent",
  },
];

/*
  How Flock writes — "relatively neutral", per the owner, and measured against
  the product's own voice (the README and packages/agent/src/prompts).

  What that voice actually is, in the three fields the model reads: it leads
  with the specific thing rather than the framing around it, it does not sell,
  and it says the limit out loud where there is one. `avoid` is the
  highest-signal field in practice, so it carries the marketing vocabulary this
  product does not use.

  ORIGIN IS "agent" for the same reason the colors are: `isHumanOwnedTone`
  keeps user-authored tone through a re-scrape, and the starter's tone must not
  outlive the user's own brand arriving.
*/
const DEFAULT_VOICE_AVOID_WORDS = [
  "revolutionary",
  "game-changing",
  "seamless",
  "effortless",
  "supercharge",
  "unlock",
  "leverage",
  "cutting-edge",
  "delight",
];

export const DEFAULT_BRAND_TONE_OF_VOICE: BrandToneOfVoice = {
  descriptors: ["plainspoken", "technical"],
  formality: "neutral",
  person: "first-person-plural",
  guidance:
    "Lead with the specific thing — the change, the number, the name — before any framing around it. Short sentences, plain words, no hedging. Say what something does and what it costs the reader in time. Where there is a limit, name it rather than working around it. Address the reader as you, and speak for the team as we.",
  avoid: DEFAULT_VOICE_AVOID_WORDS,
  origin: "agent",
};

/*
  The starter theme set: the app's existing placeholder variations, reused
  rather than re-authored.

  These four — Classic Light, Warm Sand, MIDNIGHT and Evergreen — are the
  themes this app has always shipped. Every one is a complete
  `Required<GlobalStyles>` payload that already clears the completeness and
  WCAG-AA gates (there is a module-load assertion on the mock proving it), so
  reusing them means the starter kit passes `assertBrandKitIsValid` by
  construction rather than by a fresh round of hand-tuned hex values that would
  need the same proof written again.

  Copied, not aliased: a kit row owns its variations, and a starter kit that
  shared array identity with a module constant would be one careless mutation
  away from editing the mock everybody else reads.
*/
export function getDefaultThemeVariations(): ThemeVariation[] {
  return MOCK_BRAND_KIT.variations.map((variation) => ({
    id: variation.id,
    name: variation.name,
    globals: { ...variation.globals },
  }));
}

/*
  The whole starter kit as the shared `BrandKit` contract.

  A function, not a frozen constant, because the caller inserts it into a row
  and the row owns its arrays from that point on.
*/
export function buildDefaultBrandKit(): BrandKit {
  return {
    name: DEFAULT_BRAND_KIT_NAME,
    fonts: { ...MOCK_BRAND_KIT.fonts },
    /*
      The logo arrives UNCONFIRMED, exactly like a scraped one. See
      flock-logo-svg.ts: confirming it is what pulls the bytes into Convex
      storage and earns it the right to enter a document.
    */
    logoUrl: FLOCK_LOGO_DATA_URI,
    colors: DEFAULT_BRAND_COLORS.map((color) => ({ ...color })),
    toneOfVoice: { ...DEFAULT_BRAND_TONE_OF_VOICE, avoid: [...DEFAULT_VOICE_AVOID_WORDS] },
    variations: getDefaultThemeVariations(),
  };
}
