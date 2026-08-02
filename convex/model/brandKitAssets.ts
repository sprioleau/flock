/**
 * Pure planning logic for brand-kit row updates (Stage S of
 * docs/proposals/brand-kit-architecture.md) — no ctx, fully unit-testable.
 *
 * Two jobs:
 * 1. `planBrandKitSavePatch` — the patch-in-place save (replaces the old
 *    delete+reinsert, which churned `_id`): bumps the monotonic `revision`
 *    and decides, per asset kind, whether an incoming save keeps or clears
 *    the row's confirmed-asset state (§8.2 storage lifecycle — cleared
 *    confirmations surrender their storage files for deletion).
 * 2. `planAssetConfirmationPatch` / `planAssetRemovalPatch` — the confirm
 *    and remove flows for one asset kind.
 *
 * Convex patch semantics used throughout: a key explicitly set to
 * `undefined` REMOVES the field from the document (this is top-level patch
 * behavior, distinct from the serializer silently dropping nested
 * undefined values).
 */

/** The two confirmable asset kinds (proposal §8.1). */
export type BrandKitAssetKind = "logo" | "socialCard";

/** Per-kind field names on the brandKits row. */
const ASSET_FIELDS = {
  logo: {
    url: "logoUrl",
    storageId: "logoStorageId",
    sourceUrl: "logoSourceUrl",
    confirmedAtMs: "logoConfirmedAtMs",
  },
  socialCard: {
    url: "socialImageUrl",
    storageId: "socialImageStorageId",
    sourceUrl: "socialImageSourceUrl",
    confirmedAtMs: "socialImageConfirmedAtMs",
  },
} as const;

/** The asset + revision slice of a brandKits row (storageId kept opaque). */
export interface BrandKitAssetRowState {
  revision?: number;
  logoUrl?: string;
  logoStorageId?: string;
  logoSourceUrl?: string;
  logoConfirmedAtMs?: number;
  socialImageUrl?: string;
  socialImageStorageId?: string;
  socialImageSourceUrl?: string;
  socialImageConfirmedAtMs?: number;
}

/** Rows written before Stage S carry no revision — they are revision 1. */
export function getEffectiveRevision(row: { revision?: number }): number {
  return row.revision ?? 1;
}

export interface BrandKitPatchPlan {
  /** Field patch to apply to the row (undefined values REMOVE fields). */
  patch: Record<string, unknown>;
  /** Storage ids whose files must be deleted (replaced/cleared confirmations). */
  storageIdsToDelete: string[];
}

/**
 * Plan the asset/revision part of a patch-in-place save.
 *
 * Per kind: an incoming URL identical to the row's current URL preserves the
 * confirmation (re-saving an unchanged kit must not un-confirm assets); a
 * DIFFERENT incoming URL is a new suggestion — confirmation fields are
 * cleared and the old storage file is surrendered for deletion. Note a
 * confirmed asset's row URL is the durable storage URL, so a re-scrape
 * (which carries the original site URL) intentionally lands as a fresh
 * unconfirmed suggestion.
 *
 * REVISION POLICY (brand-kit-user-control §8.3, risk 3). `revision` drives
 * the "Updated brand available" pill on every draft of every bound canvas, so
 * it may only bump when something a DRAFT COULD RENDER changed: the theme
 * variations, or an asset URL. Everything else a save carries — the kit name,
 * the authored palette, tone of voice, social links — is kit metadata that no
 * draft renders, and bumping for it would re-arm every pill on the canvas
 * every time somebody renames a color. `renameBrandKit` already declined to
 * bump for exactly this reason; this generalizes the same rule.
 */
export function planBrandKitSavePatch({
  existing,
  incomingLogoUrl,
  incomingSocialImageUrl,
  hasRenderableChange,
}: {
  existing: BrandKitAssetRowState;
  incomingLogoUrl: string | undefined;
  incomingSocialImageUrl: string | undefined;
  /** True when the incoming variations differ from the stored ones. */
  hasRenderableChange: boolean;
}): BrandKitPatchPlan {
  const patch: Record<string, unknown> = {};
  const storageIdsToDelete: string[] = [];
  let hasAssetChange = false;
  const incomingByKind: Record<BrandKitAssetKind, string | undefined> = {
    logo: incomingLogoUrl,
    socialCard: incomingSocialImageUrl,
  };
  for (const kind of ["logo", "socialCard"] as const) {
    const fields = ASSET_FIELDS[kind];
    const incomingUrl = incomingByKind[kind];
    const isUrlUnchanged = incomingUrl === existing[fields.url];
    if (isUrlUnchanged) {
      continue; // same suggestion (or same durable URL) — confirmation survives
    }
    hasAssetChange = true;
    patch[fields.url] = incomingUrl; // undefined removes the field
    patch[fields.storageId] = undefined;
    patch[fields.sourceUrl] = undefined;
    patch[fields.confirmedAtMs] = undefined;
    const oldStorageId = existing[fields.storageId];
    if (oldStorageId !== undefined) {
      storageIdsToDelete.push(oldStorageId);
    }
  }
  if (hasRenderableChange || hasAssetChange) {
    patch.revision = getEffectiveRevision(existing) + 1;
  }
  return { patch, storageIdsToDelete };
}

/**
 * Plan a confirmation: the row's asset URL becomes the durable serving URL,
 * provenance + timestamp land, revision bumps (an asset swap is a meaningful
 * diff — Stage M propagation re-sources logos from it), and any previously
 * confirmed file for the kind is surrendered.
 */
export function planAssetConfirmationPatch({
  existing,
  kind,
  storageId,
  servingUrl,
  sourceUrl,
  nowMs,
}: {
  existing: BrandKitAssetRowState;
  kind: BrandKitAssetKind;
  storageId: string;
  servingUrl: string;
  sourceUrl: string;
  nowMs: number;
}): BrandKitPatchPlan {
  const fields = ASSET_FIELDS[kind];
  const patch: Record<string, unknown> = {
    revision: getEffectiveRevision(existing) + 1,
    [fields.url]: servingUrl,
    [fields.storageId]: storageId,
    [fields.sourceUrl]: sourceUrl,
    [fields.confirmedAtMs]: nowMs,
  };
  const oldStorageId = existing[fields.storageId];
  const storageIdsToDelete = oldStorageId !== undefined && oldStorageId !== storageId ? [oldStorageId] : [];
  return { patch, storageIdsToDelete };
}

/** Plan removing one asset (suggestion or confirmed) from the row entirely. */
export function planAssetRemovalPatch({
  existing,
  kind,
}: {
  existing: BrandKitAssetRowState;
  kind: BrandKitAssetKind;
}): BrandKitPatchPlan {
  const fields = ASSET_FIELDS[kind];
  const patch: Record<string, unknown> = {
    revision: getEffectiveRevision(existing) + 1,
    [fields.url]: undefined,
    [fields.storageId]: undefined,
    [fields.sourceUrl]: undefined,
    [fields.confirmedAtMs]: undefined,
  };
  const oldStorageId = existing[fields.storageId];
  return { patch, storageIdsToDelete: oldStorageId === undefined ? [] : [oldStorageId] };
}

/** Every storage id a row holds — used when clearing the whole kit (§8.2). */
export function collectRowStorageIds(row: BrandKitAssetRowState): string[] {
  return [row.logoStorageId, row.socialImageStorageId].filter(
    (storageId): storageId is string => storageId !== undefined,
  );
}
