/*
  THEME IDENTITY AND PER-PROPERTY OVERRIDES — the answer to the question
  `convex/brandKits.ts` and `lib/brand-theme-builder.ts` both defer to, recorded
  in docs/proposals/brand-kit-user-control.md §14.5a.

  The old model: a draft "is" whichever variation its globals payload happens to
  equal, byte for byte. Payload equality WAS identity, which had two costs. A
  draft that diverged by one color lost its theme entirely ("detached" — read by
  the code as "the user hand-edited away"), and editing a variation's globals
  would detach every draft rendering it, which is why there is no theme edit path
  today.

  The new model is Webflow's: the parent theme supplies values, individual local
  choices override specific ones, and the link between them survives both.

  IDENTITY RESOLVES `matched payload → surviving pointer → none`.

  Equality does not stop being identity; it stops being the ONLY identity. An
  exact whole-payload match is still the strongest evidence there is ("this draft
  is that theme, with zero overrides") and keeps first say. The advisory pointer
  (`documents.brand.variationId`) becomes authoritative exactly where equality has
  no answer — which is precisely the overridden case.

  Pointer-FIRST was rejected, and the reason is undo. Undo restores globals
  without touching the pointer (see the `documents.brand` schema comment), so a
  draft switched Classic → Midnight and then undone carries
  `payload = Classic, pointer = Midnight`. Pointer-first calls that "Midnight with
  twenty-six overrides"; equality-first calls it "Classic, clean" — which is what
  the person is looking at.

  That ordering is also the migration guarantee: for every draft that resolves to
  a variation TODAY, this resolver resolves to the SAME variation. It only assigns
  identity where there was none. Nothing is restyled by a change of vocabulary.

  OVERRIDES ARE DERIVED, NEVER BOOKKEPT. The override set is
  `diff(resolve(draft globals), resolve(baseline))`, recomputed on every read from
  data that already exists. The alternative — maintaining a list of overridden
  keys on the document — would be an invariant with a dozen writers (applyTheme,
  updateBlockProperties, replaceBlockProperties, history reverts, the agent), and
  every one of them a chance to drift. Deriving means undo, collaborator edits and
  batch reverts all converge for free, exactly as the pill states already do.

  The BASELINE is what makes a theme EDIT possible: it is the variation's globals
  as of the moment the pointer was written. Once the kit's copy of "Midnight"
  moves, `diff(payload, variation.globals)` can no longer tell a local override
  from a not-yet-adopted parent change — so propagation would preserve the stale
  values instead of adopting the new ones. Diffing against the baseline separates
  the two cleanly. When the baseline is ABSENT (every row written before this
  landed) it falls back to the variation's current globals, which for an unedited
  kit is the same payload — that is the whole migration.

  Pure by design (no React, no ctx, no Convex): `apps/web/vitest.config.ts` pins
  `environment: "node"`, and BOTH the server (convex/brandKits.ts) and the client
  (the toolbar's override dot) resolve identity through this one module, so a
  draft can never be labelled one thing by the query and another by the UI.
*/

import {
  DEFAULT_GLOBAL_STYLES,
  resolveGlobalStyles,
  type GlobalStyles,
} from "@flock/email-sdk";
import { areGlobalsEqual, type ThemeVariation } from "./brand-kit";

/* Every global style property, as a literal key union — the diff's alphabet. */
export type GlobalStyleKey = keyof Required<GlobalStyles>;

const GLOBAL_STYLE_KEYS = Object.keys(DEFAULT_GLOBAL_STYLES).sort() as GlobalStyleKey[];

/*
  The advisory brand pointer as this module needs it — structurally identical to
  `documents.brand` but declared here so the pure logic stays free of Convex
  types (the server passes its row's field straight in).
*/
export interface DraftBrandPointer {
  kitId: string;
  revision: number;
  variationId: string;
  /*
    The variation's globals AS OF the moment this pointer was written. Optional
    because it is additive: rows written before §14.5a have none, and resolution
    falls back to the variation's current payload for them.
  */
  baselineGlobals?: GlobalStyles;
}

/*
  What a draft's theme link amounts to. `state` is the vocabulary three UI
  surfaces read; the rest is what the indicator and the propagation merge need.
*/
export type DraftThemeState = "current" | "overridden" | "outdated" | "never-applied";

export interface DraftThemeLink {
  state: DraftThemeState;
  /*
    The theme this draft is an instance OF, or null when it has no parent in the
    bound kit (never applied, or pointing at another kit entirely).
  */
  parentVariationId: string | null;
  /*
    The global properties whose resolved value differs from the parent theme's —
    sorted, so the value is stable across reads and comparable in tests.
  */
  overriddenGlobalKeys: GlobalStyleKey[];
  /* The baseline the overrides were measured against; null when there is no parent. */
  baselineGlobals: Required<GlobalStyles> | null;
}

