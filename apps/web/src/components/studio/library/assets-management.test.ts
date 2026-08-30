// @vitest-environment edge-runtime
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import schema from "@convex/schema";

/*
  Content Studio Stage M backend: assets.rename and assets.remove, run as the
  REAL Convex functions against convex-test's in-memory backend.

  Two properties are load-bearing here and everything else is detail:

  1. OWNERSHIP IS SERVER-RESOLVED. The `sessionId` argument is a claim, not a
     credential — the presence roster publishes every collaborator's session
     id to everyone in the room, so a mutation that authorized on the
     argument would let anyone in a shared canvas rename and DELETE the
     files in someone else's library. Both mutations resolve the caller
     through resolveOwnerId (convex/authIdentity.ts) and compare against the
     row's own key. Tested in both postures the deployment can be in: with a
     verified identity (the argument must be ignored outright) and in the
     pre-auth fallback (the claimed id is all there is, and it still has to
     match the row).
  2. A DELETE NEVER BREAKS A DRAFT. Deleting is refused while any head block
     row still renders the asset's URL, and the refusal names the caller's
     own drafts so it is actionable. See convex/assets.ts `remove` for the
     full argument behind blocking rather than soft-deleting.

  Mirrors the convex-test setup of assets-registry.test.ts, including the note
  about the array-form glob (the documented extglob matches nothing under
  vitest 4).
*/
const modules = import.meta.glob([
  "../../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

const OWNER = "user_owner";
const STRANGER = "user_stranger";
const SESSION_ID = "session-owner-1";
const STRICT_FLAG = "FLOCK_REQUIRE_AUTH_IDENTITY";

function createBackend() {
  return convexTest(schema, modules);
}

type Backend = ReturnType<typeof createBackend>;

async function storePngFile(t: Backend): Promise<Id<"_storage">> {
  return await t.run(async (ctx) => {
    return await ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
  });
}

/*
*/
async function seedDraftUsingImage(
  t: Backend,
  args: { sessionId: string; draftName: string; url: string },
): Promise<void> {
  await t.run(async (ctx) => {
    const nowMs = Date.now();
    const canvasId = await ctx.db.insert("canvases", {
      sessionId: args.sessionId,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    const documentId = await ctx.db.insert("documents", {
      canvasId,
      sessionId: args.sessionId,
      name: args.draftName,
      orderIndex: 0,
      headVersion: 0,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    await ctx.db.insert("blocks", {
      documentId,
      blockId: "img_0",
      type: "image",
      parentId: "sec_a",
      childrenIds: [],
      properties: { src: args.url, alt: "" },
    });
  });
}

describe("assets.rename", () => {
  it("renames the owner's asset and stamps updatedAtMs", async () => {
    const t = createBackend();
    const storageId = await storePngFile(t);
    const { assetId } = await t.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId,
      kind: "uploaded",
      name: "IMG_4821.png",
    });
    const registeredAt = await t.run(async (ctx) => (await ctx.db.get(assetId))?.updatedAtMs ?? 0);

    await t.mutation(api.assets.rename, {
      sessionId: SESSION_ID,
      assetId,
      name: "  Spring hero  ",
    });

    const row = await t.run(async (ctx) => ctx.db.get(assetId));
    expect(row?.name).toBe("Spring hero");
    expect(row?.updatedAtMs).toBeGreaterThanOrEqual(registeredAt);
  });

  /*
    Clearing the field must not leave an unlabelled card — and for a
    generated image the prompt is a better default than any filename, which
    is exactly what the agent reads when it picks imagery.
  */
  it("reseeds a blank name from the generation prompt", async () => {
    const t = createBackend();
    const storageId = await storePngFile(t);
    const { assetId } = await t.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId,
      kind: "generated",
      prompt: "golden retriever at the beach",
    });
    await t.mutation(api.assets.rename, { sessionId: SESSION_ID, assetId, name: "Doggo" });
    await t.mutation(api.assets.rename, { sessionId: SESSION_ID, assetId, name: "   " });

    const row = await t.run(async (ctx) => ctx.db.get(assetId));
    expect(row?.name).toBe("golden retriever at the beach");
  });

  it("refuses a caller who does not own the asset, and changes nothing", async () => {
    const t = createBackend();
    const storageId = await storePngFile(t);
    const { assetId } = await t.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId,
      kind: "uploaded",
      name: "hero.png",
    });

    await expect(
      t.mutation(api.assets.rename, {
        sessionId: "some-other-session",
        assetId,
        name: "mine now",
      }),
    ).rejects.toThrow(/different library/);

    const row = await t.run(async (ctx) => ctx.db.get(assetId));
    expect(row?.name).toBe("hero.png");
  });
});

