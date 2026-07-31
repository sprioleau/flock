// @vitest-environment edge-runtime
import { afterEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { seedAssetName } from "@convex/model/assets";
import {
  createEmptyCleanupStats,
  deleteDocumentCascade,
  MAX_ROW_DELETIONS_PER_RUN,
} from "@convex/model/cleanup";
import schema from "@convex/schema";

/**
 * Content Studio Stage S backend: assets.register (idempotency, URL
 * resolution, metadata denormalization, name seeding), the bounded
 * session-scoped listing, and the cleanup cascade's retain rule (registered
 * files survive their documents; unregistered legacy files don't).
 *
 * Runs the REAL Convex functions against convex-test's in-memory backend.
 */

// NOTE: convex-test's documented `!(*.*.*)` extglob matches nothing under
// vitest 4 (tinyglobby has no extglob support) — the array form with negative
// patterns is the equivalent that works.
const modules = import.meta.glob([
  "../../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

const SESSION_ID = "session-test-1";

function createBackend() {
  return convexTest(schema, modules);
}

type Backend = ReturnType<typeof createBackend>;

async function storePngFile(t: Backend, bytes: number[]): Promise<Id<"_storage">> {
  return await t.run(async (ctx) => {
    return await ctx.storage.store(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
  });
}

describe("seedAssetName", () => {
  it("prefers the caller's trimmed name", () => {
    expect(seedAssetName({ kind: "uploaded", name: "  hero.png " })).toBe("hero.png");
  });

  it("uses the prompt stem for generated images without a name", () => {
    expect(seedAssetName({ kind: "generated", prompt: " a  sunrise\nover mountains " })).toBe(
      "a sunrise over mountains",
    );
  });

  it("truncates long prompts at a word boundary with an ellipsis", () => {
    const seeded = seedAssetName({ kind: "generated", prompt: "word ".repeat(30) });
    expect(seeded.length).toBeLessThanOrEqual(61);
    expect(seeded.endsWith("…")).toBe(true);
  });

  it("falls back to a per-kind label", () => {
    expect(seedAssetName({ kind: "uploaded" })).toBe("Uploaded image");
    expect(seedAssetName({ kind: "generated" })).toBe("Generated image");
    expect(seedAssetName({ kind: "logo" })).toBe("Logo");
    expect(seedAssetName({ kind: "social-card" })).toBe("Social card");
  });
});

describe("assets.register", () => {
  it("registers an upload: resolves the URL and denormalizes file metadata", async () => {
    const t = createBackend();
    const storageId = await storePngFile(t, [1, 2, 3, 4, 5]);
    const { assetId, url } = await t.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId,
      kind: "uploaded",
      name: "hero.png",
    });
    expect(url.length).toBeGreaterThan(0);
    const row = await t.run(async (ctx) => ctx.db.get(assetId));
    // NOTE: no mimeType assertion — convex-test's in-memory storage does not
    // record a contentType (real Convex denormalizes it from the upload POST;
    // the register mutation copies it only when the system doc carries one).
    expect(row).toMatchObject({
      sessionId: SESSION_ID,
      storageId,
      url,
      kind: "uploaded",
      name: "hero.png",
      sizeBytes: 5,
    });
  });

  it("is idempotent per storageId (double-registration returns the same row)", async () => {
    const t = createBackend();
    const storageId = await storePngFile(t, [9, 9, 9]);
    const first = await t.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId,
      kind: "generated",
      prompt: "a sunrise",
      alt: "a sunrise",
    });
    const second = await t.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId,
      kind: "uploaded",
      name: "renamed-after-the-fact.png",
    });
    expect(second).toEqual(first);
    const rows = await t.run(async (ctx) => ctx.db.query("assets").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "generated", prompt: "a sunrise" });
  });

  it("stores generation provenance and seeds the name from the prompt", async () => {
    const t = createBackend();
    const storageId = await storePngFile(t, [7]);
    const { assetId } = await t.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId,
      kind: "generated",
      prompt: "golden retriever at the beach",
      alt: "golden retriever at the beach",
    });
    const row = await t.run(async (ctx) => ctx.db.get(assetId));
    expect(row).toMatchObject({
      name: "golden retriever at the beach",
      prompt: "golden retriever at the beach",
      alt: "golden retriever at the beach",
    });
  });

  it("rejects a storageId that has no file behind it", async () => {
    const t = createBackend();
    const storageId = await storePngFile(t, [1]);
    await t.run(async (ctx) => {
      await ctx.storage.delete(storageId);
    });
    await expect(
      t.mutation(api.assets.register, {
        sessionId: SESSION_ID,
        storageId,
        kind: "uploaded",
      }),
    ).rejects.toThrow(/doesn't exist in storage/);
  });
});

