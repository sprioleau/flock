// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { register as registerProsemirrorSync } from "@convex-dev/prosemirror-sync/test";
import { api, internal } from "@convex/_generated/api";
import schema from "@convex/schema";

/*
  THE OWNERSHIP TESTS for the dashboard (convex/canvases.ts).

  Two things have to stay true at once, and they pull in opposite directions:

    1. A user must never see, rename or delete another user's emails. The
       dashboard is keyed off a SERVER-RESOLVED identity, so quoting someone
       else's session id — which the presence roster publishes to every
       collaborator (see apps/web/src/lib/auth/owner-identity.test.ts) — must
       buy nothing at all.

    2. SHARE-BY-LINK MUST STILL WORK FOR STRANGERS. `canvases` and `documents`
       are deliberately exempt from identity checks: the id in the URL is the
       capability and that is the product. A dashboard that quietly turned
       ownership into an access check would break every shared link, and the
       break would be invisible to whoever wrote it because they are signed
       in. The second describe block is that regression test.

  Mirrors the convex-test setup of owner-identity.test.ts, including the note
  about the array-form glob (the documented extglob matches nothing under
  vitest 4).
*/
const modules = import.meta.glob([
  "../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);


const OWNER_A = "user_owner_a";
const OWNER_B = "user_owner_b";
const STRICT_FLAG = "FLOCK_REQUIRE_AUTH_IDENTITY";

/*
  A pre-auth browser's localStorage UUID — the legacy fallback key.
*/
const LEGACY_SESSION_ID = "3f9a2b1c-4d5e-4f60-9a8b-7c6d5e4f3a2b";

/*
  Deleting a canvas cascades into every draft's synced text docs
  (convex/model/cleanup.ts -> textBlockSync.deleteBlockSyncDoc), which calls
  INTO the prosemirror-sync component. convex-test knows nothing about an
  installed component until it is registered, so without this the delete test
  fails with "Component prosemirrorSync is not registered" — a harness gap,
  not an ownership failure. This is the first test in the repo to reach that
  path, which is why no sibling test registers anything.

  The component ships its own registrar; do not hand-roll the schema+glob,
  since its internal layout is not a public export.
*/
function createBackend() {
  const backend = convexTest(schema, modules);
  registerProsemirrorSync(backend);
  return backend;
}

const originalStrictFlag = process.env[STRICT_FLAG];

beforeEach(() => {
  /*
    Every test here runs in the deployment's REAL posture: strict identity,
    exactly as Convex prod is configured. A pre-auth fallback would mask the
    very confusion these tests exist to catch.
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

describe("the dashboard lists only what you own", () => {
  it("gives each owner their own canvases and nobody else's", async () => {
    const t = createBackend();
    const ownerA = t.withIdentity({ subject: OWNER_A });
    const ownerB = t.withIdentity({ subject: OWNER_B });

    await ownerA.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      canvasTitle: "Owner A launch",
      name: "Draft 1",
    });
    await ownerB.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      canvasTitle: "Owner B newsletter",
      name: "Draft 1",
    });

    const listA = await ownerA.query(api.canvases.listMyCanvases, {
      sessionId: LEGACY_SESSION_ID,
    });
    const listB = await ownerB.query(api.canvases.listMyCanvases, {
      sessionId: LEGACY_SESSION_ID,
    });

    expect(listA.map((entry) => entry.title)).toEqual(["Owner A launch"]);
    expect(listB.map((entry) => entry.title)).toEqual(["Owner B newsletter"]);
  });

  /*
    THE ATTACK. Both users pass the SAME `sessionId` above — it is a scraped,
    published string, not a credential. If the listing ever keyed off the
    argument instead of the verified identity, each list would contain both
    canvases and the assertions above would fail. This makes the mechanism
    explicit rather than incidental.
  */
  it("ignores a session id quoted from someone else", async () => {
    const t = createBackend();
    const victim = t.withIdentity({ subject: OWNER_A });
    const attacker = t.withIdentity({ subject: OWNER_B });

    await victim.mutation(api.documents.createDocument, {
      sessionId: "victim-session-id",
      canvasTitle: "Victim's private campaign",
      name: "Draft 1",
    });

    /*
      The attacker replays the victim's session id verbatim.
    */
    const stolenList = await attacker.query(api.canvases.listMyCanvases, {
      sessionId: "victim-session-id",
    });
    expect(stolenList).toEqual([]);
  });

  it("returns an empty list, not an error, for a caller with no identity", async () => {
    const t = createBackend();
    await t
      .withIdentity({ subject: OWNER_A })
      .mutation(api.documents.createDocument, {
        sessionId: LEGACY_SESSION_ID,
        canvasTitle: "Owned",
        name: "Draft 1",
      });

    /*
      Strict mode: an anonymous caller cannot name an owner at all.
    */
    expect(await t.query(api.canvases.listMyCanvases, { sessionId: LEGACY_SESSION_ID })).toEqual(
      [],
    );
  });

  it("summarizes a canvas with its draft count and freshest activity", async () => {
    const t = createBackend();
    const owner = t.withIdentity({ subject: OWNER_A });

    const { canvasId } = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      canvasTitle: "Spring sale",
      name: "Bold version",
    });
    await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      canvasId,
      name: "Quiet version",
    });

    const [entry] = await owner.query(api.canvases.listMyCanvases, {
      sessionId: LEGACY_SESSION_ID,
    });
    expect(entry).toMatchObject({
      title: "Spring sale",
      isTitleDerived: false,
      draftCount: 2,
    });
    expect(entry!.draftPreviews.map((draft) => draft.name)).toEqual([
      "Bold version",
      "Quiet version",
    ]);
    expect(entry!.entryDocumentId).not.toBeNull();
  });

  it("returns every draft document for the dashboard thumbnail overview", async () => {
    const t = createBackend();
    const owner = t.withIdentity({ subject: OWNER_A });
    const first = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      canvasTitle: "Thumbnail test",
      name: "First visual",
    });
    await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      canvasId: first.canvasId,
      name: "Second visual",
    });

    const thumbnailDocuments = await owner.query(api.canvases.getCanvasThumbnailDocuments, {
      canvasId: first.canvasId,
      sessionId: LEGACY_SESSION_ID,
    });

    expect(thumbnailDocuments).toHaveLength(2);
    expect(thumbnailDocuments.map((document) => document.documentId)).toEqual([
      first.documentId,
      expect.any(String),
    ]);
    expect(thumbnailDocuments.map((document) => document.name)).toEqual([
      "First visual",
      "Second visual",
    ]);
    expect(thumbnailDocuments.every((document) => Object.keys(document.doc).length > 0)).toBe(true);
  });

  it("does not expose dashboard thumbnails to a different owner", async () => {
    const t = createBackend();
    const owner = t.withIdentity({ subject: OWNER_A });
    const stranger = t.withIdentity({ subject: OWNER_B });
    const created = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      canvasTitle: "Private dashboard thumbnail",
      name: "Owner draft",
    });

    await expect(
      stranger.query(api.canvases.getCanvasThumbnailDocuments, {
        canvasId: created.canvasId,
        sessionId: LEGACY_SESSION_ID,
      }),
    ).rejects.toThrow("isn't in your list");
  });

  it("derives a display name for a canvas nobody ever titled", async () => {
    const t = createBackend();
    const owner = t.withIdentity({ subject: OWNER_A });

    /*
      Bare creation, exactly as StudioShell does it: no canvasTitle at all.
    */
    await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      name: "Welcome email",
    });

    const [entry] = await owner.query(api.canvases.listMyCanvases, {
      sessionId: LEGACY_SESSION_ID,
    });
    expect(entry).toMatchObject({ title: "Welcome email", isTitleDerived: true });
  });
});

