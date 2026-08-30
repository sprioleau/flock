/*
  Logo blocks and the brand kit's logo (brand-kit-v2 §5).

  A logo block is an image block carrying `role: "logo"` — a semantic marker,
  not a visual property. Today that marker only pays off during brand
  propagation (`applyBrandToDocuments` re-sources every role-marked image to
  the kit's CONFIRMED logo). If the kit has no logo, or has one that was never
  confirmed, the block just sits there with whatever placeholder it was created
  with and nothing tells the user why. This module is the decision half of the
  fix: the selected block's property panel asks for the logo, in place.

  TWO RULES INHERITED, NOT REINVENTED:

  1. Only a CONFIRMED logo may enter a document (owner decision 4). An
     unconfirmed suggestion is a third-party hotlink that has not been rehosted
     into Convex storage, so it may be PREVIEWED in brand UI — the kit panel's
     asset card, and the unconfirmed state below, where seeing the image is the
     whole point of being asked to confirm it — and written nowhere. Callers
     pass the output of `getConfirmedBrandAssetUrl` for the write path; this
     module never turns `brandKit.logoUrl` into a document update.
  2. The "does this block need updating" test is byte-identical to the server's
     in `applyBrandToDocuments`: src OR alt differing is what counts. Two
     different answers to that question would make "Apply to all" and a brand
     propagation disagree about the same document.

  Pure (no React, no DOM): apps/web/vitest.config.ts pins `environment: "node"`,
  so state selection and update-building are unit-tested here and
  BrandLogoPromptRow.tsx stays a renderer. Same split as brand-kit-social-fill.
*/

import type { BlockId, EmailDocument } from "@flock/email-sdk";

/*
  The confirmed brand logo as a document write — src plus the alt to match.
*/
export interface BrandLogoSource {
  src: string;
  alt: string;
}

/*
  What the logo block's panel should be offering, from §5's three states plus
  the one the spec implies but does not name: a confirmed logo that this block
  is not yet using.
*/
export type LogoBlockPromptState =
  /*
    No saved kit for this canvas — the logo has nowhere to come from yet.
  */
  | { kind: "no-kit" }
  /*
    A kit exists but carries no logo at all.
  */
  | { kind: "no-logo" }
  /*
    A logo is present as a SUGGESTION — not yet rehosted, so not usable.

    `suggestedLogoUrl` is carried out so the panel can PREVIEW it: confirming
    is a judgement call ("is this actually our logo?") and a generic icon does
    not let anyone make it. Previewing a third-party URL in kit UI is what the
    brand kit panel already does; the line decision 4 draws is the DOCUMENT,
    and this field is never an input to `buildLogoBlockUpdates`.

    `isConfirmableHere` is whether the in-place confirm can act at all. The
    confirm route is session-scoped: it re-reads the suggestion from the
    VIEWER's own kit row. When this canvas is showing a kit somebody else
    saved and bound, confirming from here would quietly confirm a different
    kit than the one on screen, so the panel points at the brand kit instead
    of offering a button that lies about what it touches.
  */
  | { kind: "unconfirmed"; suggestedLogoUrl: string; isConfirmableHere: boolean }
  /*
    A confirmed logo exists. `isBlockUsingLogo` is this block; `staleBlockCount`
    is how many logo blocks in the whole draft (this one included) are not
    using it yet — the number behind "apply to all".
  */
  | { kind: "ready"; isBlockUsingLogo: boolean; staleBlockCount: number };

/*
  Decide what the panel offers. Ordered from "nothing to work with" outward, so
  the user is never asked to confirm a logo that does not exist or to apply one
  that is not durable.
*/
export function getLogoBlockPromptState({
  hasSavedKit,
  logoUrl,
  isViewerOwnKit,
  confirmedLogo,
  doc,
  blockId,
}: {
  hasSavedKit: boolean;
  /*
    The kit's raw logo field — used ONLY to tell "absent" from "unconfirmed",
    and to preview the suggestion. Never a document write: that is
    `confirmedLogo`'s job, and only it reaches `buildLogoBlockUpdates`.
  */
  logoUrl: string | undefined;
  /*
    True when the kit this canvas is using is the viewer's own saved kit —
    the only kit the session-scoped confirm route can act on.
  */
  isViewerOwnKit: boolean;
  /*
    The confirmed logo, or null. The only value allowed into a document.
  */
  confirmedLogo: BrandLogoSource | null;
  doc: EmailDocument;
  blockId: BlockId;
}): LogoBlockPromptState {
  if (!hasSavedKit) {
    return { kind: "no-kit" };
  }
  if (confirmedLogo === null) {
    return logoUrl === undefined
      ? { kind: "no-logo" }
      : { kind: "unconfirmed", suggestedLogoUrl: logoUrl, isConfirmableHere: isViewerOwnKit };
  }
  const staleBlockIds = buildLogoBlockUpdates({ doc, logo: confirmedLogo }).map(
    (update) => update.blockId,
  );
  return {
    kind: "ready",
    isBlockUsingLogo: !staleBlockIds.includes(blockId),
    staleBlockCount: staleBlockIds.length,
  };
}

/*
  One block to re-source, as a property merge-patch the panel dispatches.
*/
export interface LogoBlockUpdate {
  blockId: BlockId;
  properties: { src: string; alt: string };
}

/*
  Every `role: "logo"` image block in the document, in document order.
*/
export function collectLogoBlockIds(doc: EmailDocument): BlockId[] {
  return Object.values(doc)
    .filter((block) => block.type === "image" && block.properties.role === "logo")
    .map((block) => block.id);
}

/*
  The updates that put the confirmed logo into logo blocks — every one of them
  by default, or a named subset (the selected block alone). Blocks already
  carrying the exact src AND alt are omitted, so "Apply to all logo blocks"
  never appends a no-op batch to the undo stack.
*/
export function buildLogoBlockUpdates({
  doc,
  logo,
  blockIds,
}: {
  doc: EmailDocument;
  logo: BrandLogoSource;
  /*
    Restrict to these blocks; omit for every logo block in the document.
  */
  blockIds?: BlockId[];
}): LogoBlockUpdate[] {
  const allowed = blockIds === undefined ? null : new Set(blockIds);
  return collectLogoBlockIds(doc).flatMap((blockId) => {
    if (allowed !== null && !allowed.has(blockId)) {
      return [];
    }
    const block = doc[blockId];
    if (block === undefined || block.type !== "image") {
      return [];
    }
    const isCurrent = block.properties.src === logo.src && block.properties.alt === logo.alt;
    return isCurrent ? [] : [{ blockId, properties: { src: logo.src, alt: logo.alt } }];
  });
}

/*
  What the "apply to all" button says, with the count in it. The number is the
  point: an unlabelled "Apply to all" on a draft with one logo block reads as a
  bulk action the user cannot see the scope of.
*/
export function describeLogoApplyScope(staleBlockCount: number): string {
  return staleBlockCount === 1
    ? "Use brand logo here"
    : `Use brand logo in all ${staleBlockCount} logo blocks`;
}
