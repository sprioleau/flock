import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { isUrlRegisteredAsset } from "./assets";
import { collectRowStorageIds } from "./brandKitAssets";
import { deleteBlockSyncDoc } from "./textBlockSync";

/*
  Phase 6.1 — shared (non-registered) helpers for the unclaimed-session
  cleanup cron (plan §6.1d).

  WHO MAY BE SWEPT, which is the half of this file that has teeth. This header
  used to read "this app is no-auth: every session is 'unclaimed', so a
  document is stale purely by inactivity". That was true the day it was written
  and stopped being true when Better Auth shipped (059b47b) — and because it
  was the stated REASON there was no ownership test, the cron went on
  cascade-deleting the canvases and drafts of people who had signed up and then
  gone quiet for a month. Inactivity is now only half the test:

    a document is swept when it is stale AND its owner is demonstrably
    unclaimed. CLAIMED ACCOUNTS ARE EXEMPT, unconditionally.

  Not "probably unclaimed": the cron runs with no caller identity, so it cannot
  ask who anybody is and has to read ownership off the rows. Every branch that
  cannot prove a session is unclaimed RETAINS — the same posture the storage
  scans below take ("over the bound, files are retained, never guess-deleted"),
  for the same reason. A retained stale document costs a row; a wrongly deleted
  one costs someone's work. See classifyDocumentOwner for how the distinction is
  actually made, and for the two gaps it does not close.

  Staleness signal: `documents.updatedAtMs`. Every write path funnels through
  commitVersions (documents.applyOperations, history undo/redo/revert/
  rollback, agentText.applyAgentTextEdit), which patches `updatedAtMs` on
  every committed operation; createDocument/duplicateDocument set it at
  birth. The ONE writer that bypasses it is the ~1s ProseMirror snapshot
  mirror (prosemirror.ts onSnapshot) — but every editing session ends with a
  session `updateText` commit, so the lag is bounded by one editing session:
  negligible against a 30-day threshold, and no new field or shared-file edit
  was needed. The `by_updatedAtMs` index makes the stale scan a cheap range
  read.

  Deletion is a full per-document cascade, ordered so a budget-exhausted
  partial run is always resumable (the document row is deleted LAST, so an
  unfinished document stays stale and is re-picked by the next run):

    1. operation rows            (can be numerous — paged against the budget)
    2. snapshot rows
    3. storage files referenced by the document's image blocks (before the
       block rows go away, so a partial run never loses the src list)
    4. per-text-block ProseMirror sync docs + all block rows
    5. the transient ghost-session row, if one was stranded (at most one
       per document; normally deleted when the ghost run ends)
    6. persisted persona findings for the document (advisory suggestion
       rows; a handful per document at most), then the document's comment
       threads (comments mode; bounded per canvas)
    7. the document row
    8. the parent canvas, iff it now holds no documents (canvases own
       documents; an empty canvas of an unclaimed session is dead weight)

  The cascade is shared with the USER-INVOKED draft delete
  (documents.deleteDocument), which runs it with the same budget and
  schedules a targeted cleanup continuation if the budget runs out. THAT path
  carries no ownership test and must not grow one: the human asked for the
  delete, and refusing to finish it because they have an account would leave
  half-cascaded documents behind forever.

  Once a session's last document is gone, its SESSION-KEYED library —
  brandKits, assets, savedSections and persona copies — is swept too
  (sweepDeadSessionRows). Those rows are keyed to an owner rather than to a
  document, so nothing in the per-document cascade could ever reach them; they
  used to outlive every draft they belonged to, forever, along with the storage
  files the asset rows own.
*/

export const DEFAULT_RETENTION_DAYS = 30;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/*
  Stale documents picked up per cron run (continuations re-schedule for the rest).
*/
export const MAX_STALE_DOCUMENTS_PER_RUN = 5;

/*
  Row-deletion budget per mutation run, well under Convex's per-mutation
  write limits (mirrors the MAX_OPERATIONS_PER_CALL bounding style in
  model/emailDocuments.ts). Component sync-doc deletes count against it too;
  the component internally pages its own snapshot/step deletion via the
  scheduler, so each call is cheap here.
*/
export const MAX_ROW_DELETIONS_PER_RUN = 1000;

