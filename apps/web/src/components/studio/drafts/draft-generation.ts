import type { EmailDocument, GlobalStyles } from "@flock/email-sdk";
import {
  areGlobalsEqual,
  getLiveThemeVariations,
  type BrandKit,
  type ThemeVariation,
} from "@/lib/brand-kit";

/**
 * The USER-FACING half of the drafts menu's AI generation actions ("Ideate with
 * AI" / "Add design variation"): the sentence that lands in the chat thread,
 * and the theme the variation must open wearing.
 *
 * WHAT THIS MODULE NO LONGER DOES. It used to build the whole model brief —
 * the source draft's outline, its block ids, its hex colours and font stacks,
 * the numbered structural instructions — and send it AS THE MESSAGE TEXT. The
 * chat bubble then rendered all of it, which is internal language a person
 * neither wrote nor should read. That half now lives on the server
 * (api/chat/generation-brief.ts) and is assembled from a minimal request:
 * `{ kind, sourceDocumentId, direction }`.
 *
 * So the split is: this file writes the sentence a person would recognise as
 * their own request, and the server joins the targeted instructions onto it.
 *
 * The flow itself lives in DraftSelector: create an EMPTY draft, seed it with
 * the source draft's theme (variation only), activate it, then submit the
 * sentence below through the chat panel's own send path (composer-handoff SEND)
 * with the machine half stashed in pending-generation-request.ts — so the user
 * sees their request land in the thread and the sections stream in, the same
 * transparency contract as slash-summon, and NO second pipeline.
 */

// ---------------------------------------------------------------------------
// The direction field
// ---------------------------------------------------------------------------

/**
 * Longest direction the two generation dialogs accept.
 *
 * The WIRE already accepts 2,000 (MAX_GENERATION_DIRECTION_LENGTH in
 * lib/chat-contract.ts), so this cap is purely about what a person can
 * comfortably write and review, and raising it again later needs no schema
 * change. It was 200, which the owner found too short — and 200 mattered more
 * than it looked, because a variation's direction is the ONLY channel that can
 * release the pre-applied theme ("try something lighter"), i.e. the one lever
 * over the thing the whole feature is judged on. 500 is three or four lines of
 * prose, which is why both fields are textareas rather than single-line inputs:
 * a 500-character input that scrolls sideways cannot be re-read before sending.
 */
export const MAX_GENERATION_DIRECTION_INPUT_LENGTH = 500;

// ---------------------------------------------------------------------------
// The sentence the person sees
// ---------------------------------------------------------------------------

/**
 * "Ideate with AI", as the person would say it — including their own
 * direction, verbatim, for the same reason a variation's is included: they
 * typed it, and it is the part of the request they will want to see reflected
 * back in the thread.
 *
 * The source draft is named because that is the one fact the sentence has to
 * carry for the thread to make sense later ("which draft was this from?").
 */
export function buildIdeatePromptText({
  sourceDraftName,
  direction,
}: {
  sourceDraftName: string;
  direction: string;
}): string {
  const trimmedDirection = direction.trim();
  const base = `Ideate a new draft on this canvas, inspired by "${sourceDraftName}".`;
  return trimmedDirection.length === 0 ? base : `${base} ${trimmedDirection}`;
}

/**
 * "Add design variation", as the person would say it — including their own
 * direction, verbatim, because they typed it and it is the part of the request
 * they will want to see reflected back.
 */
export function buildVariationPromptText({
  sourceDraftName,
  direction,
}: {
  sourceDraftName: string;
  direction: string;
}): string {
  const trimmedDirection = direction.trim();
  const base = `Add a design variation of "${sourceDraftName}".`;
  return trimmedDirection.length === 0 ? base : `${base} ${trimmedDirection}`;
}

// ---------------------------------------------------------------------------
// Theme carry-over
// ---------------------------------------------------------------------------

/**
 * The theme a design variation must open wearing, or null when there is
 * nothing to carry.
 *
 * A draft whose theme has never been touched holds NO globals of its own and
 * renders on the shared defaults — so does the blank draft the variation is
 * built in, and copying `{}` around would only add a no-op to its history.
 * Anything else is a theme the person chose and is currently looking at, and
 * it is not the model's to reconsider: the caller writes it into the new draft
 * as one `applyTheme` op before the prompt is ever sent. Theme inheritance is
 * therefore ON by default and cannot be lost to a model that ignores an
 * instruction; only the person's own words release it.
 *
 * The SERVER checks the result rather than trusting a flag from here
 * (generation-brief.ts's `hasSourceThemeApplied`), so a seed that silently
 * failed is still described accurately to the model.
 */