describe("assets.remove", () => {
  it("deletes the row AND the storage file when nothing renders it", async () => {
    const t = createBackend();
    const storageId = await storePngFile(t);
    const { assetId } = await t.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId,
      kind: "uploaded",
      name: "unused.png",
    });

    const result = await t.mutation(api.assets.remove, { sessionId: SESSION_ID, assetId });
    expect(result).toEqual({ isOk: true });

    const [row, file] = await t.run(async (ctx) => [
      await ctx.db.get(assetId),
      await ctx.db.system.get(storageId),
    ]);
    expect(row).toBeNull();
    /*
      The library is the file's only owner (the document cascade recuses
      itself for registered files), so leaving the file would strand it.
    */
    expect(file).toBeNull();
  });

  /*
    THE POINT OF THE IN-USE CHECK. A draft rendering this URL would show a
    broken image the moment the file went away, in the canvas, in previews
    and in sent test emails — with no undo, because deleted bytes are not
    something the editor's undo stack can restore.
  */
  it("refuses while a draft still renders it, names that draft, and keeps the file", async () => {
    const t = createBackend();
    const storageId = await storePngFile(t);
    const { assetId, url } = await t.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId,
      kind: "uploaded",
      name: "hero.png",
    });
    await seedDraftUsingImage(t, { sessionId: SESSION_ID, draftName: "Spring sale", url });

    const result = await t.mutation(api.assets.remove, { sessionId: SESSION_ID, assetId });
    expect(result).toEqual({
      isOk: false,
      reason: "in_use",
      draftNames: ["Spring sale"],
      otherDraftCount: 0,
    });

    const [row, file] = await t.run(async (ctx) => [
      await ctx.db.get(assetId),
      await ctx.db.system.get(storageId),
    ]);
    expect(row).not.toBeNull();
    expect(file).not.toBeNull();
  });

  /*
    Shared canvases and forks copy `src` strings verbatim, so a draft that is
    not mine can render an image from my library. It still blocks the delete
    (their draft would break too), but it is COUNTED, never named — the
    refusal must not become a way to read strangers' draft titles.
  */
  it("counts a stranger's referencing draft without naming it", async () => {
    const t = createBackend();
    const storageId = await storePngFile(t);
    const { assetId, url } = await t.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId,
      kind: "uploaded",
      name: "hero.png",
    });
    await seedDraftUsingImage(t, {
      sessionId: "someone-elses-session",
      draftName: "Their secret campaign",
      url,
    });

    const result = await t.mutation(api.assets.remove, { sessionId: SESSION_ID, assetId });
    expect(result).toEqual({
      isOk: false,
      reason: "in_use",
      draftNames: [],
      otherDraftCount: 1,
    });
  });

  it("succeeds once the last draft stops pointing at it", async () => {
    const t = createBackend();
    const storageId = await storePngFile(t);
    const { assetId, url } = await t.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId,
      kind: "uploaded",
      name: "hero.png",
    });
    await seedDraftUsingImage(t, { sessionId: SESSION_ID, draftName: "Spring sale", url });

    /*
      The user does what the refusal told them to: swap the image out.
    */
    await t.run(async (ctx) => {
      const blockRow = await ctx.db.query("blocks").first();
      if (blockRow !== null) {
        await ctx.db.patch(blockRow._id, {
          properties: { src: "https://example.com/other.png", alt: "" },
        });
      }
    });

    expect(await t.mutation(api.assets.remove, { sessionId: SESSION_ID, assetId })).toEqual({
      isOk: true,
    });
  });

  it("is idempotent — deleting an already-deleted asset is not an error", async () => {
    const t = createBackend();
    const storageId = await storePngFile(t);
    const { assetId } = await t.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId,
      kind: "uploaded",
      name: "gone.png",
    });
    await t.mutation(api.assets.remove, { sessionId: SESSION_ID, assetId });
    expect(await t.mutation(api.assets.remove, { sessionId: SESSION_ID, assetId })).toEqual({
      isOk: true,
    });
  });

  it("refuses a caller who does not own the asset, and keeps both row and file", async () => {
    const t = createBackend();
    const storageId = await storePngFile(t);
    const { assetId } = await t.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId,
      kind: "uploaded",
      name: "hero.png",
    });

    await expect(
      t.mutation(api.assets.remove, { sessionId: "some-other-session", assetId }),
    ).rejects.toThrow(/different library/);

    const [row, file] = await t.run(async (ctx) => [
      await ctx.db.get(assetId),
      await ctx.db.system.get(storageId),
    ]);
    expect(row).not.toBeNull();
    expect(file).not.toBeNull();
  });
});