/*
  Copy ONE global style key across two resolved payloads. Exists purely so the
  merge below stays type-safe: `target[key] = source[key]` over a union of keys
  is an error (TS widens the value to the union of every field type), while over
  a single generic key it is exact. No casts, no `unknown` — the owner's rule.
*/
function copyGlobalStyleKey<Key extends GlobalStyleKey>({
  target,
  source,
  key,
}: {
  target: Required<GlobalStyles>;
  source: Required<GlobalStyles>;
  key: Key;
}): void {
  target[key] = source[key];
}

/*
  The per-property diff, computed on RESOLVED payloads rather than raw ones.

  Every globals field is optional and the renderer falls back to
  DEFAULT_GLOBAL_STYLES, so an absent key and a key explicitly set to the
  renderer default render identically. A raw-key diff would report the second as
  an override and light the indicator for a draft nobody changed. Resolving both
  sides first makes the diff mean what the user means: "this looks different from
  the theme".
*/
export function getOverriddenGlobalKeys({
  globals,
  baseline,
}: {
  globals: GlobalStyles | undefined;
  baseline: GlobalStyles | undefined;
}): GlobalStyleKey[] {
  const resolvedGlobals = resolveGlobalStyles(globals);
  const resolvedBaseline = resolveGlobalStyles(baseline);
  return GLOBAL_STYLE_KEYS.filter((key) => resolvedGlobals[key] !== resolvedBaseline[key]);
}

/*
  The Webflow merge: the parent theme supplies every value, then the draft's
  overridden properties are re-applied on top.

  This is what propagation writes, and it is why a theme edit is now safe. With
  ZERO overrides the result is the theme's payload verbatim — byte-identical to
  what propagation wrote before §14.5a, which is the "no wrong restyle" property
  stated in code rather than prose. With overrides it changes strictly LESS of
  the draft than the old wholesale replace did.
*/
export function composeThemeGlobals({
  themeGlobals,
  draftGlobals,
  overriddenGlobalKeys,
}: {
  themeGlobals: GlobalStyles;
  draftGlobals: GlobalStyles | undefined;
  overriddenGlobalKeys: GlobalStyleKey[];
}): Required<GlobalStyles> {
  const composed = resolveGlobalStyles(themeGlobals);
  const resolvedDraft = resolveGlobalStyles(draftGlobals);
  for (const key of overriddenGlobalKeys) {
    copyGlobalStyleKey({ target: composed, source: resolvedDraft, key });
  }
  return composed;
}

