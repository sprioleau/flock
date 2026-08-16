// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, internal } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import schema from "@convex/schema";

/*
  THE CLAIM TESTS for convex/authMigration.ts — "add your email and a one-tap
  sign-in link claims everything you already made" (README), verified rather
  than asserted.

  The bug these encode: `migrateOwnedRows` moved the brand kit, the assets, the
  saved sections and the persona copies, and did NOT move `canvasOwners`. That
  table is the only column tying a canvas to an account (convex/canvases.ts),
  so the moment a user claimed their account their entire dashboard went empty
  — the exact opposite of what the affordance promises, and silent, because
  every shared link still worked and the drafts were all still there.

  WHAT MAKES THESE LOAD-BEARING is that the two keys look interchangeable and
  are not:

    `canvases.sessionId` / `documents.sessionId` hold the browser's
    localStorage UUID and NEVER change on sign-in — documents and canvases are
    deliberately exempt from identity resolution because the doc URL is the
    capability (convex/authIdentity.ts, closing note).

    `canvasOwners.ownerId` holds the SERVER-RESOLVED key: the Better Auth user
    id when the creator had an identity.

  `onLinkAccount` hands the migration the ANONYMOUS USER ID, which can only
  ever match the second kind. So the last two blocks below pin the other half
  of the shape: the link must not touch the capability columns, and the
  operator adoption path — which is handed a localStorage UUID instead — must
  still re-key them, because it is the only caller for which those branches
  can fire at all.

  NOTE: convex-test's documented `!(*.*.*)` extglob matches nothing under
  vitest 4 (tinyglobby has no extglob support) — the array form with negative
  patterns is the equivalent that works.
*/
const modules = import.meta.glob([
  "../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

/*
  The throwaway identity Better Auth mints on first touch, and deletes on link.
*/
const ANONYMOUS_USER_ID = "user_anonymous_first_touch";

/*
  The durable identity the magic link mints.
*/
const CLAIMED_USER_ID = "user_claimed_by_email";

/*
  The browser's localStorage UUID — what the capability columns hold, always.
*/
const BROWSER_SESSION_ID = "6b2d9e14-7c3a-4f58-9d10-2e5b8a7c4f31";

const STRICT_FLAG = "FLOCK_REQUIRE_AUTH_IDENTITY";

const originalStrictFlag = process.env[STRICT_FLAG];

beforeEach(() => {
  /*
    The deployment's real posture once auth is on: no client-supplied ownership
    key is accepted, so every owner id in these tests came from a verified
    identity. A pre-auth fallback would blur the two keys this file exists to
    keep apart.
  */
  process.env[STRICT_FLAG] = "true";
});

afterEach(() => {
  if (originalStrictFlag === undefined) {
    delete process.env[STRICT_FLAG];
  } else {
    process.env[STRICT_FLAG] = originalStrictFlag;
  }
});

/*
  Derived from createBackend, NOT from `typeof convexTest` — the bare
  ReturnType drops the schema generic, so ctx.db falls back to the system
  tables and every withIndex call in this file stops typechecking. Same
  ordering as cleanup-sweep.test.ts for the same reason.
*/
function createBackend() {
  return convexTest(schema, modules);
}

type Backend = ReturnType<typeof createBackend>;

/*
  A canvas made the way a first-touch visitor makes one: signed in
  ANONYMOUSLY (so the ownership row is keyed to the anonymous user id) while
  the canvas and draft rows carry the browser's UUID.
*/
async function createCanvasAsAnonymousUser(
  t: Backend,
  args: { canvasTitle: string },
): Promise<{ canvasId: Id<"canvases">; documentId: Id<"documents"> }> {
  return await t
    .withIdentity({ subject: ANONYMOUS_USER_ID })
    .mutation(api.documents.createDocument, {
      sessionId: BROWSER_SESSION_ID,
      canvasTitle: args.canvasTitle,
      name: "Draft 1",
    });
}

/*
  What `onLinkAccount` runs, with the ids Better Auth hands it.
*/
async function linkAccount(t: Backend) {
  return await t.mutation(internal.authMigration.reKeyOwnedRows, {
    fromOwnerId: ANONYMOUS_USER_ID,
    toOwnerId: CLAIMED_USER_ID,
  });
}

async function listDashboard(t: Backend, ownerId: string) {
  return await t
    .withIdentity({ subject: ownerId })
    .query(api.canvases.listMyCanvases, { sessionId: BROWSER_SESSION_ID });
}

async function readOwnerRows(t: Backend, canvasId: Id<"canvases">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("canvasOwners")
      .withIndex("by_canvasId", (q) => q.eq("canvasId", canvasId))
      .collect(),
  );
}

describe("claiming an account carries the dashboard with it", () => {
  /*
    THE REGRESSION. One canvas, made anonymously, then claimed by email.
    Before the fix this list came back EMPTY — the user's work was intact and
    invisible.
  */
  it("still lists the canvas under the claimed identity", async () => {
    const t = createBackend();
    await createCanvasAsAnonymousUser(t, { canvasTitle: "Launch announcement" });

    const result = await linkAccount(t);

    expect(result.canvasOwners).toBe(1);
    const claimedList = await listDashboard(t, CLAIMED_USER_ID);
    expect(claimedList.map((entry) => entry.title)).toEqual(["Launch announcement"]);
  });

  /*
    The other side of a MOVE: the anonymous key must stop naming the canvas.
    Better Auth deletes that user row moments later, so a row left behind is
    not a harmless duplicate — it is a canvas keyed to nobody.
  */
  it("stops listing it under the discarded anonymous identity", async () => {
    const t = createBackend();
    await createCanvasAsAnonymousUser(t, { canvasTitle: "Launch announcement" });

    await linkAccount(t);

    expect(await listDashboard(t, ANONYMOUS_USER_ID)).toEqual([]);
  });

  /*
    Listing is not the only thing keyed off `canvasOwners`: rename and delete
    assert ownership through it (`assertCanvasOwner`). A user who claimed their
    account and could see a canvas but not rename it would be a second, subtler
    version of the same bug, so this pins the management path independently.
  */
  it("lets the claimed identity rename what it made anonymously", async () => {
    const t = createBackend();
    const { canvasId } = await createCanvasAsAnonymousUser(t, {
      canvasTitle: "Launch announcement",
    });

    await linkAccount(t);

    await expect(
      t.withIdentity({ subject: CLAIMED_USER_ID }).mutation(api.canvases.renameCanvas, {
        canvasId,
        title: "Spring launch",
        sessionId: BROWSER_SESSION_ID,
      }),
    ).resolves.toBe(true);
  });

  /*
    A link that half-ran and is retried, or a promoted draft that inherited
    both keys (`inheritCanvasOwners`), leaves the destination already owning
    the canvas. `listMyCanvases` iterates ownership rows directly, so a
    duplicated pair is a duplicated card — the migration has to preserve the
    one-row-per-(owner, canvas) invariant `recordCanvasOwner` maintains, by
    dropping the source row rather than adding a second destination row.
  */
  it("leaves exactly one ownership row when the destination already owns it", async () => {
    const t = createBackend();
    const { canvasId } = await createCanvasAsAnonymousUser(t, {
      canvasTitle: "Launch announcement",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("canvasOwners", {
        canvasId,
        ownerId: CLAIMED_USER_ID,
        createdAtMs: Date.now(),
      });
    });

    await linkAccount(t);

    const ownerRows = await readOwnerRows(t, canvasId);
    expect(ownerRows.map((row) => row.ownerId)).toEqual([CLAIMED_USER_ID]);
    expect((await listDashboard(t, CLAIMED_USER_ID)).length).toBe(1);
  });

  /*
    `comments.sessionId` is server-resolved too (convex/comments.ts), so on the
    link path it really does hold the anonymous user id. The migration used to
    source its comment set from documents found by the owner key — a set that
    is always empty on this path — so the "comment authorship is moved" claim
    in the module header was true only for the operator caller. Author ids are
    never returned to a reader, so the row is read directly.
  */
  it("re-attributes the user's own comment threads", async () => {
    const t = createBackend();
    const { documentId } = await createCanvasAsAnonymousUser(t, {
      canvasTitle: "Launch announcement",
    });
    const commentId = await t
      .withIdentity({ subject: ANONYMOUS_USER_ID })
      .mutation(api.comments.createComment, {
        documentId,
        sessionId: BROWSER_SESSION_ID,
        authorName: "Sam",
        anchor: { blockId: null, x: 12, y: 34 },
        context: { breadcrumb: "Hero" },
        text: "Tighten this headline.",
      });

    await linkAccount(t);

    const comment = await t.run(async (ctx) => ctx.db.get(commentId));
    expect(comment?.sessionId).toBe(CLAIMED_USER_ID);
    expect(comment?.thread.map((entry) => entry.authorSessionId)).toEqual([CLAIMED_USER_ID]);
  });
});

describe("the link never touches the capability columns", () => {
  /*
    `canvases.sessionId` and `documents.sessionId` are the browser's UUID by
    design: the id in the URL is the capability, and share-by-link with no
    account is the product. Re-keying them onto a user id here would be the
    tempting "fix" for the two branches that cannot fire on this path, and it
    would quietly change what those columns mean for the cleanup cron, which
    reads `ownerId !== canvas.sessionId` as "this key came from an identity"
    (convex/model/cleanup.ts, check 3).
  */
  it("leaves the canvas and document session ids on the browser key", async () => {
    const t = createBackend();
    const { canvasId, documentId } = await createCanvasAsAnonymousUser(t, {
      canvasTitle: "Launch announcement",
    });

    const result = await linkAccount(t);

    expect(result.canvases).toBe(0);
    expect(result.documents).toBe(0);
    const rows = await t.run(async (ctx) => ({
      canvas: await ctx.db.get(canvasId),
      document: await ctx.db.get(documentId),
    }));
    expect(rows.canvas?.sessionId).toBe(BROWSER_SESSION_ID);
    expect(rows.document?.sessionId).toBe(BROWSER_SESSION_ID);
  });
});

describe("operator adoption still re-keys a pre-auth browser's rows", () => {
  /*
    The reason the canvases/documents branches are KEPT rather than deleted.
    This caller is handed the localStorage UUID, so for it those branches are
    the entire point — and check 1 of `classifyDocumentOwner` depends on the
    document column having been re-keyed, which is what stops the cleanup cron
    sweeping an adopted pre-auth canvas. Delete the branches and this fails.
  */
  it("moves the canvas, the draft and the dashboard row onto the durable id", async () => {
    const t = createBackend();
    /*
      A browser from before auth shipped: no identity anywhere, so the owner
      row is keyed to the same UUID the canvas and document rows carry.
    */
    const { canvasId, documentId } = await t.run(async (ctx) => {
      const nowMs = Date.now();
      const insertedCanvasId = await ctx.db.insert("canvases", {
        sessionId: BROWSER_SESSION_ID,
        title: "Pre-auth newsletter",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
      const insertedDocumentId = await ctx.db.insert("documents", {
        canvasId: insertedCanvasId,
        sessionId: BROWSER_SESSION_ID,
        name: "Draft 1",
        orderIndex: 0,
        headVersion: 0,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
      await ctx.db.insert("canvasOwners", {
        canvasId: insertedCanvasId,
        ownerId: BROWSER_SESSION_ID,
        createdAtMs: nowMs,
      });
      return { canvasId: insertedCanvasId, documentId: insertedDocumentId };
    });

    const result = await t.mutation(internal.authMigration.adoptLegacySessionData, {
      legacySessionId: BROWSER_SESSION_ID,
      ownerId: CLAIMED_USER_ID,
    });

    expect(result).toMatchObject({ canvases: 1, documents: 1, canvasOwners: 1 });
    const rows = await t.run(async (ctx) => ({
      canvas: await ctx.db.get(canvasId),
      document: await ctx.db.get(documentId),
    }));
    expect(rows.canvas?.sessionId).toBe(CLAIMED_USER_ID);
    expect(rows.document?.sessionId).toBe(CLAIMED_USER_ID);
    expect((await readOwnerRows(t, canvasId)).map((row) => row.ownerId)).toEqual([
      CLAIMED_USER_ID,
    ]);
  });
});