/*
  The same two mutations under the deployment's post-auth posture, where the
  session id argument carries no authority whatsoever.
*/
describe("with verified identities, a quoted session id buys nothing", () => {
  const originalStrictFlag = process.env[STRICT_FLAG];

  beforeEach(() => {
    process.env[STRICT_FLAG] = "true";
  });

  afterEach(() => {
    if (originalStrictFlag === undefined) {
      delete process.env[STRICT_FLAG];
    } else {
      process.env[STRICT_FLAG] = originalStrictFlag;
    }
  });

  it("refuses a stranger who replays the owner's session id", async () => {
    const t = createBackend();
    const owner = t.withIdentity({ subject: OWNER });
    const stranger = t.withIdentity({ subject: STRANGER });

    const storageId = await storePngFile(t);
    const { assetId } = await owner.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId,
      kind: "uploaded",
      name: "hero.png",
    });

    /*
      Verbatim replay of the owner's published session id.
    */
    await expect(
      stranger.mutation(api.assets.rename, { sessionId: SESSION_ID, assetId, name: "mine now" }),
    ).rejects.toThrow(/different library/);
    await expect(
      stranger.mutation(api.assets.remove, { sessionId: SESSION_ID, assetId }),
    ).rejects.toThrow(/different library/);

    const [row, file] = await t.run(async (ctx) => [
      await ctx.db.get(assetId),
      await ctx.db.system.get(storageId),
    ]);
    expect(row?.name).toBe("hero.png");
    expect(file).not.toBeNull();
  });

  /*
    The other half of the same mechanism: the owner's OWN calls must not
    depend on the session id argument either, or a signed-in user with a
    fresh browser (new localStorage UUID) would be locked out of their own
    library.
  */
  it("lets the owner manage their assets whatever session id they send", async () => {
    const t = createBackend();
    const owner = t.withIdentity({ subject: OWNER });
    const storageId = await storePngFile(t);
    const { assetId } = await owner.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId,
      kind: "uploaded",
      name: "hero.png",
    });

    await owner.mutation(api.assets.rename, {
      sessionId: "a-brand-new-browser-uuid",
      assetId,
      name: "Spring hero",
    });
    expect(await t.run(async (ctx) => (await ctx.db.get(assetId))?.name)).toBe("Spring hero");

    expect(
      await owner.mutation(api.assets.remove, {
        sessionId: "a-brand-new-browser-uuid",
        assetId,
      }),
    ).toEqual({ isOk: true });
  });
});