/*
  Upper bound on the `_storage` scan used to reverse-map serving URLs to
  storage ids (see resolveStorageIdsByUrl). Beyond this many files the
  mapping is skipped — files are then retained, never guess-deleted.
*/
export const MAX_STORAGE_FILES_SCANNED = 256;

/*
  Bound on the whole-table `blocks` read used by the storage-file reference
  check (`properties` is a v.record, which Convex cannot index by nested
  path, so an index-backed lookup on properties.src is impossible). The scan
  runs at most once per cascade, and only for documents that actually
  reference this deployment's file storage. Over the bound, files are
  retained — never guess-deleted.
*/
const MAX_BLOCK_ROWS_SCANNED = 4000;

/*
  Bound on the Better Auth user rows read to build the claimed-account
  exemption (loadAuthUserIndex). Over the bound the sweep DECLINES TO RUN at
  all rather than run against a partial answer — an incomplete exemption set
  does not mean "a few extra rows survive", it means the missing users' work
  gets deleted. Sized to sit alongside the block scan above without
  approaching Convex's per-transaction read limit; a deployment that outgrows
  it needs an indexed claimed-owner lookup, not a bigger number, and the warn
  log says so.
*/
export const MAX_AUTH_USERS_SCANNED = 4096;

/*
  Bound on one dead session's library rows per table. A session that somehow
  holds more is left alone with a warning (see sweepDeadSessionRows): the
  sweep is all-or-nothing per session, so declining is the only outcome that
  cannot strand half a library behind a document that no longer exists to
  re-trigger it.
*/
const MAX_SESSION_ROWS_SWEPT = 256;

/*
  Mutable row-deletion budget threaded through one cleanup run.
*/
export interface DeletionBudget {
  remaining: number;
}

export interface CleanupStats {
  deletedDocuments: number;
  deletedCanvases: number;
  deletedBlocks: number;
  deletedOperations: number;
  deletedSnapshots: number;
  deletedSyncDocs: number;
  deletedStorageFiles: number;
  /*
    Session-keyed library rows, swept once a session owns nothing.
  */
  deletedBrandKits: number;
  deletedAssets: number;
  deletedSavedSections: number;
  deletedPersonaCopies: number;
}

export function createEmptyCleanupStats(): CleanupStats {
  return {
    deletedDocuments: 0,
    deletedCanvases: 0,
    deletedBlocks: 0,
    deletedOperations: 0,
    deletedSnapshots: 0,
    deletedSyncDocs: 0,
    deletedStorageFiles: 0,
    deletedBrandKits: 0,
    deletedAssets: 0,
    deletedSavedSections: 0,
    deletedPersonaCopies: 0,
  };
}

/*
  Every Better Auth user id the deployment knows, mapped to whether that user
  is still anonymous. Presence in the map is itself a signal — see
  classifyDocumentOwner, which reads "no entry" differently depending on where
  the owner key came from.
*/
export interface AuthUserIndex {
  isAnonymousById: Map<string, boolean>;
}