describe("assets.listForSession", () => {
  it("lists ONLY the session's assets, newest first", async () => {
    const t = createBackend();
    const mine = await storePngFile(t, [1]);
    const mineNewer = await storePngFile(t, [2]);
    const theirs = await storePngFile(t, [3]);
    await t.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId: mine,
      kind: "uploaded",
      name: "older.png",
    });
    await t.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId: mineNewer,
      kind: "generated",
      prompt: "newer",
    });
    await t.mutation(api.assets.register, {
      sessionId: "someone-else",
      storageId: theirs,
      kind: "uploaded",
      name: "not-mine.png",
    });

    const listed = await t.query(api.assets.listForSession, { sessionId: SESSION_ID });
    expect(listed.map((asset) => asset.name)).toEqual(["newer", "older.png"]);

    const emptyList = await t.query(api.assets.listForSession, { sessionId: "fresh-session" });
    expect(emptyList).toEqual([]);
  });
});

describe("document-cascade retain rule (model/cleanup.ts)", () => {
  const originalCloudUrl = process.env.CONVEX_CLOUD_URL;

  afterEach(() => {
    process.env.CONVEX_CLOUD_URL = originalCloudUrl;
  });

  /** One canvas+document whose single section holds image blocks for `urls`. */
  async function seedDocumentWithImages(t: Backend, urls: string[]): Promise<Id<"documents">> {
    return await t.run(async (ctx) => {
      const nowMs = Date.now();
      const canvasId = await ctx.db.insert("canvases", {
        sessionId: SESSION_ID,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
      const documentId = await ctx.db.insert("documents", {
        canvasId,
        sessionId: SESSION_ID,
        name: "Draft under test",
        orderIndex: 0,
        headVersion: 0,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
      for (const [index, url] of urls.entries()) {
        await ctx.db.insert("blocks", {
          documentId,
          blockId: `img_${index}`,
          type: "image",
          parentId: "sec_a",
          childrenIds: [],
          properties: { src: url, alt: "" },
        });
      }
      return documentId;
    });
  }

  it("retains REGISTERED files and deletes unregistered legacy files", async () => {
    const t = createBackend();
    const registeredStorageId = await storePngFile(t, [1, 1, 1]);
    const legacyStorageId = await storePngFile(t, [2, 2, 2]);
    const { url: registeredUrl } = await t.mutation(api.assets.register, {
      sessionId: SESSION_ID,
      storageId: registeredStorageId,
      kind: "uploaded",
      name: "keep-me.png",
    });
    const legacyUrl = await t.run(async (ctx) => ctx.storage.getUrl(legacyStorageId));
    expect(legacyUrl).not.toBeNull();

    // The cascade only considers THIS deployment's serving URLs.
    process.env.CONVEX_CLOUD_URL = registeredUrl.split("/api/storage/")[0];

    const documentId = await seedDocumentWithImages(t, [registeredUrl, legacyUrl!]);
    const { isComplete } = await t.run(async (ctx) => {
      const document = await ctx.db.get(documentId);
      return await deleteDocumentCascade({
        ctx,
        document: document!,
        budget: { remaining: MAX_ROW_DELETIONS_PER_RUN },
        stats: createEmptyCleanupStats(),
      });
    });
    expect(isComplete).toBe(true);

    const [registeredFile, legacyFile] = await t.run(async (ctx) => [
      await ctx.db.system.get(registeredStorageId),
      await ctx.db.system.get(legacyStorageId),
    ]);
    // Registered: the library owns it — the document cascade must not touch it.
    expect(registeredFile).not.toBeNull();
    // Unregistered legacy file: pre-registry cascade behavior, deleted.
    expect(legacyFile).toBeNull();

    // The asset row itself survives, still serving the library grid.
    const listed = await t.query(api.assets.listForSession, { sessionId: SESSION_ID });
    expect(listed.map((asset) => asset.name)).toEqual(["keep-me.png"]);
  });
});
