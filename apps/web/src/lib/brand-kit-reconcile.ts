/**
 * Re-scrape reconciliation for human-editable brand-kit fields
 * (docs/proposals/brand-kit-user-control.md §8) — pure functions, no ctx, so
 * the Convex mutations and the tests share one implementation.
 *
 * THE PROBLEM: `saveBrandKit` is a wholesale replace. The moment a human can
 * name a color or write a tone of voice, re-running the scrape becomes a
 * silent data-loss path — the exact failure the "agent proposes, human
 * disposes" principle exists to prevent.
 *
 * THE STRATEGY (§8.2 option 2, provenance + sticky user edits): every
 * editable field carries `origin` and `userEditedAtMs`. A re-scrape writes
 * only into fields NOT touched by a human, and reports what it kept so the
 * panel can say so in words. Chosen over full diff-and-confirm because it
 * needs no new UI surface, no place to park a candidate kit, and no answer to
 * "what if the user walks away mid-diff" — and because provenance is what
 * would make a diff view meaningful later anyway. It composes; it doesn't
 * foreclose.
 *
 * Hex normalization is deliberately duplicated-by-behavior rather than
 * imported: this module must stay importable from convex/ (no React, no DOM).
 */

import {
  MAX_BRAND_COLORS,
  type BrandColor,
  type BrandColorCategory,
  type BrandToneOfVoice,
} from "./brand-kit";

/** Lowercased #rrggbb, or null for anything unparseable. */
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

/**
 * A stable id for a scraped color, derived from the hex so an unchanged color
 * keeps its identity across re-scrapes. Ids never change afterwards — a human
 * recoloring "Banana" keeps the id (§3.2), which is what makes the entry
 * recognizable as the same curated slot.
 */
export function buildBrandColorId(hex: string): string {
  return `color-${(normalizeHex(hex) ?? "#000000").slice(1)}`;
}

/** True when a human authored or overrode this entry — the re-scrape lock. */
export function isHumanOwnedColor(color: BrandColor): boolean {
  return color.origin === "user" || color.userEditedAtMs !== undefined;
}

/** True when a human authored or overrode the tone of voice. */
export function isHumanOwnedTone(tone: BrandToneOfVoice): boolean {
  return tone.origin === "user" || tone.userEditedAtMs !== undefined;
}

/** Renumber `orderIndex` densely within each category (0, 1, 2, …). */
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
  /** How many human-owned entries survived untouched. */
  keptUserEditedCount: number;
  /** How many entries the incoming scrape contributed. */
  adoptedFromSiteCount: number;
}

/**
 * Merge a fresh scrape's palette into the stored one.
 *
 * Rules, in order:
 * 1. Every human-owned entry survives VERBATIM — name, hex, category, order.
 * 2. Incoming entries whose color a surviving entry already claims are
 *    dropped (the human's name for that color wins).
 * 3. Remaining incoming entries are adopted, up to the cap.
 * 4. Machine entries from the previous scrape are discarded — that is the
 *    part a re-scrape is FOR.
 *
 * `incoming` absent (a save that carries no palette, e.g. a legacy client)
 * leaves the stored palette completely alone rather than deleting it.
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
  /** True when the human's tone was kept and the scrape's was discarded. */
  keptUserEdit: boolean;
}

/**
 * Tone of voice is one object, so reconciliation is all-or-nothing: a human
 * who wrote their own voice keeps it, and a re-scrape never overwrites it.
 * (Field-level merging here would produce a Frankenstein voice — half the
 * user's guidance, half the site's descriptors — which is worse than either.)
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

/**
 * The one-line summary the panel shows after a re-scrape — "silent skip" is
 * exactly the failure mode provenance exists to avoid, so what was kept has
 * to be visible. Returns null when there was nothing of the human's to keep.
 */
export function describeBrandKitReconciliation({
  keptUserEditedColors,
  keptUserToneOfVoice,
}: {
  keptUserEditedColors: number;
  keptUserToneOfVoice: boolean;
}): string | null {
  const kept: string[] = [];
  if (keptUserEditedColors > 0) {
    kept.push(keptUserEditedColors === 1 ? "1 color you edited" : `${keptUserEditedColors} colors you edited`);
  }
  if (keptUserToneOfVoice) {
    kept.push("your tone of voice");
  }
  if (kept.length === 0) {
    return null;
  }
  const list = kept.length === 1 ? kept[0] : `${kept.slice(0, -1).join(", ")} and ${kept.at(-1)}`;
  return `Updated from the site — we kept ${list}.`;
}

/**
 * Stamp a human's palette edit for storage: entries that DIFFER from what is
 * stored (or are brand new) become `origin: "user"` with a fresh
 * `userEditedAtMs`; untouched entries keep whatever provenance they had, so
 * saving the panel without changing anything doesn't silently lock the whole
 * palette against future scrapes.
 *
 * Done server-side on purpose: the client sends the array it is showing, and
 * the server decides what counts as an edit. Nothing has to be trusted.
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
      // Provenance from the scrape is kept even after a human edit — it is
      // why the color was proposed, and it survives the rename it explains.
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