describe("renaming and deleting are owner-only", () => {
  it("lets the owner rename their own canvas", async () => {
    const t = createBackend();
    const owner = t.withIdentity({ subject: OWNER_A });
    const { canvasId } = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      name: "Draft 1",
    });

    await owner.mutation(api.canvases.renameCanvas, {
      canvasId,
      title: "Black Friday",
      sessionId: LEGACY_SESSION_ID,
    });

    const [entry] = await owner.query(api.canvases.listMyCanvases, {
      sessionId: LEGACY_SESSION_ID,
    });
    expect(entry).toMatchObject({ title: "Black Friday", isTitleDerived: false });
  });

  it("refuses a rename from someone who does not own the canvas", async () => {
    const t = createBackend();
    const owner = t.withIdentity({ subject: OWNER_A });
    const stranger = t.withIdentity({ subject: OWNER_B });
    const { canvasId } = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      canvasTitle: "Mine",
      name: "Draft 1",
    });

    await expect(
      stranger.mutation(api.canvases.renameCanvas, {
        canvasId,
        title: "Hijacked",
        sessionId: LEGACY_SESSION_ID,
      }),
    ).rejects.toThrow();

    const [entry] = await owner.query(api.canvases.listMyCanvases, {
      sessionId: LEGACY_SESSION_ID,
    });
    expect(entry!.title).toBe("Mine");
  });

  it("refuses a delete from someone who does not own the canvas", async () => {
    const t = createBackend();
    const owner = t.withIdentity({ subject: OWNER_A });
    const stranger = t.withIdentity({ subject: OWNER_B });
    const { canvasId, documentId } = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      name: "Draft 1",
    });

    await expect(
      stranger.mutation(api.canvases.deleteCanvas, {
        canvasId,
        sessionId: LEGACY_SESSION_ID,
      }),
    ).rejects.toThrow();

    /*
      The work is untouched — not merely un-listed.
    */
    expect(await t.query(api.documents.getDocument, { documentId })).not.toBeNull();
  });

  it("deletes the canvas and every draft on it for its owner", async () => {
    const t = createBackend();
    const owner = t.withIdentity({ subject: OWNER_A });
    const { canvasId, documentId } = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      name: "Draft 1",
    });
    const second = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      canvasId,
      name: "Draft 2",
    });

    const result = await owner.mutation(api.canvases.deleteCanvas, {
      canvasId,
      sessionId: LEGACY_SESSION_ID,
    });
    expect(result).toMatchObject({ isOk: true, deletedDraftCount: 2, isComplete: true });

    expect(await t.query(api.documents.getDocument, { documentId })).toBeNull();
    expect(
      await t.query(api.documents.getDocument, { documentId: second.documentId }),
    ).toBeNull();
    expect(await owner.query(api.canvases.listMyCanvases, { sessionId: LEGACY_SESSION_ID }))
      .toEqual([]);

    /*
      The ownership rows go with it — a dangling row would be immortal.
    */
    const strayOwnerRows = await t.run(async (ctx) =>
      ctx.db
        .query("canvasOwners")
        .withIndex("by_canvasId", (q) => q.eq("canvasId", canvasId))
        .collect(),
    );
    expect(strayOwnerRows).toEqual([]);
  });
});

