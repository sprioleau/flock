// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register as registerProsemirrorSync } from "@convex-dev/prosemirror-sync/test";
import { api } from "@convex/_generated/api";
import schema from "@convex/schema";

const modules = import.meta.glob([
  "../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

const OWNER_A = "chat-owner-a";
const OWNER_B = "chat-owner-b";
const SESSION_ID = "legacy-chat-session";
const STRICT_FLAG = "FLOCK_REQUIRE_AUTH_IDENTITY";
const originalStrictFlag = process.env[STRICT_FLAG];

type Backend = ReturnType<typeof convexTest>;
type Caller = ReturnType<Backend["withIdentity"]>;

function createBackend() {
  const backend = convexTest(schema, modules);
  registerProsemirrorSync(backend);
  return backend;
}

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

async function createCanvas(caller: Caller) {
  return await caller.mutation(api.documents.createDocument, {
    sessionId: SESSION_ID,
    canvasTitle: "Chat test canvas",
    name: "Draft 1",
  });
}

describe("durable canvas chat", () => {
  it("creates one stable thread and persists finalized turns in order", async () => {
    const backend = createBackend();
    const owner = backend.withIdentity({ subject: OWNER_A });
    const { canvasId } = await createCanvas(owner);

    const firstThread = await owner.mutation(api.chat.getOrCreateThread, {
      canvasId,
      sessionId: SESSION_ID,
    });
    const secondThread = await owner.mutation(api.chat.getOrCreateThread, {
      canvasId,
      sessionId: SESSION_ID,
    });
    expect(secondThread._id).toBe(firstThread._id);

    const userTurn = await owner.mutation(api.chat.persistFinalizedTurn, {
      canvasId,
      sessionId: SESSION_ID,
      turnId: "message-user-1",
      idempotencyKey: "request-user-1",
      role: "user",
      content: "Make the CTA clearer.",
    });
    const assistantTurn = await owner.mutation(api.chat.persistFinalizedTurn, {
      canvasId,
      sessionId: SESSION_ID,
      turnId: "message-assistant-1",
      idempotencyKey: "request-assistant-1",
      role: "assistant",
      content: "I made the CTA clearer.",
    });

    expect(userTurn).toMatchObject({ turnId: "message-user-1", sequence: 1, isNew: true });
    expect(assistantTurn).toMatchObject({
      turnId: "message-assistant-1",
      sequence: 2,
      isNew: true,
    });
    await expect(
      owner.query(api.chat.listTurns, { canvasId, sessionId: SESSION_ID }),
    ).resolves.toMatchObject([
      { turnId: "message-user-1", role: "user", status: "finalized", sequence: 1 },
      { turnId: "message-assistant-1", role: "assistant", status: "finalized", sequence: 2 },
    ]);
  });

  it("converges concurrent first visits on one thread", async () => {
    const backend = createBackend();
    const owner = backend.withIdentity({ subject: OWNER_A });
    const { canvasId } = await createCanvas(owner);

    const threads = await Promise.all(
      Array.from({ length: 2 }, () =>
        owner.mutation(api.chat.getOrCreateThread, { canvasId, sessionId: SESSION_ID }),
      ),
    );
    expect(threads[0]!._id).toBe(threads[1]!._id);
    await expect(
      backend.run(async (ctx) => ctx.db.query("chatThreads").collect()),
    ).resolves.toHaveLength(1);
  });

  it("keeps the oldest duplicate thread canonical while preserving and cleaning every turn", async () => {
    const backend = createBackend();
    const owner = backend.withIdentity({ subject: OWNER_A });
    const { canvasId } = await createCanvas(owner);
    const canonical = await owner.mutation(api.chat.getOrCreateThread, {
      canvasId,
      sessionId: SESSION_ID,
    });
    await owner.mutation(api.chat.persistFinalizedTurn, {
      canvasId,
      sessionId: SESSION_ID,
      turnId: "canonical-turn",
      idempotencyKey: "canonical-request",
      role: "user",
      content: "A canonical turn should not appear twice.",
    });
    const duplicate = await backend.run(async (ctx) => {
      const now = Date.now();
      const threadId = await ctx.db.insert("chatThreads", {
        canvasId,
        lastSequence: 1,
        createdAtMs: now,
        updatedAtMs: now,
      });
      await ctx.db.insert("chatTurns", {
        threadId,
        canvasId,
        turnId: "legacy-duplicate-turn",
        idempotencyKey: "legacy-duplicate-request",
        role: "user",
        content: "A turn from the duplicate row must remain readable.",
        status: "finalized",
        sequence: 1,
        createdAtMs: now,
        finalizedAtMs: now,
      });
      await ctx.db.insert("chatTurns", {
        threadId,
        canvasId,
        turnId: "canonical-turn",
        idempotencyKey: "canonical-request",
        role: "user",
        content: "A canonical turn should not appear twice.",
        status: "finalized",
        sequence: 2,
        createdAtMs: now,
        finalizedAtMs: now,
      });
      return threadId;
    });

    const resolved = await owner.query(api.chat.getThread, { canvasId, sessionId: SESSION_ID });
    expect(resolved?._id).toBe(canonical._id);
    expect(resolved?._id).not.toBe(duplicate);
    await expect(
      owner.query(api.chat.listTurns, { canvasId, sessionId: SESSION_ID }),
    ).resolves.toMatchObject([
      { turnId: "canonical-turn", sequence: 1 },
      { turnId: "legacy-duplicate-turn", sequence: 1 },
    ]);

    const persisted = await owner.mutation(api.chat.persistFinalizedTurn, {
      canvasId,
      sessionId: SESSION_ID,
      turnId: "post-duplicate-turn",
      idempotencyKey: "post-duplicate-request",
      role: "assistant",
      content: "New writes use the canonical sequence.",
    });
    expect(persisted).toMatchObject({ sequence: 3, isNew: true });

    await owner.mutation(api.canvases.deleteCanvas, { canvasId, sessionId: SESSION_ID });
    await expect(
      backend.run(async (ctx) => ({
        threads: await ctx.db.query("chatThreads").collect(),
        turns: await ctx.db.query("chatTurns").collect(),
      })),
    ).resolves.toMatchObject({ threads: [], turns: [] });
  });

  it("makes a repeated final write a no-op and rejects a conflicting retry", async () => {
    const backend = createBackend();
    const owner = backend.withIdentity({ subject: OWNER_A });
    const { canvasId } = await createCanvas(owner);
    const input = {
      canvasId,
      sessionId: SESSION_ID,
      turnId: "message-assistant-retry",
      idempotencyKey: "request-assistant-retry",
      role: "assistant" as const,
      content: "The stream completed.",
    };

    const first = await owner.mutation(api.chat.persistFinalizedTurn, input);
    const retry = await owner.mutation(api.chat.persistFinalizedTurn, input);
    expect(first).toMatchObject({ sequence: 1, isNew: true });
    expect(retry).toMatchObject({ sequence: 1, isNew: false });

    await expect(
      owner.mutation(api.chat.persistFinalizedTurn, {
        ...input,
        content: "A retried stream must not rewrite history.",
      }),
    ).rejects.toThrow("already used for different content");
    await expect(
      owner.query(api.chat.listTurns, { canvasId, sessionId: SESSION_ID }),
    ).resolves.toHaveLength(1);
  });

  it("treats the idempotency key as the retry primitive even when turn ids differ", async () => {
    const backend = createBackend();
    const owner = backend.withIdentity({ subject: OWNER_A });
    const { canvasId } = await createCanvas(owner);

    const first = await owner.mutation(api.chat.persistFinalizedTurn, {
      canvasId,
      sessionId: SESSION_ID,
      turnId: "message-from-first-attempt",
      idempotencyKey: "stream-run-42",
      role: "assistant",
      content: "Recovered assistant response.",
    });
    const retry = await owner.mutation(api.chat.persistFinalizedTurn, {
      canvasId,
      sessionId: SESSION_ID,
      turnId: "message-from-retry",
      idempotencyKey: "stream-run-42",
      role: "assistant",
      content: "Recovered assistant response.",
    });

    expect(retry).toEqual({
      turnId: "message-from-first-attempt",
      sequence: first.sequence,
      isNew: false,
    });
    await expect(
      owner.query(api.chat.listTurns, { canvasId, sessionId: SESSION_ID }),
    ).resolves.toHaveLength(1);
  });

  it("rejects a reused turn id even when the retry key changes", async () => {
    const backend = createBackend();
    const owner = backend.withIdentity({ subject: OWNER_A });
    const { canvasId } = await createCanvas(owner);
    const first = {
      canvasId,
      sessionId: SESSION_ID,
      turnId: "stable-turn-id",
      idempotencyKey: "first-request-key",
      role: "assistant" as const,
      content: "The original finalized response.",
    };

    await owner.mutation(api.chat.persistFinalizedTurn, first);

    await expect(
      owner.mutation(api.chat.persistFinalizedTurn, {
        ...first,
        idempotencyKey: "different-request-key",
      }),
    ).rejects.toThrow("already finalized with a different retry key");
    await expect(
      owner.query(api.chat.listTurns, { canvasId, sessionId: SESSION_ID }),
    ).resolves.toMatchObject([
      {
        turnId: "stable-turn-id",
        content: "The original finalized response.",
      },
    ]);
  });

  it("allows share-link collaborators to use the canvas thread without mixing canvases", async () => {
    const backend = createBackend();
    const owner = backend.withIdentity({ subject: OWNER_A });
    const collaborator = backend.withIdentity({ subject: OWNER_B });
    const firstCanvas = await createCanvas(owner);
    const secondCanvas = await createCanvas(owner);

    await owner.mutation(api.chat.persistFinalizedTurn, {
      canvasId: firstCanvas.canvasId,
      sessionId: SESSION_ID,
      turnId: "first-canvas-user",
      idempotencyKey: "first-canvas-user-request",
      role: "user",
      content: "Shared canvas context.",
    });
    await owner.mutation(api.chat.persistFinalizedTurn, {
      canvasId: secondCanvas.canvasId,
      sessionId: SESSION_ID,
      turnId: "second-canvas-user",
      idempotencyKey: "second-canvas-user-request",
      role: "user",
      content: "Different canvas context.",
    });

    await expect(
      collaborator.query(api.chat.listTurns, {
        canvasId: firstCanvas.canvasId,
        sessionId: "collaborator-session",
      }),
    ).resolves.toMatchObject([{ turnId: "first-canvas-user" }]);
    await collaborator.mutation(api.chat.persistFinalizedTurn, {
      canvasId: firstCanvas.canvasId,
      sessionId: "collaborator-session",
      turnId: "first-canvas-assistant",
      idempotencyKey: "first-canvas-assistant-request",
      role: "assistant",
      content: "The shared thread stays on its canvas.",
    });
    await expect(
      owner.query(api.chat.listTurns, { canvasId: firstCanvas.canvasId, sessionId: SESSION_ID }),
    ).resolves.toMatchObject([
      { turnId: "first-canvas-user" },
      { turnId: "first-canvas-assistant" },
    ]);
    await expect(
      owner.query(api.chat.listTurns, { canvasId: secondCanvas.canvasId, sessionId: SESSION_ID }),
    ).resolves.toMatchObject([{ turnId: "second-canvas-user" }]);
  });

  it("deletes turns before the thread when deleting a canvas", async () => {
    const backend = createBackend();
    const owner = backend.withIdentity({ subject: OWNER_A });
    const { canvasId } = await createCanvas(owner);
    await owner.mutation(api.chat.persistFinalizedTurn, {
      canvasId,
      sessionId: SESSION_ID,
      turnId: "cleanup-user",
      idempotencyKey: "cleanup-user-request",
      role: "user",
      content: "Delete this history with its canvas.",
    });
    await owner.mutation(api.chat.persistFinalizedTurn, {
      canvasId,
      sessionId: SESSION_ID,
      turnId: "cleanup-assistant",
      idempotencyKey: "cleanup-assistant-request",
      role: "assistant",
      content: "The canvas cleanup is complete.",
    });

    await owner.mutation(api.canvases.deleteCanvas, { canvasId, sessionId: SESSION_ID });
    await expect(
      backend.run(async (ctx) => ({
        canvases: await ctx.db.query("canvases").collect(),
        threads: await ctx.db.query("chatThreads").collect(),
        turns: await ctx.db.query("chatTurns").collect(),
      })),
    ).resolves.toMatchObject({ threads: [], turns: [] });
  });

  it("cleans chat rows from an empty canvas too", async () => {
    const backend = createBackend();
    const owner = backend.withIdentity({ subject: OWNER_A });
    const canvasId = await backend.run(async (ctx) => {
      const now = Date.now();
      const createdCanvasId = await ctx.db.insert("canvases", {
        sessionId: SESSION_ID,
        title: "Empty canvas with chat",
        createdAtMs: now,
        updatedAtMs: now,
      });
      await ctx.db.insert("canvasOwners", {
        canvasId: createdCanvasId,
        ownerId: OWNER_A,
        createdAtMs: now,
      });
      const threadId = await ctx.db.insert("chatThreads", {
        canvasId: createdCanvasId,
        lastSequence: 1,
        createdAtMs: now,
        updatedAtMs: now,
      });
      await ctx.db.insert("chatTurns", {
        threadId,
        canvasId: createdCanvasId,
        turnId: "empty-canvas-turn",
        idempotencyKey: "empty-canvas-request",
        role: "user",
        content: "This canvas has no drafts yet.",
        status: "finalized",
        sequence: 1,
        createdAtMs: now,
        finalizedAtMs: now,
      });
      return createdCanvasId;
    });

    await owner.mutation(api.canvases.deleteCanvas, { canvasId, sessionId: SESSION_ID });
    await expect(
      backend.run(async (ctx) => ({
        canvas: await ctx.db.get(canvasId),
        threads: await ctx.db.query("chatThreads").collect(),
        turns: await ctx.db.query("chatTurns").collect(),
      })),
    ).resolves.toMatchObject({ canvas: null, threads: [], turns: [] });
  });

  it("resumes non-empty canvas deletion after the shared row budget reaches zero", async () => {
    vi.useFakeTimers();
    try {
      const backend = createBackend();
      const owner = backend.withIdentity({ subject: OWNER_A });
      const first = await createCanvas(owner);
      const second = await owner.mutation(api.documents.createDocument, {
        sessionId: SESSION_ID,
        canvasId: first.canvasId,
        name: "Draft 2",
      });

      await backend.run(async (ctx) => {
        const now = Date.now();
        const threadId = await ctx.db.insert("chatThreads", {
          canvasId: first.canvasId,
          lastSequence: 1001,
          createdAtMs: now,
          updatedAtMs: now,
        });
        for (let index = 0; index < 1001; index += 1) {
          await ctx.db.insert("chatTurns", {
            threadId,
            canvasId: first.canvasId,
            turnId: `large-history-turn-${index}`,
            idempotencyKey: `large-history-request-${index}`,
            role: index % 2 === 0 ? "user" : "assistant",
            content: `History entry ${index}`,
            status: "finalized",
            sequence: index + 1,
            createdAtMs: now,
            finalizedAtMs: now,
          });
        }
        for (let index = 0; index < 1001; index += 1) {
          await ctx.db.insert("operations", {
            documentId: first.documentId,
            version: index + 1,
            op: { type: "test" },
            inverse: { type: "test" },
            authorId: "cleanup-test",
            author: "user",
            caller: "cli",
            kind: "edit",
            createdAtMs: now,
          });
        }
      });

      const firstResult = await owner.mutation(api.canvases.deleteCanvas, {
        canvasId: first.canvasId,
        sessionId: SESSION_ID,
      });
      expect(firstResult).toMatchObject({ isOk: true, isComplete: false });
      expect(await backend.query(api.documents.getDocument, { documentId: second.documentId }))
        .not.toBeNull();
      expect(await backend.query(api.documents.canvasExists, { canvasKey: first.canvasId })).toBe(
        true,
      );

      await backend.finishAllScheduledFunctions(() => vi.runAllTimers());

      await expect(
        backend.run(async (ctx) => ({
          canvas: await ctx.db.get(first.canvasId),
          documents: await ctx.db
            .query("documents")
            .withIndex("by_canvasId", (q) => q.eq("canvasId", first.canvasId))
            .collect(),
          threads: await ctx.db
            .query("chatThreads")
            .withIndex("by_canvasId", (q) => q.eq("canvasId", first.canvasId))
            .collect(),
          turns: await ctx.db.query("chatTurns").collect(),
          operations: await ctx.db
            .query("operations")
            .withIndex("by_documentId_and_version", (q) => q.eq("documentId", first.documentId))
            .collect(),
        })),
      ).resolves.toMatchObject({ canvas: null, documents: [], threads: [], turns: [], operations: [] });
    } finally {
      vi.useRealTimers();
    }
  });
});
