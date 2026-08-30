// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { register as registerBetterAuth } from "@convex-dev/better-auth/test";
import { components, internal } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import schema from "@convex/schema";

/*
  THE DATA-LOSS TESTS for the cleanup cron (convex/cleanup.ts,
  convex/model/cleanup.ts).

  The bug these encode: the cron was written when Flock had no auth, so its
  header asserted that "every session is unclaimed" and there was no ownership
  test at all — a document was stale purely by inactivity. Better Auth shipped
  two weeks before this file existed, which meant anyone who signed up and then
  went quiet for thirty days had their canvases and drafts cascade-deleted by a
  cron that believed accounts could not exist.

  WHAT MAKES THESE LOAD-BEARING is that the ownership signal is indirect and
  easy to "simplify" back into the bug. The cron has no caller identity, and
  `documents.sessionId` is the CLIENT's localStorage UUID — signing in never
  changes it (convex/authIdentity.ts, closing note). The only column that links
  a canvas to an account is the server-resolved `canvasOwners.ownerId`, and the
  only thing that says whether that account was claimed is `user.isAnonymous`
  inside the Better Auth component. Each block below pins one branch of that
  chain, including the awkward one: a user who claimed an account leaves an
  ownership row pointing at the anonymous user Better Auth has since DELETED,
  so "identity-backed key, no user row" has to read as claimed.

  NOTE: convex-test's documented `!(*.*.*)` extglob matches nothing under
  vitest 4 (tinyglobby has no extglob support) — the array form with negative
  patterns is the equivalent that works.
*/
const modules = import.meta.glob([
  "../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/*
  Comfortably past the 30-day retention cutoff.
*/
const LONG_IDLE_MS = 60 * MS_PER_DAY;

/*
  A pre-auth browser's localStorage UUID — what `documents.sessionId` holds.
*/
const BROWSER_SESSION_ID = "4c1f8a02-9b3d-4e5f-8a71-2d3c4b5a6978";

/*
  The cron reads the Better Auth user table to decide who is claimed, so the
  component has to be registered or every run dies with "Component betterAuth
  is not registered" — a harness gap, not a cleanup failure. Mirrors
  lib/auth/credit-balance.test.ts.
*/
function createBackend() {
  const backend = convexTest(schema, modules);
  registerBetterAuth(backend);
  return backend;
}

type Backend = ReturnType<typeof createBackend>;

/*
  A Better Auth user row, exactly as the anonymous / magic-link plugins leave one.
*/
async function createAuthUser(
  t: Backend,
  args: { email: string; isAnonymous: boolean },
): Promise<string> {
  const nowMs = Date.now();
  const user = await t.run(async (ctx) =>
    ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          email: args.email,
          emailVerified: !args.isAnonymous,
          name: args.email,
          isAnonymous: args.isAnonymous,
          createdAt: nowMs,
          updatedAt: nowMs,
        },
      },
    }),
  );
  return user._id;
}

/*
  What `onLinkAccount` leaves behind: the anonymous user is gone (better-auth's
  anonymous plugin calls `deleteUser` the moment the callback resolves) while
  every row keyed to its id remains. Returns the now-dangling id.
*/
async function createThenDeleteAuthUser(t: Backend, email: string): Promise<string> {
  const userId = await createAuthUser(t, { email, isAnonymous: true });
  await t.run(async (ctx) =>
    ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: { model: "user", where: [{ field: "_id", value: userId }] },
    }),
  );
  return userId;
}

/*
  One long-idle canvas + draft, plus the dashboard ownership row.

  `ownerId` is the SERVER-RESOLVED key (`identity.subject` when the creator was
  signed in, the browser's own id otherwise) and `sessionId` is always the
  browser's — the same split documents.createDocument writes. Omitting
  `ownerId` therefore models a pre-auth browser, where the two are equal.
*/
async function seedIdleCanvas(
  t: Backend,
  args: {
    sessionId?: string;
    ownerId?: string;
    idleMs?: number;
    /*
      Skip the dashboard row entirely, as every canvas predating it does.
    */
    hasOwnerRow?: boolean;
  },
): Promise<{ canvasId: Id<"canvases">; documentId: Id<"documents"> }> {
  const sessionId = args.sessionId ?? BROWSER_SESSION_ID;
  const timestampMs = Date.now() - (args.idleMs ?? LONG_IDLE_MS);
  return await t.run(async (ctx) => {
    const canvasId = await ctx.db.insert("canvases", {
      sessionId,
      createdAtMs: timestampMs,
      updatedAtMs: timestampMs,
    });
    const documentId = await ctx.db.insert("documents", {
      canvasId,
      sessionId,
      name: "Draft 1",
      orderIndex: 0,
      headVersion: 0,
      createdAtMs: timestampMs,
      updatedAtMs: timestampMs,
    });
    await ctx.db.insert("blocks", {
      documentId,
      blockId: "root",
      type: "root",
      parentId: null,
      childrenIds: [],
      properties: {},
    });
    if (args.hasOwnerRow !== false) {
      await ctx.db.insert("canvasOwners", {
        canvasId,
        ownerId: args.ownerId ?? sessionId,
        createdAtMs: timestampMs,
      });
    }
    return { canvasId, documentId };
  });
}