export function readSourceThemeGlobals(doc: EmailDocument): GlobalStyles | null {
  const root = doc.root;
  if (root === undefined || root.type !== "root") {
    return null;
  }
  const globals = root.properties.globals ?? {};
  return Object.keys(globals).length > 0 ? globals : null;
}

// ---------------------------------------------------------------------------
// Theme VARIATION
// ---------------------------------------------------------------------------

/**
 * The theme a design variation opens wearing, or the honest admission that
 * this kit has nothing to vary to.
 */
export type VariationThemePick =
  | { isVaried: true; variation: ThemeVariation }
  | { isVaried: false; reason: "no-alternative-theme" };

/*
  A design variation varies the THEME, not only the layout.

  WHY THIS EXISTS AT ALL. Until now the variation was seeded with
  {@link readSourceThemeGlobals} — the source's own globals, verbatim — so two
  drafts sat side by side in the same colours with different boxes. The owner's
  objection is the feature's name: "it is a design variation after all", and a
  design that never changes colour is a layout variation wearing the wrong
  label. The ORDINARY new-draft path is untouched by this: inheritance is still
  the default everywhere else, and only this one action diverges.

  WHERE THE NEW THEME COMES FROM, AND WHAT IT DELIBERATELY IS NOT. It is an
  EXISTING variation of the canvas's brand kit — never a generated one. Three
  reasons, in order of how much they cost to get wrong:

  1. Applying a kit variation makes the new draft an INSTANCE of that theme:
     `findMatchingVariation` matches it, the brand pointer records it, and the
     draft reads "current" rather than detached. A theme invented for one draft
     would belong to no kit, match nothing, and be exactly the stranded state
     soft deletion was built to avoid.
  2. It appends nothing. The kit's 8-variation cap and its append-only history
     are untouched, because nothing is created — a variation READS the kit.
  3. It costs no model call. Generating a theme per variation would spend the
     shared Gemini free tier on a decision four hand-tuned themes already
     answer.

  FILTER BEFORE OFFERING, the rule this codebase already holds for themes
  (brand-theme-builder.ts): the eligible set is computed FIRST, so nothing
  unofferable is ever a possible outcome. Two filters make it up —
  `getLiveThemeVariations` (a soft-deleted theme has no parent to link to, and
  offering one would manufacture the detached draft §14.5b exists to prevent)
  and equality against what the source is already wearing (offering that is
  the defect). `pickNextThemeCandidate` is the same shape one layer down; it
  picks among GENERATED role sets for the builder form rather than among stored
  variations, so the shared thing here is the rule, not the function.

  INJECTED RANDOMNESS for the same reason the section composers take it: a
  shuffle whose stops cannot be pinned cannot be tested. The caller passes
  `Math.random()`; the tests sweep the range.
*/
export function pickVariationTheme({
  brandKit,
  sourceGlobals,
  randomValue,
}: {
  brandKit: BrandKit;
  /** {@link readSourceThemeGlobals} of the source draft — null on the shared defaults. */
  sourceGlobals: GlobalStyles | null;
  /** 0 ≤ value < 1, though a 1 is clamped rather than trusted. */
  randomValue: number;
}): VariationThemePick {
  const alternatives = getLiveThemeVariations(brandKit.variations).filter(
    (variation) =>
      !areGlobalsEqual({ a: variation.globals, b: sourceGlobals ?? undefined }),
  );
  const index = Math.min(
    alternatives.length - 1,
    Math.max(0, Math.floor(randomValue * alternatives.length)),
  );
  const variation = alternatives[index];
  /*
    A kit whose only live theme is the one already on screen. Reported rather
    than papered over: the caller seeds the source theme (today's behaviour,
    so the layout variation still happens) and SAYS so, because a design
    variation that silently produces an identical theme is a lie to the user.
  */
  return variation === undefined
    ? { isVaried: false, reason: "no-alternative-theme" }
    : { isVaried: true, variation };
}