/*
  Read the Better Auth user table once per run, or return null when it cannot
  be read completely.

  WHY THE WHOLE TABLE, AND NOT A LOOKUP PER OWNER. The obvious shape is
  `authComponent.getAnyUserById(ctx, ownerId)` for each candidate. That
  resolves through the component's adapter as a where-clause on `_id`, i.e. it
  puts the owner key into an ID POSITION — and the owner keys this cron sees
  are mostly pre-auth localStorage UUIDs, which are not ids of anything. The
  component's `in` path does that through the table-qualified `db.get` and
  throws outright on a UUID ("Invalid argument `id`, expected ID in table
  'user'", measured against convex-test), while its `eq` path answers null in
  convex-test and would be relying on undocumented backend behavior to keep
  doing so in production. That divergence is the real problem: a green test
  suite would prove nothing about the deployment, where the same call may abort
  the whole mutation on the first legacy row it meets. Reading rows OUT of the
  table never puts a caller-shaped string in an id position, so there is no
  such failure mode, and one bounded read per run is cheaper than a lookup per
  document anyway.

  `select` trims the response, not the underlying read, but it keeps every
  user's email and name from crossing the component boundary into a cron with
  no business holding either.
*/
export async function loadAuthUserIndex(ctx: MutationCtx): Promise<AuthUserIndex | null> {
  const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: "user",
    select: ["_id", "isAnonymous"],
    paginationOpts: { cursor: null, numItems: MAX_AUTH_USERS_SCANNED + 1 },
  })) as { page: { _id: string; isAnonymous?: boolean | null }[]; isDone: boolean };

  if (result.page.length > MAX_AUTH_USERS_SCANNED || !result.isDone) {
    console.warn(
      `cleanup: Better Auth holds more than ${MAX_AUTH_USERS_SCANNED} users; ` +
        `the claimed-account exemption cannot be built completely, so the ` +
        `stale-document sweep is skipped this run (nothing deleted).`,
    );
    return null;
  }

  const isAnonymousById = new Map<string, boolean>();
  for (const user of result.page) {
    isAnonymousById.set(user._id, user.isAnonymous === true);
  }
  return { isAnonymousById };
}

export interface DocumentOwnerVerdict {
  /*
    True when this document belongs to an account somebody claimed by email.
  */
  isClaimed: boolean;
  /*
    Owner keys this document's session is known by, populated only when the
    session is unclaimed — the keys sweepDeadSessionRows is driven from.
  */
  unclaimedOwnerKeys: string[];
}

/*
  A key that names a Better Auth user who is no longer anonymous.
*/
function isClaimedOwnerKey(authUsers: AuthUserIndex, ownerKey: string): boolean {
  return authUsers.isAnonymousById.get(ownerKey) === false;
}

