/*
  Re-scrape reconciliation for human-editable brand-kit fields
  (docs/proposals/brand-kit-user-control.md §8) — pure functions, no ctx, so
  the Convex mutations and the tests share one implementation.

  THE PROBLEM: `saveBrandKit` is a wholesale replace. The moment a human can
  name a color or write a tone of voice, re-running the scrape becomes a
  silent data-loss path — the exact failure the "agent proposes, human
  disposes" principle exists to prevent.

  THE STRATEGY (§8.2 option 2, provenance + sticky user edits): every
  editable field carries an `origin` marker (colors and tone of voice carry a
  `userEditedAtMs` alongside it; social links, added later, carry only the
  marker — see reconcileSocialLinks). A re-scrape writes only into fields NOT
  touched by a human, and reports what it kept so the panel can say so in
  words. Chosen over full diff-and-confirm because it
  needs no new UI surface, no place to park a candidate kit, and no answer to
  "what if the user walks away mid-diff" — and because provenance is what
  would make a diff view meaningful later anyway. It composes; it doesn't
  foreclose.

  Hex normalization is deliberately duplicated-by-behavior rather than
  imported: this module must stay importable from convex/ (no React, no DOM).
*/

import {
  MAX_BRAND_COLORS,
  type BrandColor,
  type BrandColorCategory,
  type BrandDataOrigin,
  type BrandToneOfVoice,
} from "./brand-kit";
import { SOCIAL_PLATFORM_ORDER } from "./social-links";