/*
  The other half of the deal. Every assertion here would ALSO pass if
  ownership had been implemented as an access check — which is exactly why
  they are written from the stranger's side: each one is a thing a person with
  only a link must still be able to do.
*/
describe("share-by-link still works for people who own nothing", () => {
  it("lets a stranger with no identity read a canvas owner's draft", async () => {
    const t = createBackend();
    const owner = t.withIdentity({ subject: OWNER_A });
    const { documentId, canvasId } = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      name: "Draft 1",
    });

    /*
      `t` itself carries NO identity — the signed-out visitor holding a link.
    */
    expect(await t.query(api.documents.getDocument, { documentId })).not.toBeNull();
    expect(await t.query(api.documents.getDocumentByKey, { documentKey: documentId })).not.toBeNull();
    expect(await t.query(api.documents.canvasExists, { canvasKey: canvasId })).toBe(true);
    expect(await t.query(api.documents.getCanvasEntryDocument, { canvasKey: canvasId })).toBe(
      documentId,
    );
    expect(await t.query(api.documents.listDocumentsByCanvas, { canvasId })).toHaveLength(1);
  });

  it("lets a stranger with no identity EDIT the draft, and renames drafts", async () => {
    const t = createBackend();
    const owner = t.withIdentity({ subject: OWNER_A });
    const { documentId } = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      name: "Draft 1",
      shouldSeedEmpty: true,
    });

    const applied = await t.mutation(api.documents.applyOperations, {
      documentId,
      ops: [
        {
          name: "addBlock",
          block: {
            id: "sec_sh01",
            type: "section",
            parentId: "root",
            childrenIds: [],
            properties: {},
          },
          parentId: "root",
          index: 0,
        },
      ],
      context: { authorId: "a-stranger", author: "user", caller: "frontend" },
    });
    expect(applied).toMatchObject({ isOk: true });

    /*
      Draft-level renaming is CONTENT, not library management — a link-holder
      keeps it. Only the canvas (the dashboard entry) is owner-only.
    */
    expect(await t.mutation(api.documents.renameDocument, { documentId, name: "Their edit" })).toBe(
      true,
    );
  });

  it("keeps a link-created canvas out of every dashboard rather than in a stranger's", async () => {
    const t = createBackend();

    /*
      No identity at all, strict mode on: nothing can name an owner, so the
      canvas is created and fully usable but belongs to no list.
    */
    const { canvasId } = await t.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      name: "Draft 1",
    });

    expect(await t.query(api.documents.canvasExists, { canvasKey: canvasId })).toBe(true);
    const ownerRows = await t.run(async (ctx) => ctx.db.query("canvasOwners").collect());
    expect(ownerRows).toEqual([]);
  });
});