/*
  THE OWNERSHIP TEST. Can this stale document be deleted, and under which keys
  does its session's library live?

  READ THIS BEFORE CHANGING ANY BRANCH — a wrong answer here is somebody's
  work. The awkward part is that Flock keys the same human two different ways,
  on purpose:

    `documents.sessionId` / `canvases.sessionId`  the CLIENT's localStorage
        UUID, verbatim. Documents and canvases are deliberately exempt from
        identity resolution because the doc URL is the capability and
        share-by-link is the product (convex/authIdentity.ts, closing note), so
        signing in does not change this column. It is NOT an identity and can
        never, on its own, tell you whether anyone claimed an account.

    `canvasOwners.ownerId`                        the SERVER-RESOLVED owner —
        `identity.subject` (a Better Auth user id carried by a verified JWT)
        when the creator had an identity, otherwise the same localStorage UUID
        as a fallback. Written only by recordCanvasOwnerFromCaller
        (convex/canvases.ts), never from a client argument (schema.ts
        `canvasOwners`). This is the only column that links a canvas to an
        account, which is why the exemption is keyed off it.

  So three checks, any one of which retains the document:

    1. `documents.sessionId` itself names a claimed user. True after an
       operator ran `authMigration.adoptLegacySessionData`, which re-keys the
       document column to the durable user id.
    2. An ownership row of the parent canvas names a claimed user — the canvas
       sits in a claimed account's dashboard (`user.isAnonymous !== true`, the
       same flag `authCredits.isClaimedIdentity` tiers on).
    3. An ownership row is IDENTITY-BACKED but names no user at all. This is
       the case that matters most and is the least obvious. "Identity-backed"
       means the key differs from the canvas's own `sessionId`: those two are
       written from the same argument in the same transaction
       (documents.createDocument), so they are equal exactly when there was no
       identity to resolve and differ exactly when there was. A key that came
       from a verified identity and now resolves to nothing means Better Auth
       DELETED that user — and it deletes exactly one kind of user, the
       anonymous row it discards after `onLinkAccount` (convex/auth.ts, and
       `deleteUser` in better-auth's anonymous plugin). A dangling
       identity-backed owner key therefore IS a claimed account.

  TWO GAPS, stated plainly, because pretending otherwise is how the last
  version of this comment did damage:

    - A canvas created BEFORE auth shipped, by someone who has since claimed an
      account, has an ownership row keyed to their localStorage UUID and no
      user row anywhere. It is indistinguishable from an abandoned pre-auth
      browser and WILL be swept. The fix is adoption, not a heuristic:
      `canvases.adoptCanvasesBySessionId` and
      `authMigration.adoptLegacySessionData` exist for exactly this and re-key
      those rows onto the durable id.
    - `authMigration.migrateOwnedRows` NOW re-keys `canvasOwners` onto the
      durable user id, so check 2 normally carries claimed users and check 3
      has become belt and braces — exactly as the previous version of this note
      predicted it would. KEEP CHECK 3 REGARDLESS: it is still the only thing
      covering a link that half-completed, which is a real state because the
      migration is bounded at 512 rows per table and the overflow stays keyed
      to the anonymous id Better Auth deletes on the way out.
*/
export async function classifyDocumentOwner({
  ctx,
  document,
  authUsers,
}: {
  ctx: MutationCtx;
  document: Doc<"documents">;
  authUsers: AuthUserIndex;
}): Promise<DocumentOwnerVerdict> {
  if (isClaimedOwnerKey(authUsers, document.sessionId)) {
    return { isClaimed: true, unclaimedOwnerKeys: [] };
  }

  const canvas = await ctx.db.get(document.canvasId);
  const ownerRows = await ctx.db
    .query("canvasOwners")
    .withIndex("by_canvasId", (q) => q.eq("canvasId", document.canvasId))
    .collect();

  const unclaimedOwnerKeys = new Set<string>([document.sessionId]);
  for (const ownerRow of ownerRows) {
    if (isClaimedOwnerKey(authUsers, ownerRow.ownerId)) {
      return { isClaimed: true, unclaimedOwnerKeys: [] };
    }
    /*
      A missing canvas row cannot prove the key was the localStorage fallback,
      so it is treated as identity-backed: retention is the safe direction and
      a document whose canvas has vanished is a repair job, not a sweep.
    */
    const isIdentityBacked = canvas === null || ownerRow.ownerId !== canvas.sessionId;
    if (isIdentityBacked && !authUsers.isAnonymousById.has(ownerRow.ownerId)) {
      return { isClaimed: true, unclaimedOwnerKeys: [] };
    }
    unclaimedOwnerKeys.add(ownerRow.ownerId);
  }

  return { isClaimed: false, unclaimedOwnerKeys: [...unclaimedOwnerKeys] };
}