/*
  Resolve a draft's theme link. The ladder below is written to be a strict
  REFINEMENT of the pre-§14.5a status ladder — each branch either produces the
  same state the old code produced, or a renamed one with the same meaning:

    old: matched → "current"
         pointer stale (other kit, or older revision) → "outdated"
         pointer for this kit → "detached"
         otherwise → "never-applied"

  The one genuinely new judgement is whether the BASELINE can be trusted — see
  the long note at the bottom. Everything else is the old ladder with a better
  vocabulary and a per-property diff hung off it.
*/
export function resolveDraftThemeLink({
  variations,
  kitId,
  revision,
  globals,
  pointer,
}: {
  variations: ThemeVariation[];
  kitId: string;
  revision: number;
  globals: GlobalStyles | undefined;
  pointer: DraftBrandPointer | undefined;
}): DraftThemeLink {
  const matched =
    variations.find((variation) => areGlobalsEqual({ a: globals, b: variation.globals })) ?? null;

  /* An exact payload match is identity with zero overrides, by construction. */
  if (matched !== null) {
    return {
      state: "current",
      parentVariationId: matched.id,
      overriddenGlobalKeys: [],
      baselineGlobals: resolveGlobalStyles(matched.globals),
    };
  }

  /*
    No pointer and no payload match: genuinely parentless. This is the state
    `never-applied` exists to name — the §5.2 skipped draft — and it stays
    distinct from `overridden` precisely because it is the one shape with no
    theme behind it at all.
  */
  if (pointer === undefined) {
    return {
      state: "never-applied",
      parentVariationId: null,
      overriddenGlobalKeys: [],
      baselineGlobals: null,
    };
  }

  const isPointerForThisKit = pointer.kitId === kitId;
  const hasStalePointer = !isPointerForThisKit || pointer.revision < revision;
  const pointedVariation = isPointerForThisKit
    ? (variations.find((variation) => variation.id === pointer.variationId) ?? null)
    : null;
  if (pointedVariation === null) {
    /*
      A pointer with nothing to point AT in the bound kit. Two shapes, and both
      keep the state the old ladder gave them:

      - Another kit was bound to this canvas, or this kit moved past a variation
        the pointer named — `outdated`, and the propagation TARGET still falls
        back through pickTargetVariation exactly as before.
      - A pointer at THIS kit's current revision naming a variation id the kit no
        longer carries. Only theme DELETION can create it; deletion is unbuilt
        and undesigned (§14.5a). It reports `overridden` with a null parent,
        which suppresses both the indicator and the pill — the same silence the
        old `detached` state gave it.
    */
    return {
      state: hasStalePointer ? "outdated" : "overridden",
      parentVariationId: null,
      overriddenGlobalKeys: [],
      baselineGlobals: null,
    };
  }

  /*
    IS THE BASELINE TRUSTWORTHY? This is the distinction the whole migration
    turns on, and getting it wrong breaks real drafts in opposite directions.

    A row written before §14.5a carries no baseline, so the fallback is the
    variation's CURRENT globals. That fallback is only sound while the variation
    has not moved since the pointer was written — which is exactly what
    `pointer.revision >= revision` certifies.

    When it HAS moved (say `updateBrandFonts` rewrote every variation's font
    stacks and bumped), diffing a legacy draft's correct-but-old payload against
    the moved variation would report the kit's OWN font change as the user's
    override. Two bad things follow: the draft loses its "Updated brand
    available" pill, and — far worse — propagation would faithfully "preserve"
    those fonts, so the update the person confirmed would silently not land.

    So an untrustworthy baseline yields NO overrides. That is precisely the
    pre-§14.5a behaviour for those rows: propagation writes the theme verbatim.
    Rows that DO carry a baseline are trustworthy at any revision — which is
    what makes a theme edit propagate while local choices survive it.
  */
  const isBaselineTrustworthy =
    pointer.baselineGlobals !== undefined || pointer.revision >= revision;
  const baselineGlobals = resolveGlobalStyles(pointer.baselineGlobals ?? pointedVariation.globals);
  const overriddenGlobalKeys = isBaselineTrustworthy
    ? getOverriddenGlobalKeys({ globals, baseline: baselineGlobals })
    : [];
  /*
    Is there anything to adopt? Two independent signals, either of which means
    "outdated": the kit moved on since this pointer was written (the revision,
    which is what `updateBrandThemeVariation` and `updateBrandFonts` bump), or
    the parent's CURRENT globals composed with this draft's overrides differ
    from what the draft renders now. The second is belt-and-braces — it catches
    a variation payload that changed without a bump — and it is also exactly the
    predicate `applyBrandToDocuments` uses to decide whether to emit an op.
  */
  const composed = composeThemeGlobals({
    themeGlobals: pointedVariation.globals,
    draftGlobals: globals,
    overriddenGlobalKeys,
  });
  const hasPendingParentChange =
    hasStalePointer || !areGlobalsEqual({ a: composed, b: resolveGlobalStyles(globals) });

  return {
    state: hasPendingParentChange
      ? "outdated"
      : overriddenGlobalKeys.length > 0
        ? "overridden"
        : "current",
    parentVariationId: pointedVariation.id,
    overriddenGlobalKeys,
    baselineGlobals,
  };
}

/*
  Should the toolbar show the override dot?

  Deliberately takes the section-background signal SEPARATELY rather than folding
  it into the server-side state. `innerBackgroundColor` / `outerBackgroundColor`
  live on SECTION blocks, not in globals — a different layer, and the one
  `applyTheme` strips. Teaching `getCanvasBrandStatus` about it would make a
  reactive query three components subscribe to depend on every block row of every
  draft on the canvas, so any text edit anywhere would invalidate it for
  everyone. The editor store already knows the answer for the ACTIVE draft, for
  free, and the dot only ever describes the active draft — so the two layers are
  composed here, at the one place that needs both.

  The dot requires a PARENT. A draft with no theme has nothing to override, and a
  dot with nothing behind it is the "super in your face" failure the owner asked
  us to avoid.
*/
export function getThemeOverrideIndicator({
  parentVariationId,
  overriddenGlobalKeys,
  hasSectionThemeOverrides,
}: {
  parentVariationId: string | null;
  /*
    `readonly string[]`, not `GlobalStyleKey[]`, on purpose: only the COUNT
    matters here, and the caller reads this straight off the Convex query,
    whose validator carries plain strings. Narrowing the parameter would force
    every caller into a cast for no gain in safety.
  */
  overriddenGlobalKeys: readonly string[];
  hasSectionThemeOverrides: boolean;
}): { isVisible: boolean; overrideCount: number } {
  if (parentVariationId === null) {
    return { isVisible: false, overrideCount: 0 };
  }
  const overrideCount = overriddenGlobalKeys.length + (hasSectionThemeOverrides ? 1 : 0);
  return { isVisible: overrideCount > 0, overrideCount };
}

/*
  Human wording for the indicator's tooltip and the panel's note. Kept here
  beside the count so the toolbar and the brand kit panel cannot describe the
  same state in two different voices.
*/
export function describeThemeOverrides({
  themeName,
  overrideCount,
}: {
  themeName: string;
  overrideCount: number;
}): string {
  const noun = overrideCount === 1 ? "change" : "changes";
  return `Using “${themeName}” with ${overrideCount} local ${noun}. Pick the theme again to reset.`;
}