/*
  The four session-keyed library tables, all owned by `ownerKey`. Inserted
  directly rather than through the public mutations so the timestamps — the
  thing the all-or-nothing freshness gate reads — are controllable.
*/
async function seedSessionLibrary(
  t: Backend,
  args: { ownerKey: string; idleMs?: number },
): Promise<{ storageId: Id<"_storage"> }> {
  const timestampMs = Date.now() - (args.idleMs ?? LONG_IDLE_MS);
  return await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(
      new Blob([new Uint8Array([4, 2])], { type: "image/png" }),
    );
    await ctx.db.insert("brandKits", {
      sessionId: args.ownerKey,
      name: "Abandoned Co",
      fonts: { heading: "Georgia, serif", body: "Helvetica, sans-serif" },
      variations: [],
      createdAtMs: timestampMs,
      updatedAtMs: timestampMs,
    });
    await ctx.db.insert("assets", {
      sessionId: args.ownerKey,
      storageId,
      url: (await ctx.storage.getUrl(storageId)) ?? "",
      kind: "uploaded",
      name: "hero.png",
      createdAtMs: timestampMs,
      updatedAtMs: timestampMs,
    });
    await ctx.db.insert("savedSections", {
      sessionId: args.ownerKey,
      name: "Footer",
      blocks: [],
      blockCount: 0,
      createdAtMs: timestampMs,
      updatedAtMs: timestampMs,
    });
    await ctx.db.insert("agents", {
      slug: `user/${args.ownerKey}/tone-police`,
      name: "Tone Police",
      color: "#c026d3",
      capabilityMode: "advisory",
      personaMarkdown: "You are the Tone Police.",
      cooldownSeconds: 60,
      isBuiltIn: false,
      createdBySessionId: args.ownerKey,
      createdAtMs: timestampMs,
      updatedAtMs: timestampMs,
    });
    return { storageId };
  });
}

/*
  Row counts across every table the sweep can reach, for one owner key.
*/
async function countLibraryRows(t: Backend, ownerKey: string) {
  return await t.run(async (ctx) => {
    const brandKits = await ctx.db
      .query("brandKits")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", ownerKey))
      .collect();
    const assets = await ctx.db
      .query("assets")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", ownerKey))
      .collect();
    const savedSections = await ctx.db
      .query("savedSections")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", ownerKey))
      .collect();
    const personaCopies = await ctx.db
      .query("agents")
      .withIndex("by_createdBySessionId", (q) => q.eq("createdBySessionId", ownerKey))
      .collect();
    return {
      brandKits: brandKits.length,
      assets: assets.length,
      savedSections: savedSections.length,
      personaCopies: personaCopies.length,
    };
  });
}

async function runSweep(t: Backend) {
  return await t.mutation(internal.cleanup.cleanupStaleDocuments, {});
}

async function readDocument(t: Backend, documentId: Id<"documents">) {
  return await t.run(async (ctx) => ctx.db.get(documentId));
}

