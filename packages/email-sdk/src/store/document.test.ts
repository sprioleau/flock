import { describe, expect, it } from "vitest";
import { blockSchema } from "../schema/blocks";
import { BLOCK_TYPES, blockIdSchema } from "../schema/ids";
import {
  createEmptyDocument,
  createSampleDocument,
  createStarterDocument,
  emailDocumentSchema,
} from "./document";
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

describe("createStarterDocument", () => {
  it("is schema-valid and integrity-valid", () => {
    const document = createStarterDocument();
    expect(emailDocumentSchema.safeParse(document).success).toBe(true);
    const integrity = checkDocumentIntegrity(document);
    expect(integrity.errors).toEqual([]);
    expect(integrity.isValid).toBe(true);
  });

  it("uses ids that follow the id scheme and match their record keys", () => {
    for (const [key, block] of Object.entries(createStarterDocument())) {
      expect(blockIdSchema.safeParse(key).success).toBe(true);
      expect(block.id).toBe(key);
      expect(blockSchema.safeParse(block).success).toBe(true);
    }
  });

  it("stays theme-native: no color, font, or padding overrides anywhere", () => {
    for (const block of Object.values(createStarterDocument())) {
      const propertyNames = Object.keys(block.properties);
      const styleOverrides = propertyNames.filter(
        (name) =>
          name.toLowerCase().includes("color") ||
          name.toLowerCase().includes("font") ||
          name.startsWith("padding"),
      );
      expect(styleOverrides).toEqual([]);
    }
  });

  it("is QA-clean: every image has alt text and every href is absolute or a merge tag", () => {
    const blocks = Object.values(createStarterDocument());
    const hrefs: string[] = [];
    for (const block of blocks) {
      if (block.type === "image") {
        expect(block.properties.alt.length).toBeGreaterThan(0);
        expect(block.properties.src.startsWith("https://placehold.co/")).toBe(true);
      }
      if (block.type === "button") {
        hrefs.push(block.properties.href);
      }
      if (block.type === "text") {
        for (const node of block.properties.text.content) {
          for (const inline of node.content ?? []) {
            if (inline.type !== "text") {
              continue;
            }
            for (const mark of inline.marks ?? []) {
              if (mark.type === "link") {
                hrefs.push(mark.attrs.href);
              }
            }
          }
        }
      }
    }
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      const isAbsoluteOrMergeTag = href.startsWith("https://") || /^\*\|[A-Z]+\|\*$/.test(href);
      expect(isAbsoluteOrMergeTag).toBe(true);
    }
  });

  it("closes with a footer carrying an unsubscribe link", () => {
    const document = createStarterDocument();
    const serialized = JSON.stringify(document);
    expect(serialized).toContain("Unsubscribe");
    expect(serialized).toContain("*|UNSUB|*");
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