/*
  Delete the full constellation of one stale document, respecting `budget`.
  Returns isComplete=false when the budget ran out mid-cascade; the document
  row is still present then, so the next run resumes it idempotently.
*/
export async function deleteDocumentCascade({
  ctx,
  document,
  budget,
  stats,
}: {
  ctx: MutationCtx;
  document: Doc<"documents">;
  budget: DeletionBudget;
  stats: CleanupStats;
}): Promise<{ isComplete: boolean }> {
  const documentId = document._id;

  /*
    1. Operation rows — the only table that can be large per document; paged.
  */
  {
    const rows = await ctx.db
      .query("operations")
      .withIndex("by_documentId_and_version", (q) => q.eq("documentId", documentId))
      .take(budget.remaining + 1);
    const deletableRows = rows.slice(0, budget.remaining);
    for (const row of deletableRows) {
      await ctx.db.delete(row._id);
    }
    stats.deletedOperations += deletableRows.length;
    budget.remaining -= deletableRows.length;
    if (rows.length > deletableRows.length) {
      return { isComplete: false };
    }
  }

  /*
    2. Snapshot rows.
  */
  {
    const rows = await ctx.db
      .query("snapshots")
      .withIndex("by_documentId_and_version", (q) => q.eq("documentId", documentId))
      .take(budget.remaining + 1);
    const deletableRows = rows.slice(0, budget.remaining);
    for (const row of deletableRows) {
      await ctx.db.delete(row._id);
    }
    stats.deletedSnapshots += deletableRows.length;
    budget.remaining -= deletableRows.length;
    if (rows.length > deletableRows.length) {
      return { isComplete: false };
    }
  }

  /*
    Block rows are bounded (an email document is a few dozen blocks).
  */
  const blockRows = await ctx.db
    .query("blocks")
    .withIndex("by_documentId", (q) => q.eq("documentId", documentId))
    .collect();

  /*
    3. Storage files referenced by this document's image blocks — BEFORE the
    block rows are deleted, so a budget-exhausted run cannot orphan a file by
    losing the only rows that pointed at it.
  */
  const imageSrcUrls = new Set<string>();
  for (const row of blockRows) {
    if (row.type === "image" && typeof row.properties.src === "string") {
      imageSrcUrls.add(row.properties.src);
    }
  }
  const storageResult = await deleteUnreferencedStorageFiles({
    ctx,
    urls: imageSrcUrls,
    excludeDocumentId: documentId,
    budget,
    stats,
  });
  if (!storageResult.isComplete) {
    return { isComplete: false };
  }

  /*
    4. Per-text-block ProseMirror sync docs (composite id
    `${documentId}:${blockId}`) and the block rows themselves.
  */
  for (const row of blockRows) {
    if (budget.remaining <= 0) {
      return { isComplete: false };
    }
    if (row.type === "text") {
      await deleteBlockSyncDoc(ctx, { documentId, blockId: row.blockId });
      stats.deletedSyncDocs += 1;
      budget.remaining -= 1;
    }
    await ctx.db.delete(row._id);
    stats.deletedBlocks += 1;
    budget.remaining -= 1;
  }

  /*
    5. The transient ghost-session row (at most one per document; a stranded
    row would otherwise dangle forever once its document is gone).
  */
  const ghostSessionRows = await ctx.db
    .query("ghostSessions")
    .withIndex("by_documentId", (q) => q.eq("documentId", documentId))
    .collect();
  for (const row of ghostSessionRows) {
    if (budget.remaining <= 0) {
      return { isComplete: false };
    }
    await ctx.db.delete(row._id);
    budget.remaining -= 1;
  }

  /*
    6. Persisted persona findings (advisory suggestion rows) — added after
    Phase 6.1: without this step a deleted document would strand its open/
    dismissed/applied finding rows forever.
  */
  const personaFindingRows = await ctx.db
    .query("personaFindings")
    .withIndex("by_documentId", (q) => q.eq("documentId", documentId))
    .collect();
  for (const row of personaFindingRows) {
    if (budget.remaining <= 0) {
      return { isComplete: false };
    }
    await ctx.db.delete(row._id);
    budget.remaining -= 1;
  }

  /*
    6b. Comment threads placed on this document (comments mode) — bounded
    like findings (a canvas holds at most a couple hundred), and deleted
    BEFORE the document row for the same resumability reason.
  */
  const commentRows = await ctx.db
    .query("comments")
    .withIndex("by_documentId", (q) => q.eq("documentId", documentId))
    .collect();
  for (const row of commentRows) {
    if (budget.remaining <= 0) {
      return { isComplete: false };
    }
    await ctx.db.delete(row._id);
    budget.remaining -= 1;
  }

  /*
    7. The document row, LAST — its presence is the resumption marker.
  */
  if (budget.remaining <= 0) {
    return { isComplete: false };
  }
  await ctx.db.delete(documentId);
  stats.deletedDocuments += 1;
  budget.remaining -= 1;

  /*
    8. The parent canvas, iff this was its last document — and with it the
    dashboard ownership rows that pointed at it. Those rows are inlined here
    rather than imported from convex/canvases.ts because that module imports
    THIS one (it reuses this cascade for whole-canvas deletion); a dangling
    owner row is otherwise immortal, since nothing else ever revisits it.
  */
  const survivingSibling = await ctx.db
    .query("documents")
    .withIndex("by_canvasId", (q) => q.eq("canvasId", document.canvasId))
    .first();
  if (survivingSibling === null) {
    const canvas = await ctx.db.get(document.canvasId);
    if (canvas !== null) {
      const ownerRows = await ctx.db
        .query("canvasOwners")
        .withIndex("by_canvasId", (q) => q.eq("canvasId", canvas._id))
        .collect();
      for (const ownerRow of ownerRows) {
        await ctx.db.delete(ownerRow._id);
      }
      await ctx.db.delete(canvas._id);
      stats.deletedCanvases += 1;
    }
  }

  return { isComplete: true };
}