describe("claimed accounts are exempt from the stale sweep", () => {
  /*
    THE REGRESSION. A signed-up user's canvas, idle for two months. Before the
    fix this run deleted the canvas, the draft, its blocks and — via the
    session pass added alongside — would have taken the brand kit too.
  */
  it("keeps a claimed account's idle canvas, draft and library", async () => {
    const t = createBackend();
    const claimedUserId = await createAuthUser(t, {
      email: "signed-up@example.com",
      isAnonymous: false,
    });
    const { canvasId, documentId } = await seedIdleCanvas(t, { ownerId: claimedUserId });
    await seedSessionLibrary(t, { ownerKey: claimedUserId });

    const stats = await runSweep(t);

    expect(stats.deletedDocuments).toBe(0);
    expect(stats.exemptedClaimedDocuments).toBe(1);
    expect(await readDocument(t, documentId)).not.toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(canvasId))).not.toBeNull();
    expect(await countLibraryRows(t, claimedUserId)).toEqual({
      brandKits: 1,
      assets: 1,
      savedSections: 1,
      personaCopies: 1,
    });
  });

  /*
    THE HARD CASE, and the one a "simplification" would drop. An ownership row
    left pointing at the anonymous user that Better Auth deletes on link
    (`onLinkAccount` → `deleteUser`). `authMigration.migrateOwnedRows` re-keys
    `canvasOwners` now, so this is no longer the ordinary post-link shape — it
    is what a link that ran out of migration budget leaves behind (512 rows per
    table), plus every row written before that re-key existed. The account is
    claimed while its owner key resolves to nothing at all — and the
    only thing separating it from an abandoned pre-auth browser is that the key
    differs from the canvas's own `sessionId`, i.e. it came from a verified
    identity rather than the client's fallback.
  */
  it("keeps a canvas whose identity-backed owner key no longer resolves to a user", async () => {
    const t = createBackend();
    const linkedAwayUserId = await createThenDeleteAuthUser(t, "anon-then-claimed@example.com");
    const { documentId } = await seedIdleCanvas(t, { ownerId: linkedAwayUserId });

    const stats = await runSweep(t);

    expect(stats.exemptedClaimedDocuments).toBe(1);
    expect(await readDocument(t, documentId)).not.toBeNull();
  });

  /*
    The other adoption path: `authMigration.adoptLegacySessionData` re-keys the
    document column itself onto the durable user id. Seeded with NO ownership
    row — every canvas created before `canvasOwners` existed has none — so the
    document column is the only signal available here.
  */
  it("keeps a document whose own sessionId was re-keyed to a claimed account", async () => {
    const t = createBackend();
    const claimedUserId = await createAuthUser(t, {
      email: "adopted@example.com",
      isAnonymous: false,
    });
    const { documentId } = await seedIdleCanvas(t, {
      sessionId: claimedUserId,
      hasOwnerRow: false,
    });

    const stats = await runSweep(t);

    expect(stats.exemptedClaimedDocuments).toBe(1);
    expect(await readDocument(t, documentId)).not.toBeNull();
  });

  /*
    The exemption must not turn the cron into a no-op — the reason it exists is
    the abandoned demo data, and an ANONYMOUS session is exactly that: one
    click of setup, no email, nothing to come back to.
  */
  it("still sweeps an anonymous session's idle canvas", async () => {
    const t = createBackend();
    const anonymousUserId = await createAuthUser(t, {
      email: "anon@example.com",
      isAnonymous: true,
    });
    const { canvasId, documentId } = await seedIdleCanvas(t, { ownerId: anonymousUserId });

    const stats = await runSweep(t);

    expect(stats.deletedDocuments).toBe(1);
    expect(stats.exemptedClaimedDocuments).toBe(0);
    expect(await readDocument(t, documentId)).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(canvasId))).toBeNull();
  });

  /*
    A pre-auth browser: owner key equals the browser key, and names no user.
  */
  it("still sweeps a pre-auth session's idle canvas", async () => {
    const t = createBackend();
    const { documentId } = await seedIdleCanvas(t, {});

    const stats = await runSweep(t);

    expect(stats.deletedDocuments).toBe(1);
    expect(await readDocument(t, documentId)).toBeNull();
  });

  /*
    The deliberate carve-out. `documents.deleteDocument` finishes a
    budget-exhausted cascade by scheduling a TARGETED run, so applying the
    ownership exemption there would strand half-deleted documents forever for
    exactly the users the exemption is meant to protect.
  */
  it("finishes a targeted run for a claimed account, because a human asked", async () => {
    const t = createBackend();
    const claimedUserId = await createAuthUser(t, {
      email: "deleting@example.com",
      isAnonymous: false,
    });
    const { documentId } = await seedIdleCanvas(t, { ownerId: claimedUserId });

    const stats = await t.mutation(internal.cleanup.cleanupStaleDocuments, {
      retentionDays: 0,
      onlyDocumentId: documentId,
    });

    expect(stats.deletedDocuments).toBe(1);
    expect(await readDocument(t, documentId)).toBeNull();
  });
});