/*
  Lowercased #rrggbb, or null for anything unparseable.
*/
function normalizeHex(hex: string): string | null {
  const raw = hex.trim().replace(/^#/, "");
  const isShort = /^[0-9a-f]{3}$/i.test(raw);
  const isLong = /^[0-9a-f]{6}$/i.test(raw);
  if (!isShort && !isLong) {
    return null;
  }
  const full = isShort ? [...raw].map((character) => character + character).join("") : raw;
  return `#${full.toLowerCase()}`;
}

/*
  A stable id for a scraped color, derived from the hex so an unchanged color
  keeps its identity across re-scrapes. Ids never change afterwards — a human
  recoloring "Banana" keeps the id (§3.2), which is what makes the entry
  recognizable as the same curated slot.
*/
export function buildBrandColorId(hex: string): string {
  return `color-${(normalizeHex(hex) ?? "#000000").slice(1)}`;
}

/*
  True when a human authored or overrode this entry — the re-scrape lock.
*/
export function isHumanOwnedColor(color: BrandColor): boolean {
  return color.origin === "user" || color.userEditedAtMs !== undefined;
}

/*
  True when a human authored or overrode the tone of voice.
*/
export function isHumanOwnedTone(tone: BrandToneOfVoice): boolean {
  return tone.origin === "user" || tone.userEditedAtMs !== undefined;
}

/*
  Renumber `orderIndex` densely within each category (0, 1, 2, …).
*/
export function renumberBrandColors(colors: BrandColor[]): BrandColor[] {
  const nextIndexByCategory = new Map<BrandColorCategory, number>();
  return colors.map((color) => {
    const orderIndex = nextIndexByCategory.get(color.category) ?? 0;
    nextIndexByCategory.set(color.category, orderIndex + 1);
    return { ...color, orderIndex };
  });
}

export interface BrandColorsReconciliation {
  colors: BrandColor[];
  /*
    How many human-owned entries survived untouched.
  */
  keptUserEditedCount: number;
  /*
    How many entries the incoming scrape contributed.
  */
  adoptedFromSiteCount: number;
}

/*
  Merge a fresh scrape's palette into the stored one.

  Rules, in order:
  1. Every human-owned entry survives VERBATIM — name, hex, category, order.
  2. Incoming entries whose color a surviving entry already claims are
     dropped (the human's name for that color wins).
  3. Remaining incoming entries are adopted, up to the cap.
  4. Machine entries from the previous scrape are discarded — that is the
     part a re-scrape is FOR.

  `incoming` absent (a save that carries no palette, e.g. a legacy client)
  leaves the stored palette completely alone rather than deleting it.
*/
export function reconcileBrandColors({
  existing,
  incoming,
}: {
  existing: BrandColor[] | undefined;
  incoming: BrandColor[] | undefined;
}): BrandColorsReconciliation {
  const storedColors = existing ?? [];
  if (incoming === undefined) {
    return {
      colors: storedColors,
      keptUserEditedCount: storedColors.filter(isHumanOwnedColor).length,
      adoptedFromSiteCount: 0,
    };
  }
  const survivors = storedColors.filter(isHumanOwnedColor);
  const claimedHexes = new Set(
    survivors.flatMap((color) => {
      const normalized = normalizeHex(color.hex);
      return normalized === null ? [] : [normalized];
    }),
  );
  const claimedIds = new Set(survivors.map((color) => color.id));
  const adopted: BrandColor[] = [];
  for (const candidate of incoming) {
    if (survivors.length + adopted.length >= MAX_BRAND_COLORS) {
      break;
    }
    const normalized = normalizeHex(candidate.hex);
    if (normalized === null || claimedHexes.has(normalized) || claimedIds.has(candidate.id)) {
      continue;
    }
    claimedHexes.add(normalized);
    claimedIds.add(candidate.id);
    adopted.push({ ...candidate, hex: normalized });
  }
  return {
    colors: renumberBrandColors([...survivors, ...adopted]),
    keptUserEditedCount: survivors.length,
    adoptedFromSiteCount: adopted.length,
  };
}

export interface ToneOfVoiceReconciliation {
  toneOfVoice: BrandToneOfVoice | undefined;
  /*
    True when the human's tone was kept and the scrape's was discarded.
  */
  keptUserEdit: boolean;
}

/*
  Tone of voice is one object, so reconciliation is all-or-nothing: a human
  who wrote their own voice keeps it, and a re-scrape never overwrites it.
  (Field-level merging here would produce a Frankenstein voice — half the
  user's guidance, half the site's descriptors — which is worse than either.)
*/
export function reconcileToneOfVoice({
  existing,
  incoming,
}: {
  existing: BrandToneOfVoice | undefined;
  incoming: BrandToneOfVoice | undefined;
}): ToneOfVoiceReconciliation {
  if (existing !== undefined && isHumanOwnedTone(existing)) {
    return { toneOfVoice: existing, keptUserEdit: true };
  }
  return { toneOfVoice: incoming ?? existing, keptUserEdit: false };
}

/*
  A social profile link as it is STORED on the kit row.

  `platform` is a bare string, not `SocialPlatform`, because the row's schema
  is `v.string()` and always has been: a kit saved by an older build can hold a
  platform key this build does not know, and reconciliation is not the place to
  decide somebody's stored data is worthless.

  `origin` is optional and ABSENT MEANS MACHINE-OWNED — the whole point (see
  the schema comment). Only `origin` exists here, with no `userEditedAtMs`
  twin: a link is one URL, so "did a human choose this" is the only question
  anything asks about it, and `origin` answers it completely. Colors carry a
  timestamp because they landed with one; copying an unread field into a second
  place would just give it somewhere else to drift.
*/
export interface StoredSocialLink {
  platform: string;
  url: string;
  origin?: BrandDataOrigin;
}

/*
  True when a human authored or overrode this link — the re-scrape lock.
*/
export function isHumanOwnedSocialLink(link: StoredSocialLink): boolean {
  return link.origin === "user";
}

/*
  Position in the shared display order; unknown platforms sort last.
*/
function rankSocialPlatform(platform: string): number {
  const index = SOCIAL_PLATFORM_ORDER.findIndex((candidate) => candidate === platform);
  return index === -1 ? SOCIAL_PLATFORM_ORDER.length : index;
}

/*
  One link per platform, in the display order every other writer of this array
  produces (`dedupeSocialLinks`) — the chips, the footer fill and the agent
  context all read the array in order, so a merge that emitted survivors first
  and the scrape's finds after would visibly reshuffle the list on every save.
  First occurrence wins, which is what makes "the human's link keeps the
  platform" true no matter what the scrape proposes for it.
*/
function orderSocialLinksForDisplay(links: StoredSocialLink[]): StoredSocialLink[] {
  const byPlatform = new Map<string, StoredSocialLink>();
  for (const link of links) {
    if (!byPlatform.has(link.platform)) {
      byPlatform.set(link.platform, link);
    }
  }
  return [...byPlatform.values()].sort(
    (a, b) => rankSocialPlatform(a.platform) - rankSocialPlatform(b.platform),
  );
}

export interface SocialLinksReconciliation {
  socialLinks: StoredSocialLink[];
  /*
    How many human-owned links survived untouched.
  */
  keptUserEditedCount: number;
}

/*
  Merge a fresh scrape's social links into the stored ones — the third case of
  the same idea as `reconcileBrandColors` and `reconcileToneOfVoice`.

  Rules, in order:
  1. Every human-owned link survives VERBATIM, and its PLATFORM is claimed.
  2. An incoming link for a platform a survivor claims is DROPPED, even when
     the scrape found a different URL for it. That is the deliberate answer to
     the conflict case: somebody who typed the brand's real LinkedIn after the
     scraper picked up the CEO's personal one gets to keep it, and a re-scrape
     that re-finds the wrong URL cannot quietly win the argument back. Exactly
     what colors do when the scrape re-proposes a hex a human already named.
  3. A human-added platform the scrape does NOT find still survives — survival
     is a property of the entry, never of whether the site re-published it.
     A brand that lists its Instagram nowhere on its homepage is the ordinary
     reason somebody types one in.
  4. Everything else the scrape found is adopted, and machine links from the
     PREVIOUS scrape are discarded — that is the part a re-scrape is FOR.

  UNLIKE `reconcileBrandColors`, `incoming: undefined` is NOT "leave the stored
  array alone". The generate pipeline omits `socialLinks` entirely when it
  found none (generate-brand-kit.ts), so absent here means "this site publishes
  no profile links", not "this client doesn't send them" — treating it as the
  latter would strand links a brand has since removed from its own footer.
  Machine links are therefore swept by a scrape that found nothing, which is
  precisely what a save did before provenance existed.

  NOT SOLVED, and deliberately: a link a human DELETES leaves no tombstone, so
  a re-scrape that still finds it re-adds it. Colors have the same gap for the
  same reason, and inventing a tombstone here would make the two diverge for a
  case neither has been asked to handle.
*/
export function reconcileSocialLinks({
  existing,
  incoming,
}: {
  existing: StoredSocialLink[] | undefined;
  incoming: StoredSocialLink[] | undefined;
}): SocialLinksReconciliation {
  const survivors = (existing ?? []).filter(isHumanOwnedSocialLink);
  const claimedPlatforms = new Set(survivors.map((link) => link.platform));
  const adopted = (incoming ?? []).filter((link) => !claimedPlatforms.has(link.platform));
  return {
    socialLinks: orderSocialLinksForDisplay([...survivors, ...adopted]),
    keptUserEditedCount: survivors.length,
  };
}

/*
  Stamp a human's social-link edit for storage, the counterpart to
  `planBrandColorsUpdate`: a row whose URL DIFFERS from what is stored for that
  platform (or whose platform is new) becomes `origin: "user"`; a row that
  matches keeps whatever provenance it had, verbatim.

  That distinction is load-bearing, not tidiness. The editor commits the WHOLE
  array on any blur, so focusing a field and tabbing away sends every row back.
  Stamping all of them would let an idle click lock the entire list against
  every future scrape — the same reason `planBrandColorsUpdate` leaves an
  untouched color alone. Saving is not editing.

  Server-side on purpose (same stance as the palette): the client sends the
  array it is showing, and the server decides what counts as an edit. Nothing
  the caller claims about provenance is trusted — the save/scrape wire shape
  carries no `origin` at all, so `"user"` can only ever be minted here.
*/
export function stampUserEditedSocialLinks({
  existing,
  incoming,
}: {
  existing: StoredSocialLink[] | undefined;
  incoming: StoredSocialLink[];
}): StoredSocialLink[] {
  const storedByPlatform = new Map((existing ?? []).map((link) => [link.platform, link]));
  return incoming.map((link) => {
    const stored = storedByPlatform.get(link.platform);
    if (stored !== undefined && stored.url === link.url) {
      return stored;
    }
    return { ...link, origin: "user" as const };
  });
}

/*
  The one-line summary the panel shows after a re-scrape — "silent skip" is
  exactly the failure mode provenance exists to avoid, so what was kept has
  to be visible. Returns null when there was nothing of the human's to keep.
*/
export function describeBrandKitReconciliation({
  keptUserEditedColors,
  keptUserToneOfVoice,
  /*
    Optional so the two older callers read unchanged, and because omitting it
    means what 0 means: a save that kept no links of the human's.
  */
  keptUserEditedSocialLinks = 0,
}: {
  keptUserEditedColors: number;
  keptUserToneOfVoice: boolean;
  keptUserEditedSocialLinks?: number;
}): string | null {
  const kept: string[] = [];
  if (keptUserEditedColors > 0) {
    kept.push(keptUserEditedColors === 1 ? "1 color you edited" : `${keptUserEditedColors} colors you edited`);
  }
  if (keptUserToneOfVoice) {
    kept.push("your tone of voice");
  }
  if (keptUserEditedSocialLinks > 0) {
    kept.push(
      keptUserEditedSocialLinks === 1
        ? "1 social link you edited"
        : `${keptUserEditedSocialLinks} social links you edited`,
    );
  }
  if (kept.length === 0) {
    return null;
  }
  const list = kept.length === 1 ? kept[0] : `${kept.slice(0, -1).join(", ")} and ${kept.at(-1)}`;
  return `Updated from the site — we kept ${list}.`;
}

/*
  Stamp a human's palette edit for storage: entries that DIFFER from what is
  stored (or are brand new) become `origin: "user"` with a fresh
  `userEditedAtMs`; untouched entries keep whatever provenance they had, so
  saving the panel without changing anything doesn't silently lock the whole
  palette against future scrapes.

  Done server-side on purpose: the client sends the array it is showing, and
  the server decides what counts as an edit. Nothing has to be trusted.
*/
export function planBrandColorsUpdate({
  existing,
  incoming,
  nowMs,
}: {
  existing: BrandColor[] | undefined;
  incoming: BrandColor[];
  nowMs: number;
}): BrandColor[] {
  const storedById = new Map((existing ?? []).map((color) => [color.id, color]));
  const stamped = incoming.map((color) => {
    const normalizedHex = normalizeHex(color.hex) ?? color.hex;
    const stored = storedById.get(color.id);
    const isUnchanged =
      stored !== undefined &&
      normalizeHex(stored.hex) === normalizedHex &&
      stored.name === color.name &&
      stored.category === color.category;
    if (isUnchanged) {
      return { ...stored, orderIndex: color.orderIndex };
    }
    return {
      ...color,
      hex: normalizedHex,
      origin: "user" as const,
      userEditedAtMs: nowMs,
      /*
        Provenance from the scrape is kept even after a human edit — it is
        why the color was proposed, and it survives the rename it explains.
      */
      ...(stored?.sourceVariableName !== undefined && color.sourceVariableName === undefined
        ? { sourceVariableName: stored.sourceVariableName }
        : {}),
      ...(stored?.sourceUsageCount !== undefined && color.sourceUsageCount === undefined
        ? { sourceUsageCount: stored.sourceUsageCount }
        : {}),
    };
  });
  return renumberBrandColors(stamped);
}
