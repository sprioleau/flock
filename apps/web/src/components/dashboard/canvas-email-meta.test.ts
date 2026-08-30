// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "@convex/_generated/api";
import schema from "@convex/schema";

/*
  THE CANVAS-LEVEL EMAIL META TESTS for setCanvasEmailMeta / getCanvasEmailMeta
  (convex/canvases.ts).

  Subject and preview text live on the CANVAS, shared by every draft, because
  only one draft is ever sent. These tests pin the three properties that are
  easy to "simplify" back into a bug:

    1. NON-OWNER REFUSAL — the capability check. This is the load-bearing one:
       delete the assertCanvasOwner call in the handler and this test must go
       red. It is written to fail loudly, never to pass vacuously.
    2. PARTIAL PATCH — updating only the subject must not wipe the preview.
    3. EMPTY CLEARS — a blank/whitespace value removes the field to a genuine
       absent state, not a stored "".

  convex-test setup mirrors canvas-ownership.test.ts, including the note about
  the array-form glob (the documented extglob matches nothing under vitest 4).
  These tests never reach the delete cascade, so the prosemirror-sync component
  does not need registering here.
*/
const modules = import.meta.glob(["../../../../../convex/**/*.{ts,js}", "!**/*.d.ts", "!**/*.test.ts"]);

const OWNER_A = "user_owner_a";
const OWNER_B = "user_owner_b";
const STRICT_FLAG = "FLOCK_REQUIRE_AUTH_IDENTITY";

/*
  A pre-auth browser's localStorage UUID — the legacy fallback key.
*/
const LEGACY_SESSION_ID = "3f9a2b1c-4d5e-4f60-9a8b-7c6d5e4f3a2b";

const originalStrictFlag = process.env[STRICT_FLAG];

beforeEach(() => {
  /*
    The deployment's REAL posture: strict identity, exactly as prod runs.
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

describe("setCanvasEmailMeta ownership", () => {
  /*
    THE ATTACK. A stranger with a valid identity — and even the owner's
    published session id — must not be able to set the subject/preview on a
    canvas they do not own. Removing the assertCanvasOwner call makes this
    mutation succeed and this expectation flip from throw to resolve, which is
    exactly the regression the test catches.
  */
  it("refuses a non-owner setting subject/preview", async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity({ subject: OWNER_A });
    const stranger = t.withIdentity({ subject: OWNER_B });

    const { canvasId } = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      canvasTitle: "Mine",
      name: "Draft 1",
    });

    await expect(
      stranger.mutation(api.canvases.setCanvasEmailMeta, {
        canvasId,
        subject: "Hijacked subject",
        previewText: "Hijacked preview",
        sessionId: LEGACY_SESSION_ID,
      }),
    ).rejects.toThrow();

    /*
      And nothing was written on the way to the refusal.
    */
    const meta = await owner.query(api.canvases.getCanvasEmailMeta, { canvasId });
    expect(meta).toEqual({});
  });

  it("lets the owner set subject and preview", async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity({ subject: OWNER_A });
    const { canvasId } = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      name: "Draft 1",
    });

    const didUpdate = await owner.mutation(api.canvases.setCanvasEmailMeta, {
      canvasId,
      subject: "Spring sale is live",
      previewText: "Up to 40% off, this week only",
      sessionId: LEGACY_SESSION_ID,
    });
    expect(didUpdate).toBe(true);

    const meta = await owner.query(api.canvases.getCanvasEmailMeta, { canvasId });
    expect(meta).toEqual({
      subject: "Spring sale is live",
      previewText: "Up to 40% off, this week only",
    });
  });
});

describe("setCanvasEmailMeta partial patch", () => {
  it("updating only the preview leaves an existing subject intact", async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity({ subject: OWNER_A });
    const { canvasId } = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      name: "Draft 1",
    });

    await owner.mutation(api.canvases.setCanvasEmailMeta, {
      canvasId,
      subject: "Do not lose me",
      sessionId: LEGACY_SESSION_ID,
    });

    /*
      A second call that names ONLY previewText must not touch the subject.
    */
    await owner.mutation(api.canvases.setCanvasEmailMeta, {
      canvasId,
      previewText: "Added later",
      sessionId: LEGACY_SESSION_ID,
    });

    const meta = await owner.query(api.canvases.getCanvasEmailMeta, { canvasId });
    expect(meta).toEqual({
      subject: "Do not lose me",
      previewText: "Added later",
    });
  });
});

describe("setCanvasEmailMeta empty clears the field", () => {
  it("a whitespace-only value removes the field to a genuine absent state", async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity({ subject: OWNER_A });
    const { canvasId } = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      name: "Draft 1",
    });

    await owner.mutation(api.canvases.setCanvasEmailMeta, {
      canvasId,
      subject: "Temporary",
      sessionId: LEGACY_SESSION_ID,
    });
    expect(await owner.query(api.canvases.getCanvasEmailMeta, { canvasId })).toEqual({
      subject: "Temporary",
    });

    /*
      Whitespace-only trims to empty and must CLEAR, not store "".
    */
    await owner.mutation(api.canvases.setCanvasEmailMeta, {
      canvasId,
      subject: "   ",
      sessionId: LEGACY_SESSION_ID,
    });

    const meta = await owner.query(api.canvases.getCanvasEmailMeta, { canvasId });
    /*
      Field is absent, not present-with-"". This is the patch-to-undefined
      finding: db.patch({ subject: undefined }) removes the optional field, so
      the key does not exist on the row and the object round-trips as {}.
    */
    expect(meta).toEqual({});
    expect(meta).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(meta, "subject")).toBe(false);
  });

  it("reads back through listMyCanvases too", async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity({ subject: OWNER_A });
    const { canvasId } = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      canvasTitle: "Dashboard card",
      name: "Draft 1",
    });

    await owner.mutation(api.canvases.setCanvasEmailMeta, {
      canvasId,
      subject: "Seen on the card",
      previewText: "Preheader on the card",
      sessionId: LEGACY_SESSION_ID,
    });

    const [entry] = await owner.query(api.canvases.listMyCanvases, {
      sessionId: LEGACY_SESSION_ID,
    });
    expect(entry).toMatchObject({
      subject: "Seen on the card",
      previewText: "Preheader on the card",
    });
  });
});