describe("the session-keyed library is swept once a session owns nothing", () => {
  /*
    These four tables are keyed to an owner, not to a document, so nothing in
    the per-document cascade could ever reach them: an abandoned session's
    brand kit, asset rows, saved sections and persona copies used to outlive
    every draft they belonged to, forever, along with the storage files the
    asset rows own.
  */
  it("deletes the brand kit, assets, saved sections and persona copies", async () => {
    const t = createBackend();
    const { storageId } = await seedSessionLibrary(t, { ownerKey: BROWSER_SESSION_ID });
    await seedIdleCanvas(t, {});

    const stats = await runSweep(t);

    expect(stats).toMatchObject({
      deletedDocuments: 1,
      deletedBrandKits: 1,
      deletedAssets: 1,
      deletedSavedSections: 1,
      deletedPersonaCopies: 1,
    });
    expect(await countLibraryRows(t, BROWSER_SESSION_ID)).toEqual({
      brandKits: 0,
      assets: 0,
      savedSections: 0,
      personaCopies: 0,
    });
    /*
      The registry OWNS its storage files — deleting the row without the file
      would leave a binary nothing can ever reach or bill for.
    */
    expect(await t.run(async (ctx) => ctx.db.system.get(storageId))).toBeNull();
  });

  /*
    Built-ins carry no owner key, so no session sweep can reach the shared registry.
  */
  it("leaves built-in personas alone", async () => {
    const t = createBackend();
    await t.run(async (ctx) => {
      const nowMs = Date.now();
      await ctx.db.insert("agents", {
        slug: "builtin/tone-police",
        name: "Tone Police",
        color: "#c026d3",
        capabilityMode: "advisory",
        personaMarkdown: "You are the Tone Police.",
        cooldownSeconds: 60,
        isBuiltIn: true,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    });
    await seedIdleCanvas(t, {});

    const stats = await runSweep(t);

    expect(stats.deletedPersonaCopies).toBe(0);
    const builtIns = await t.run(async (ctx) => ctx.db.query("agents").collect());
    expect(builtIns.map((row) => row.slug)).toEqual(["builtin/tone-police"]);
  });

  /*
    The liveness gate, and the reason it has to probe BOTH keys. A signed-in
    anonymous visitor's canvases are keyed to their browser UUID while their
    library is keyed to the Better Auth user id, so a single-key probe would
    declare the session dead and delete the library of somebody whose other
    drafts are all still sitting there.
  */
  it("keeps the library while the session still owns another canvas", async () => {
    const t = createBackend();
    const anonymousUserId = await createAuthUser(t, {
      email: "busy-anon@example.com",
      isAnonymous: true,
    });
    await seedSessionLibrary(t, { ownerKey: anonymousUserId });
    const swept = await seedIdleCanvas(t, { ownerId: anonymousUserId });
    /*
      A second canvas the same identity owns, still being worked on.
    */
    await seedIdleCanvas(t, { ownerId: anonymousUserId, idleMs: 0 });

    const stats = await runSweep(t);

    expect(stats.deletedDocuments).toBe(1);
    expect(await readDocument(t, swept.documentId)).toBeNull();
    expect(await countLibraryRows(t, anonymousUserId)).toEqual({
      brandKits: 1,
      assets: 1,
      savedSections: 1,
      personaCopies: 1,
    });
  });

  /*
    All-or-nothing. One fresh row means somebody is using this session — they
    may simply have deleted their last draft — and sweeping the stale half of
    their library would be both destructive and invisible.
  */
  it("keeps the whole library when any row is newer than the cutoff", async () => {
    const t = createBackend();
    await seedSessionLibrary(t, { ownerKey: BROWSER_SESSION_ID });
    await t.run(async (ctx) => {
      const kit = await ctx.db
        .query("brandKits")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", BROWSER_SESSION_ID))
        .first();
      await ctx.db.patch(kit!._id, { updatedAtMs: Date.now() });
    });
    await seedIdleCanvas(t, {});

    const stats = await runSweep(t);

    expect(stats.deletedDocuments).toBe(1);
    expect(stats.deletedBrandKits).toBe(0);
    expect(await countLibraryRows(t, BROWSER_SESSION_ID)).toEqual({
      brandKits: 1,
      assets: 1,
      savedSections: 1,
      personaCopies: 1,
    });
  });
});
