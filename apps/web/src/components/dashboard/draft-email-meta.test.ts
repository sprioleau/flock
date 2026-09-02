// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "@convex/_generated/api";
import schema from "@convex/schema";

const modules = import.meta.glob([
  "../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

const OWNER_A = "user_owner_a";
const OWNER_B = "user_owner_b";
const STRICT_FLAG = "FLOCK_REQUIRE_AUTH_IDENTITY";
const LEGACY_SESSION_ID = "3f9a2b1c-4d5e-4f60-9a8b-7c6d5e4f3a2b";
const STRANGER_SESSION_ID = "8f9a2b1c-4d5e-4f60-9a8b-7c6d5e4f3a2b";

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

describe("per-draft email metadata", () => {
  it("normalizes create metadata, copies it on duplicate, and exposes it on reads", async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity({ subject: OWNER_A });
    const { canvasId, documentId } = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      subject: "  Spring sale is live  ",
      previewText: "  Save on every plan  ",
      audience: [" First@Example.COM ", "first@example.com", "second@example.com"],
    });

    expect(await owner.query(api.documents.getDocument, { documentId })).toMatchObject({
      subject: "Spring sale is live",
      previewText: "Save on every plan",
      audience: ["first@example.com", "second@example.com"],
    });

    const duplicateId = await owner.mutation(api.documents.duplicateDocument, { documentId });
    expect(duplicateId).not.toBeNull();
    expect(await owner.query(api.documents.getDocument, { documentId: duplicateId! })).toMatchObject({
      subject: "Spring sale is live",
      previewText: "Save on every plan",
      audience: ["first@example.com", "second@example.com"],
    });

    const rows = await owner.query(api.documents.listDocumentsByCanvas, { canvasId });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.subject === "Spring sale is live")).toBe(true);
    expect(rows.every((row) => row.audience?.length === 2)).toBe(true);
  });

  it("supports owner-only partial updates and an owner-only metadata read", async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity({ subject: OWNER_A });
    const stranger = t.withIdentity({ subject: OWNER_B });
    const { documentId } = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      subject: "Keep this subject",
    });

    await owner.mutation(api.documents.setDraftEmailMeta, {
      documentId,
      previewText: "Added later",
      audience: [" PERSON@Example.com ", "person@example.com"],
      sessionId: LEGACY_SESSION_ID,
    });
    expect(
      await owner.query(api.documents.getDraftEmailMeta, {
        documentId,
        sessionId: LEGACY_SESSION_ID,
      }),
    ).toEqual({
      subject: "Keep this subject",
      previewText: "Added later",
      audience: ["person@example.com"],
    });

    await expect(
      stranger.mutation(api.documents.setDraftEmailMeta, {
        documentId,
        subject: "Hijacked",
        sessionId: STRANGER_SESSION_ID,
      }),
    ).rejects.toThrow();
    await expect(
      stranger.query(api.documents.getDraftEmailMeta, {
        documentId,
        sessionId: STRANGER_SESSION_ID,
      }),
    ).rejects.toThrow();
  });

  it("rejects invalid and over-limit audiences without changing stored metadata", async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity({ subject: OWNER_A });
    const { documentId } = await owner.mutation(api.documents.createDocument, {
      sessionId: LEGACY_SESSION_ID,
      audience: ["valid@example.com"],
    });

    await expect(
      owner.mutation(api.documents.setDraftEmailMeta, {
        documentId,
        audience: ["not-an-address"],
        sessionId: LEGACY_SESSION_ID,
      }),
    ).rejects.toThrow();
    await expect(
      owner.mutation(api.documents.setDraftEmailMeta, {
        documentId,
        audience: Array.from({ length: 101 }, (_, index) => `person-${index}@example.com`),
        sessionId: LEGACY_SESSION_ID,
      }),
    ).rejects.toThrow();

    expect(
      await owner.query(api.documents.getDraftEmailMeta, {
        documentId,
        sessionId: LEGACY_SESSION_ID,
      }),
    ).toEqual({ audience: ["valid@example.com"] });
  });
});