/*
  Sweep one unclaimed session's LIBRARY once it owns nothing: the brand kit,
  the asset registry (and the storage files those rows own), saved sections,
  and persona copies.

  These four tables are keyed to an OWNER, not to a document, so the
  per-document cascade above can never reach them — the schema notes on
  `brandKits` and `assets` used to say as much and promise a later pass. This
  is that pass, scoped to sessions the cron has just finished emptying, which
  is the only point at which "owns nothing" is cheap to establish.

  THREE GATES, all of which must hold, because deleting a live person's brand
  kit is a worse outcome than keeping a dead one:

    1. The caller has already proven the owner is unclaimed
       (classifyDocumentOwner). Nothing here re-derives that.
    2. The owner owns no canvas and no document, under EITHER of the two keys
       a session goes by. A signed-in anonymous visitor's canvases are keyed to
       their browser UUID while their dashboard rows and their library are
       keyed to the Better Auth user id, so a single-key liveness probe would
       cheerfully delete the library of somebody whose drafts are all still
       there.
    3. Every row in every one of the four tables is older than the retention
       cutoff. ALL-OR-NOTHING, deliberately: a session with one fresh row is a
       session somebody is using — they may simply have deleted their last
       draft — and sweeping the stale half of their library would be both
       destructive and invisible. It also removes any question about a brand
       kit whose logo is owned by an asset row that is younger than the kit.

  ORDER: kit first, then the registry. The registry is the system of record for
  storage-file ownership (model/assets.ts), so the kit row — a mere REFERRER to
  a confirmed logo/social binary — goes before the row that owns it. Both
  storage deletes are best-effort for the same reason brandKits.ts makes them
  best-effort: a confirmed kit asset is normally registered too, so the same
  file is reached twice in one pass and the second delete is a no-op. The
  "retain if registered" rule that guards a LIVE kit
  (brandKits.deleteStorageFilesUnlessRegistered) deliberately does not travel
  here: the registry row that could own the file belongs to this same dead
  session and is deleted a few lines below, so retaining would orphan the file
  rather than protect it.
*/
export async function sweepDeadSessionRows({
  ctx,
  ownerKey,
  cutoffMs,
  budget,
  stats,
}: {
  ctx: MutationCtx;
  ownerKey: string;
  /*
    Rows must all pre-date this to be swept (the run's retention cutoff).
  */
  cutoffMs: number;
  budget: DeletionBudget;
  stats: CleanupStats;
}): Promise<void> {
  if (ownerKey.length === 0) {
    /*
      `resolveOwnerIdOrNull` passes the empty string through verbatim for a
      caller with no mirrored session cookie, so it pools strangers together
      (convex/authIdentity.ts). It names nobody and must never key a delete.
    */
    return;
  }

  const isOwningAnyCanvas =
    (await ctx.db
      .query("canvases")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", ownerKey))
      .first()) !== null ||
    (await ctx.db
      .query("canvasOwners")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerKey))
      .first()) !== null;
  const isOwningAnyDocument =
    (await ctx.db
      .query("documents")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", ownerKey))
      .first()) !== null;
  if (isOwningAnyCanvas || isOwningAnyDocument) {
    return;
  }

  const brandKitRows = await ctx.db
    .query("brandKits")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", ownerKey))
    .take(MAX_SESSION_ROWS_SWEPT + 1);
  const assetRows = await ctx.db
    .query("assets")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", ownerKey))
    .take(MAX_SESSION_ROWS_SWEPT + 1);
  const savedSectionRows = await ctx.db
    .query("savedSections")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", ownerKey))
    .take(MAX_SESSION_ROWS_SWEPT + 1);
  /*
    Persona COPIES only. Built-in registry rows carry no createdBySessionId,
    so the index cannot reach them and a session sweep can never delete the
    personas every other session picks from.
  */
  const personaCopyRows = await ctx.db
    .query("agents")
    .withIndex("by_createdBySessionId", (q) => q.eq("createdBySessionId", ownerKey))
    .take(MAX_SESSION_ROWS_SWEPT + 1);

  const allRows = [...brandKitRows, ...assetRows, ...savedSectionRows, ...personaCopyRows];
  if (allRows.length === 0) {
    return;
  }
  /*
    Gate 3: one fresh row anywhere and the whole session is left alone. Cheap,
    and checked before the bound below so a live session never produces a
    "retained" warning about work nobody was going to touch.
  */
  const hasFreshRow = allRows.some((row) => row.updatedAtMs >= cutoffMs);
  if (hasFreshRow) {
    return;
  }

  /*
    Storage files count against the budget exactly as the cascade counts them.
  */
  const kitStorageIds = brandKitRows.flatMap((row) => collectRowStorageIds(row));
  const plannedDeletionCount = allRows.length + kitStorageIds.length + assetRows.length;
  const isOverBound = [brandKitRows, assetRows, savedSectionRows, personaCopyRows].some(
    (rows) => rows.length > MAX_SESSION_ROWS_SWEPT,
  );
  if (isOverBound || plannedDeletionCount > budget.remaining) {
    /*
      Retained, not partially deleted. The sweep is triggered by a document
      that no longer exists, so a half-finished session would never be
      revisited — declining wholesale is the only choice that leaves the data
      consistent and re-sweepable by a future dead-session pass.
    */
    console.warn(
      `cleanup: session library for owner key ending ` +
        `…${ownerKey.slice(-6)} needs ${plannedDeletionCount} deletions but the ` +
        `run has ${budget.remaining} left (per-table bound ` +
        `${MAX_SESSION_ROWS_SWEPT}); rows retained.`,
    );
    return;
  }

  for (const row of brandKitRows) {
    for (const storageId of collectRowStorageIds(row)) {
      await ctx.storage.delete(storageId as Id<"_storage">).catch(() => undefined);
      stats.deletedStorageFiles += 1;
      budget.remaining -= 1;
    }
    await ctx.db.delete(row._id);
    stats.deletedBrandKits += 1;
    budget.remaining -= 1;
  }

  for (const row of assetRows) {
    await ctx.storage.delete(row.storageId).catch(() => undefined);
    stats.deletedStorageFiles += 1;
    budget.remaining -= 1;
    await ctx.db.delete(row._id);
    stats.deletedAssets += 1;
    budget.remaining -= 1;
  }

  for (const row of savedSectionRows) {
    await ctx.db.delete(row._id);
    stats.deletedSavedSections += 1;
    budget.remaining -= 1;
  }

  for (const row of personaCopyRows) {
    await ctx.db.delete(row._id);
    stats.deletedPersonaCopies += 1;
    budget.remaining -= 1;
  }
}