describe("promoting a draft keeps it in its owner's dashboard", () => {
  it("carries the source canvas's owner onto the new canvas", async () => {
    const t = createBackend();
    const owner = t.withIdentity({ subject: OWNER_A });
    const { canvasId } = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      canvasTitle: "Original",
      name: "Draft 1",
    });
    const second = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      canvasId,
      name: "Draft 2",
    });

    /*
      A STRANGER with only the link does the promotion.
    */
    const promoted = await t.mutation(api.documents.promoteDocumentToNewCanvas, {
      documentId: second.documentId,
    });
    expect(promoted).toMatchObject({ isOk: true });

    /*
      Both canvases are still the owner's — the draft did not fall out of
      their dashboard, and the stranger gained no library entry.
    */
    const list = await owner.query(api.canvases.listMyCanvases, {
      sessionId: LEGACY_SESSION_ID,
    });
    expect(list).toHaveLength(2);
    expect(list.map((entry) => entry.title).sort()).toEqual(["Draft 2", "Original"]);
  });
});

describe("operator backfill for canvases that predate the dashboard", () => {
  it("adopts legacy canvases by session id and is idempotent", async () => {
    const t = createBackend();

    /*
      A canvas with no owner row, exactly as every pre-dashboard canvas is.
    */
    const { canvasId } = await t.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      canvasTitle: "From before",
      name: "Draft 1",
    });
    expect(await t.run(async (ctx) => ctx.db.query("canvasOwners").collect())).toEqual([]);

    const first = await t.mutation(internal.canvases.adoptCanvasesBySessionId, {
      legacySessionId: LEGACY_SESSION_ID,
      ownerId: OWNER_A,
    });
    expect(first).toEqual({ adoptedCanvases: 1 });

    const second = await t.mutation(internal.canvases.adoptCanvasesBySessionId, {
      legacySessionId: LEGACY_SESSION_ID,
      ownerId: OWNER_A,
    });
    expect(second).toEqual({ adoptedCanvases: 0 });

    const list = await t
      .withIdentity({ subject: OWNER_A })
      .query(api.canvases.listMyCanvases, { sessionId: LEGACY_SESSION_ID });
    expect(list.map((entry) => entry.title)).toEqual(["From before"]);
    expect(list[0]!.canvasId).toBe(canvasId);
  });
});
