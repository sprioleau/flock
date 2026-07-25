import { describe, expect, it } from "vitest";
import { blockSchema } from "../schema/blocks";
import { BLOCK_TYPES, blockIdSchema } from "../schema/ids";
import { createEmptyDocument, createSampleDocument, emailDocumentSchema } from "./document";
import { checkDocumentIntegrity } from "./integrity";

describe("createEmptyDocument", () => {
  it("is schema-valid and integrity-valid", () => {
    const document = createEmptyDocument();
    expect(emailDocumentSchema.safeParse(document).success).toBe(true);
    expect(checkDocumentIntegrity(document).isValid).toBe(true);
  });

  it("contains exactly one block: a childless root with empty globals", () => {
    const document = createEmptyDocument();
    expect(Object.keys(document)).toEqual(["root"]);
    expect(document.root!.type).toBe("root");
    expect(document.root!.childrenIds).toEqual([]);
    expect(document.root!.properties).toEqual({ globals: {} });
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    const first = createEmptyDocument();
    const second = createEmptyDocument();
    expect(first).not.toBe(second);
    expect(first.root).not.toBe(second.root);
  });
});

describe("createSampleDocument", () => {
  it("is schema-valid and integrity-valid", () => {
    const document = createSampleDocument();
    expect(emailDocumentSchema.safeParse(document).success).toBe(true);
    const integrity = checkDocumentIntegrity(document);
    expect(integrity.errors).toEqual([]);
    expect(integrity.isValid).toBe(true);
  });

  it("exercises every block type", () => {
    const presentTypes = new Set(Object.values(createSampleDocument()).map((block) => block.type));
    for (const type of BLOCK_TYPES) {
      expect(presentTypes.has(type)).toBe(true);
    }
  });

  it("uses ids that follow the id scheme and match their record keys", () => {
    for (const [key, block] of Object.entries(createSampleDocument())) {
      expect(blockIdSchema.safeParse(key).success).toBe(true);
      expect(block.id).toBe(key);
      expect(blockSchema.safeParse(block).success).toBe(true);
    }
  });
});

describe("emailDocumentSchema", () => {
  it("rejects malformed keys", () => {
    const document = { "1": createEmptyDocument().root };
    expect(emailDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("rejects documents containing invalid blocks", () => {
    const document = {
      root: { id: "root", type: "root", parentId: null, childrenIds: [], properties: { bogus: true } },
    };
    expect(emailDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("accepts the sample document", () => {
    expect(emailDocumentSchema.safeParse(createSampleDocument()).success).toBe(true);
  });
});
