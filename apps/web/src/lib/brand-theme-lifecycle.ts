/*
  THEME DELETION IS SOFT, AND IT UNLINKS RATHER THAN RESTYLES
  (docs/proposals/brand-kit-user-control.md §14.5b — the owner's decision:
  "I think we should allow theme deletion, but it's a soft deletion (and
  unlinks existing drafts from using that theme)").

  THE HARD REQUIREMENT this module exists to make structurally true: deleting a
  theme must not restyle a single draft. So deletion writes ONE field on ONE
  kit row — `variations[i].deletedAtMs` — and touches nothing else. No document
  is read, no document is written, no op is committed. A draft that was
  rendering the deleted theme goes on rendering exactly the bytes it was
  rendering; `resolveDraftThemeLink` stops finding a parent for it and reports
  `never-applied`, which is the unlink. The label changes; the pixels do not.

  WHY MARK THE VARIATION RATHER THAN CLEAR THE DRAFTS' POINTERS. Both would
  unlink. Clearing pointers means a kit mutation reaching across into
  `documents` rows — every draft of every canvas bound to this kit, with no
  index to find them by, in a transaction whose whole safety argument
  (§14.5a) is that no kit mutation touches a document. It also loses by undo:
  the pointer is the thing that remembers which theme a draft was an instance
  of, and once cleared, restoring the theme cannot restore the link. Marking
  the variation keeps the write inside the kit, keeps the blast radius at one
  row, and makes the resolver the single place that decides what a pointer at
  a deleted theme means.

  WHAT THE SURVIVING ROW BUYS — the reason this is soft rather than a splice:

  1. RE-LINK. Restoring the variation makes every draft that pointed at it an
     instance of it again, with its per-property overrides intact, because the
     pointer and its `baselineGlobals` snapshot were never disturbed. A hard
     delete cannot offer this at any price: ids are slugged from the name
     (`buildUniqueVariationId`), so a re-created "Midnight" would collide-suffix
     to `midnight-2` and every pointer naming `midnight` would stay stranded.
  2. UNDO. The delete is one click behind a confirm dialog; the row surviving
     is what lets the panel offer "Undo" straight after, with no history spine
     and no second data model.
  3. It costs one optional number per variation and no migration.

  A deleted variation is invisible everywhere a theme is offered, matched,
  targeted or counted — see `getLiveThemeVariations`, which is the one filter
  all of those go through.

  Pure by design (no React, no ctx, no Convex): the decision — what may be
  deleted, what may be restored, and what the refusal says — is unit-tested
  here, and `convex/brandKits.ts` is the transaction that applies the plan.
*/

import {
  getLiveThemeVariations,
  isThemeVariationLive,
  MAX_BRAND_KIT_VARIATIONS,
  type SoftDeletableVariation,
} from "./brand-kit";

/*
  The least a variation has to be for this module to plan over it: something
  with an id that can be marked deleted. Generic rather than `ThemeVariation`
  so the Convex mutation can plan directly over its ROW's array — whose
  `globals` is the table validator's `Record<string, any>` — without a cast,
  and hand the result straight back to `ctx.db.patch`.
*/
type IdentifiedVariation = SoftDeletableVariation & { id: string };

/*
  The outcome of planning a deletion or a restore: the complete next
  `variations` array to write, or a message a person can act on. Shaped like
  `planSocialLinksUpdate` so the mutation reads the same way every other
  planned write in this codebase does.
*/
export type ThemeVariationDeletionPlan<Variation extends IdentifiedVariation> =
  | { isOk: true; variations: Variation[] }
  | { isOk: false; message: string };

/*
  Plan a soft delete (`isDeleted: true`) or its undo (`isDeleted: false`).

  ONE function for both directions on purpose: the two are the same write to
  the same field and share every gate that matters, and splitting them would
  invite the restore path to drift out of sync with the cap the delete path
  freed up. The mutation exposes both through one `isDeleted` argument for the
  same reason.
*/
export function planThemeVariationDeletion<Variation extends IdentifiedVariation>({
  variations,
  variationId,
  isDeleted,
  nowMs,
}: {
  variations: Variation[];
  variationId: string;
  isDeleted: boolean;
  nowMs: number;
}): ThemeVariationDeletionPlan<Variation> {
  const target = variations.find((variation) => variation.id === variationId);
  if (target === undefined) {
    return { isOk: false, message: "That theme is no longer in this kit." };
  }
  if (isThemeVariationLive(target) === !isDeleted) {
    /*
      Already in the requested state. A no-op rather than an error: two tabs
      (or a double-click) must not turn "it is already deleted" into a scary
      message about a theme that is exactly where the user wants it.
    */
    return { isOk: true, variations };
  }
  if (isDeleted && getLiveThemeVariations(variations).length <= 1) {
    /*
      The kit contract requires at least one live theme
      (`getBrandKitValidationErrors`), and a kit with no themes has no dropdown,
      no propagation target and nothing for `pickTargetVariation`'s final
      fallback to return. Refuse here, in words, rather than letting the write
      reach the server gate and come back as a contract violation.
    */
    return {
      isOk: false,
      message: "This is the kit's only theme — add another one before deleting this.",
    };
  }
  if (!isDeleted && getLiveThemeVariations(variations).length >= MAX_BRAND_KIT_VARIATIONS) {
    /*
      A restore takes a slot back, so it has to clear the cap the same way an
      append does. Deleting a theme and adding eight new ones is a real
      sequence, and it must not become a ninth live theme by way of Undo.
    */
    return {
      isOk: false,
      message: `This kit already holds ${MAX_BRAND_KIT_VARIATIONS} themes — the most it can carry.`,
    };
  }
  return {
    isOk: true,
    variations: variations.map((variation) => {
      if (variation.id !== variationId) {
        return variation;
      }
      if (!isDeleted) {
        /*
          Restore CLEARS the field rather than setting it to a falsy number:
          "live" is the ABSENCE of `deletedAtMs` everywhere else in the system
          (`isThemeVariationLive`, the schema's `v.optional`), so a restored row
          has to be indistinguishable from one that was never deleted. Convex
          stores an explicitly-undefined optional field as absent, which is
          exactly that.
        */
        return { ...variation, deletedAtMs: undefined };
      }
      return { ...variation, deletedAtMs: nowMs };
    }),
  };
}