/*
  Delete the Convex storage files behind `urls` that no OTHER document's
  block rows reference.

  Serving URLs do NOT embed the storage id — verified against real dev data:
  `_storage` id "kg21nnqt…" serves at ".../api/storage/63604288-1e43-…"
  (an internal UUID). Parsing is therefore impossible; instead we reverse-map
  by scanning `_storage` (bounded) and comparing each file's stable
  `ctx.storage.getUrl` output against the candidate URLs. Anything that
  cannot be resolved is RETAINED, never guess-deleted.

  Known accepted gap: references living only in a surviving document's
  HISTORY (op inverses / version snapshots, e.g. a fork that later removed a
  shared image) are not scanned — undo/restore of such an image would 404.
  Head block rows of every surviving document ARE checked, via by_imageSrc.
*/
async function deleteUnreferencedStorageFiles({
  ctx,
  urls,
  excludeDocumentId,
  budget,
  stats,
}: {
  ctx: MutationCtx;
  urls: Set<string>;
  excludeDocumentId: Id<"documents">;
  budget: DeletionBudget;
  stats: CleanupStats;
}): Promise<{ isComplete: boolean }> {
  /*
    Only URLs served by THIS deployment's file storage are candidates
    (sample docs use placehold.co etc.; foreign URLs are not ours to delete).
  */
  const storageUrlPrefix = `${process.env.CONVEX_CLOUD_URL}/api/storage/`;
  const prefixedUrls = [...urls].filter((url) => url.startsWith(storageUrlPrefix));
  if (prefixedUrls.length === 0) {
    return { isComplete: true };
  }

  /*
    Content Studio retain rule (docs/proposals/content-studio.md §6.1):
    REGISTERED assets are owned by the session's library, not by documents —
    "the image I uploaded yesterday" must survive the draft it was used in.
    One indexed assets.by_url point lookup per candidate; registered files
    are retained unconditionally. Unregistered legacy files keep the
    reference-counted cascade behavior below until the backfill (Stage M)
    registers them.
  */
  const candidateUrls: string[] = [];
  for (const url of prefixedUrls) {
    if (!(await isUrlRegisteredAsset(ctx, url))) {
      candidateUrls.push(url);
    }
  }
  if (candidateUrls.length === 0) {
    return { isComplete: true };
  }

  /*
    Keep any file still referenced at head by a different document (forks
    copy block rows verbatim, so cross-document sharing is real). The stale
    document's own rows still exist at this point, so exclude them by id.
    One bounded whole-table read (see MAX_BLOCK_ROWS_SCANNED for why no
    index is possible); over the bound every candidate is retained.
  */
  const allBlockRows = await ctx.db.query("blocks").take(MAX_BLOCK_ROWS_SCANNED + 1);
  if (allBlockRows.length > MAX_BLOCK_ROWS_SCANNED) {
    console.warn(
      `cleanup: blocks table exceeds ${MAX_BLOCK_ROWS_SCANNED} rows; ` +
        `storage-file reference check skipped — files retained for document ${excludeDocumentId}.`,
    );
    return { isComplete: true };
  }
  const foreignSrcUrls = new Set<string>();
  for (const row of allBlockRows) {
    if (
      row.documentId !== excludeDocumentId &&
      row.type === "image" &&
      typeof row.properties.src === "string"
    ) {
      foreignSrcUrls.add(row.properties.src);
    }
  }
  const unreferencedUrls = candidateUrls.filter((url) => !foreignSrcUrls.has(url));
  if (unreferencedUrls.length === 0) {
    return { isComplete: true };
  }

  const storageIdsByUrl = await resolveStorageIdsByUrl({ ctx, urls: unreferencedUrls });
  for (const url of unreferencedUrls) {
    const storageId = storageIdsByUrl.get(url);
    if (storageId === undefined) {
      /*
        Already deleted by an earlier partial run, or unresolvable (scan
        bound exceeded) — retain rather than guess.
      */
      continue;
    }
    if (budget.remaining <= 0) {
      return { isComplete: false };
    }
    await ctx.storage.delete(storageId);
    stats.deletedStorageFiles += 1;
    budget.remaining -= 1;
  }
  return { isComplete: true };
}

/*
  Reverse-map serving URLs to `_storage` ids via a bounded table scan.
*/
async function resolveStorageIdsByUrl({
  ctx,
  urls,
}: {
  ctx: MutationCtx;
  urls: string[];
}): Promise<Map<string, Id<"_storage">>> {
  const wantedUrls = new Set(urls);
  const storageIdsByUrl = new Map<string, Id<"_storage">>();
  const files = await ctx.db.system.query("_storage").take(MAX_STORAGE_FILES_SCANNED + 1);
  const hasScannedAllFiles = files.length <= MAX_STORAGE_FILES_SCANNED;
  if (!hasScannedAllFiles) {
    console.warn(
      `cleanup: _storage holds more than ${MAX_STORAGE_FILES_SCANNED} files; ` +
        `URL→id resolution is partial and unresolved files will be retained.`,
    );
  }
  for (const file of files.slice(0, MAX_STORAGE_FILES_SCANNED)) {
    if (storageIdsByUrl.size === wantedUrls.size) {
      break;
    }
    const servingUrl = await ctx.storage.getUrl(file._id);
    if (servingUrl !== null && wantedUrls.has(servingUrl)) {
      storageIdsByUrl.set(servingUrl, file._id);
    }
  }
  return storageIdsByUrl;
}
