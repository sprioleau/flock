import { describe, expect, it } from "vitest";
import { renderToHTML } from "../render/render-to-html";
import { renderToPlainText } from "../render/render-to-plain-text";
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

  it("opens on a whole email, not a stub — but stays cheap: four to six sections", () => {
    // The owner's bar in both directions: a new draft should already look like
    // a finished send, AND it is the document the chat pipeline resends on
    // every turn, so it must not be a wall of prose nobody asked for.
    const sectionIds = createStarterDocument().root!.childrenIds;
    expect(sectionIds.length).toBeGreaterThanOrEqual(4);
    expect(sectionIds.length).toBeLessThanOrEqual(6);
  });

  it("stays small enough to resend on every chat turn", () => {
    // Guards the real cost: this document rides along with every message of
    // every conversation started from a fresh draft, so every sentence added
    // here is paid for again on every turn. It currently serializes to ~5.1k
    // characters. Raising this ceiling is a deliberate decision about token
    // spend, not a formality — say why in the commit.
    expect(JSON.stringify(createStarterDocument()).length).toBeLessThan(5500);
  });

  it("shows off the layout vocabulary a user can reach for", () => {
    const blocks = Object.values(createStarterDocument());
    const presentTypes = new Set(blocks.map((block) => block.type));
    // A side-by-side area (row + columns) is the point of "visual variety" —
    // a starter made only of stacked text teaches nothing about layout.
    for (const type of ["section", "row", "column", "text", "image", "button", "divider", "link"]) {
      expect(presentTypes.has(type as (typeof blocks)[number]["type"])).toBe(true);
    }
    const columns = blocks.filter((block) => block.type === "column");
    expect(columns.length).toBeGreaterThanOrEqual(2);
    expect(
      columns.reduce((total, column) => total + (column.properties.widthPercent ?? 0), 0),
    ).toBe(100);
  });

  it("reads like an email: real headings and real sentences, kept tight", () => {
    const paragraphs: string[] = [];
    const headings: string[] = [];
    for (const [blockId, block] of Object.entries(createStarterDocument())) {
      // The footer is legitimately small print — links, an address line, an
      // unsubscribe — and is exempt from the body-copy bar below.
      if (block.type !== "text" || blockId === "txt_ft01") {
        continue;
      }
      for (const node of block.properties.text.content) {
        const plain = (node.content ?? [])
          .map((inline) => (inline.type === "text" ? inline.text : " "))
          .join("");
        (node.type === "heading" ? headings : paragraphs).push(plain);
      }
    }
    // Real headings, not one-word labels.
    expect(headings.length).toBeGreaterThanOrEqual(4);
    for (const heading of headings) {
      expect(heading.split(" ").length).toBeGreaterThanOrEqual(3);
    }
    // Every body paragraph is a real sentence — the original failure was
    // four-word stubs — and none of them rambles. The ceiling is the point:
    // this document is resent on every chat turn, so verbosity has a price.
    expect(paragraphs.length).toBeGreaterThanOrEqual(5);
    for (const paragraph of paragraphs) {
      expect(paragraph.length).toBeGreaterThanOrEqual(60);
      expect(paragraph.length).toBeLessThanOrEqual(160);
    }
  });

  it("keeps the content clues a composed draft continues from", () => {
    // deriveDraftContentClues (actions/compose-draft) reads the brand off the
    // FIRST image's "<Brand> logo" alt, the headline/body off the first
    // heading and paragraph, and the CTA off the first button. Reordering the
    // starter past those anchors silently degrades every composed draft.
    const document = createStarterDocument();
    const readingOrder: string[] = [];
    const visit = (blockId: string): void => {
      readingOrder.push(blockId);
      for (const childId of document[blockId]!.childrenIds) {
        visit(childId);
      }
    };
    for (const sectionId of document.root!.childrenIds) {
      visit(sectionId);
    }
    const firstOfType = (type: string): string | undefined =>
      readingOrder.find((blockId) => document[blockId]!.type === type);
    expect(firstOfType("image")).toBe("img_lg01");
    expect(firstOfType("button")).toBe("btn_ct01");
    const logo = document.img_lg01!;
    expect(logo.type === "image" && logo.properties.alt).toBe("Flock logo");
    const firstText = document[firstOfType("text")!]!;
    expect(firstText.id).toBe("txt_wc01");
    if (firstText.type !== "text") {
      throw new Error("the first text block is not a text block");
    }
    expect(firstText.properties.text.content[0]!.type).toBe("heading");
    expect(firstText.properties.text.content[1]!.type).toBe("paragraph");
  });

  it("renders to email-safe HTML and to plain text without errors", async () => {
    const document = createStarterDocument();
    const html = await renderToHTML(document);
    // A real email came out the other side: the logo, the hero image, both
    // columns of the side-by-side area, the call to action, and the
    // unsubscribe line.
    expect(html).toContain("https://placehold.co/280x80.png");
    expect((html.match(/<img/g) ?? []).length).toBe(2);
    expect((html.match(/width:50%/g) ?? []).length).toBe(2);
    expect(html).toContain("https://example.com/get-started");
    expect(html).toContain("*|UNSUB|*");
    const plainText = await renderToPlainText(document);
    expect(plainText).toContain("WELCOME TO FLOCK.");
    expect(plainText).toContain("Unsubscribe");
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
