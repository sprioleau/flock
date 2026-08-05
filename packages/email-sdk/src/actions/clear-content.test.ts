import { describe, expect, it } from "vitest";
import { applyOperations } from "../operations/apply";
import { BLOCK_TYPES } from "../schema/ids";
import type { Block } from "../schema/blocks";
import { createSampleDocument, type EmailDocument } from "../store/document";
import { checkDocumentIntegrity } from "../store/integrity";
import {
  buildClearContentOperations,
  CLEARED_BUTTON_LABEL,
  CLEARED_CODE,
  CLEARED_HEADING_TEXT,
  CLEARED_IMAGE_ALT,
  CLEARED_IMAGE_SRC,
  CLEARED_LINK_TEXT,
  CLEARED_PARAGRAPH_TEXT,
  isBrandLogoBlock,
} from "./clear-content";

/**
 * The one-click "clear the content" transform.
 *
 * The fixture is the shared sample document — which already covers every leaf
 * type in the schema union — extended with the three cases the sample has no
 * reason to carry: a brand logo (the one image a clear must NOT touch), a
 * second ordinary image, and a text block that mixes a heading with two
 * paragraphs (the node-granularity case).
 */

/** Apply a plan and fail loudly if the op path rejects it. */
function applyPlan(document: EmailDocument): EmailDocument {
  const result = applyOperations(document, buildClearContentOperations(document));
  if (!result.isOk) {
    throw new Error(`clear plan did not apply: ${result.errors[0]?.message ?? "unknown"}`);
  }
  return result.doc;
}

function buildFixture(): EmailDocument {
  const document = createSampleDocument();
  const header = document.sec_a1b2;
  if (header === undefined || header.type !== "section") {
    throw new Error("fixture drift: sec_a1b2 is no longer a section");
  }
  return {
    ...document,
    sec_a1b2: {
      ...header,
      childrenIds: ["img_lg01", "txt_m1x2", ...header.childrenIds, "img_ph01"],
    },
    // The brand logo: an image carrying the role marker. Survives verbatim.
    img_lg01: {
      id: "img_lg01",
      type: "image",
      parentId: "sec_a1b2",
      childrenIds: [],
      properties: {
        src: "https://cdn.example.com/acme-logo.png",
        alt: "Acme logo",
        role: "logo",
        width: 180,
        align: "left",
        href: "https://acme.example.com",
      },
    },
    // A second, ordinary image — same alt-text SHAPE as a logo, no marker.
    img_ph01: {
      id: "img_ph01",
      type: "image",
      parentId: "sec_a1b2",
      childrenIds: [],
      properties: {
        src: "https://cdn.example.com/office.jpg",
        alt: "Acme logo on the office wall",
        width: 480,
        align: "center",
        borderRadius: 8,
        href: "https://acme.example.com/about",
        paddingTop: 12,
      },
    },
    // One block, three nodes: a level-3 heading and two paragraphs, one of
    // them carrying a per-node alignment override.
    txt_m1x2: {
      id: "txt_m1x2",
      type: "text",
      parentId: "sec_a1b2",
      childrenIds: [],
      properties: {
        text: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 3, textAlign: "center" },
              content: [{ type: "text", text: "Spring release notes" }],
            },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "We shipped ", marks: [{ type: "bold" }] },
                { type: "text", text: "a lot" },
              ],
            },
            {
              type: "paragraph",
              attrs: { textAlign: "right" },
              content: [{ type: "text", text: "Read on for the details." }],
            },
          ],
        },
        textAlign: "left",
        textColor: "#333333",
        backgroundColor: "#fffbe6",
        paddingTop: 20,
      },
    },
  };
}

/** Every block-level node's single text run, as plain strings. */
function readTextRuns(block: Block | undefined): string[] {
  if (block === undefined || block.type !== "text") {
    throw new Error("expected a text block");
  }
  return block.properties.text.content.map((node) =>
    (node.content ?? []).map((child) => (child.type === "text" ? child.text : "\n")).join(""),
  );
}

describe("buildClearContentOperations", () => {
  it("produces a plan the op path accepts, leaving a schema- and integrity-valid document", () => {
    const cleared = applyPlan(buildFixture());
    expect(checkDocumentIntegrity(cleared).isValid).toBe(true);
  });

  it("emits only ordinary operations, in reading order", () => {
    const operations = buildClearContentOperations(buildFixture());
    expect([...new Set(operations.map((operation) => operation.name))].sort()).toEqual([
      "updateBlockProperties",
      "updateText",
    ]);
    // sec_a1b2's children come first, in the order the reader meets them.
    expect(operations.map((operation) => ("blockId" in operation ? operation.blockId : null))).toEqual(
      [
        "txt_m1x2",
        "txt_e5f6",
        "img_g7h8",
        "img_ph01",
        "txt_r7s8",
        "btn_t9u0",
        "txt_v1w2",
        "cod_x3y4",
        "lnk_b7c8",
      ],
    );
  });

  // --- Per block type -----------------------------------------------------

  it("covers every block type in the schema union", () => {
    // A guard against a new block type quietly slipping past the transform:
    // if this fails, decide what a clear does to the new type and say so here.
    expect([...BLOCK_TYPES].sort()).toEqual(
      [
        "button",
        "code",
        "column",
        "divider",
        "image",
        "link",
        "root",
        "row",
        "section",
        "spacer",
        "text",
      ].sort(),
    );
  });

  it("gives every heading the same placeholder and keeps its level", () => {
    const cleared = applyPlan(buildFixture());
    const level1 = cleared.txt_e5f6;
    const level2 = cleared.txt_v1w2;
    const level3 = cleared.txt_m1x2;
    if (
      level1?.type !== "text" ||
      level2?.type !== "text" ||
      level3?.type !== "text"
    ) {
      throw new Error("expected text blocks");
    }
    expect(level1.properties.text.content[0]).toEqual({
      type: "heading",
      attrs: { level: 1 },
      content: [{ type: "text", text: CLEARED_HEADING_TEXT }],
    });
    expect(level2.properties.text.content[0]).toEqual({
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: CLEARED_HEADING_TEXT }],
    });
    expect(level3.properties.text.content[0]).toEqual({
      type: "heading",
      attrs: { level: 3, textAlign: "center" },
      content: [{ type: "text", text: CLEARED_HEADING_TEXT }],
    });
  });

  it("gives every paragraph the same placeholder and drops its inline marks", () => {
    const cleared = applyPlan(buildFixture());
    expect(readTextRuns(cleared.txt_e5f6)).toEqual([
      CLEARED_HEADING_TEXT,
      CLEARED_PARAGRAPH_TEXT,
    ]);
    // txt_r7s8's paragraph held an italic run AND a hard break — one plain run now.
    expect(readTextRuns(cleared.txt_r7s8)).toEqual([CLEARED_PARAGRAPH_TEXT]);
    const block = cleared.txt_r7s8;
    if (block?.type !== "text") {
      throw new Error("expected a text block");
    }
    expect(block.properties.text.content[0]?.content).toEqual([
      { type: "text", text: CLEARED_PARAGRAPH_TEXT },
    ]);
  });

  it("works at NODE granularity inside one text block, keeping each node's attrs", () => {
    const cleared = applyPlan(buildFixture());
    const block = cleared.txt_m1x2;
    if (block?.type !== "text") {
      throw new Error("expected a text block");
    }
    expect(block.properties.text).toEqual({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3, textAlign: "center" },
          content: [{ type: "text", text: CLEARED_HEADING_TEXT }],
        },
        { type: "paragraph", content: [{ type: "text", text: CLEARED_PARAGRAPH_TEXT }] },
        {
          type: "paragraph",
          attrs: { textAlign: "right" },
          content: [{ type: "text", text: CLEARED_PARAGRAPH_TEXT }],
        },
      ],
    });
  });

  it("replaces a button's label and keeps its destination and styling", () => {
    const cleared = applyPlan(buildFixture());
    const button = cleared.btn_t9u0;
    if (button?.type !== "button") {
      throw new Error("expected a button block");
    }
    expect(button.properties).toEqual({
      label: CLEARED_BUTTON_LABEL,
      href: "https://example.com/start",
      align: "center",
    });
  });

  it("replaces an ordinary image with the placeholder image, keeping its styling", () => {
    const cleared = applyPlan(buildFixture());
    const image = cleared.img_ph01;
    if (image?.type !== "image") {
      throw new Error("expected an image block");
    }
    expect(image.properties).toEqual({
      src: CLEARED_IMAGE_SRC,
      alt: CLEARED_IMAGE_ALT,
      width: 480,
      align: "center",
      borderRadius: 8,
      href: "https://acme.example.com/about",
      paddingTop: 12,
    });
  });

  it("replaces a standalone link's text and keeps its destination", () => {
    const cleared = applyPlan(buildFixture());
    const link = cleared.lnk_b7c8;
    if (link?.type !== "link") {
      throw new Error("expected a link block");
    }
    expect(link.properties).toEqual({
      text: CLEARED_LINK_TEXT,
      href: "https://example.com/changelog",
      align: "center",
    });
  });

  it("replaces a code snippet and keeps its language", () => {
    const cleared = applyPlan(buildFixture());
    const code = cleared.cod_x3y4;
    if (code?.type !== "code") {
      throw new Error("expected a code block");
    }
    expect(code.properties).toEqual({ code: CLEARED_CODE, language: "bash" });
  });

  it("leaves dividers and spacers alone — they carry no content", () => {
    const fixture = buildFixture();
    const cleared = applyPlan(fixture);
    expect(cleared.div_i9j0).toEqual(fixture.div_i9j0);
    expect(cleared.spc_z5a6).toEqual(fixture.spc_z5a6);
  });

  // --- What must survive --------------------------------------------------

  it("leaves the brand logo exactly as it was", () => {
    const fixture = buildFixture();
    const cleared = applyPlan(fixture);
    expect(cleared.img_lg01).toEqual(fixture.img_lg01);
    expect(
      buildClearContentOperations(fixture).some(
        (operation) => "blockId" in operation && operation.blockId === "img_lg01",
      ),
    ).toBe(false);
  });

  it("identifies the logo by its role marker, never by its alt text", () => {
    const fixture = buildFixture();
    expect(isBrandLogoBlock(fixture.img_lg01!)).toBe(true);
    // Alt text SAYS logo; no marker, so it is cleared like any other image.
    expect(isBrandLogoBlock(fixture.img_ph01!)).toBe(false);
    const cleared = applyPlan(fixture);
    const photo = cleared.img_ph01;
    if (photo?.type !== "image") {
      throw new Error("expected an image block");
    }
    expect(photo.properties.src).toBe(CLEARED_IMAGE_SRC);
  });

  it("leaves the theme untouched", () => {
    const fixture = buildFixture();
    const cleared = applyPlan(fixture);
    expect(cleared.root).toEqual(fixture.root);
  });

  it("leaves the structure untouched — same blocks, same parents, same order", () => {
    const fixture = buildFixture();
    const cleared = applyPlan(fixture);
    expect(Object.keys(cleared).sort()).toEqual(Object.keys(fixture).sort());
    for (const [blockId, block] of Object.entries(fixture)) {
      const clearedBlock = cleared[blockId];
      expect(clearedBlock?.type).toBe(block.type);
      expect(clearedBlock?.parentId).toBe(block.parentId);
      expect(clearedBlock?.childrenIds).toEqual(block.childrenIds);
    }
    // Sections, rows and columns keep their own properties too.
    expect(cleared.sec_c3d4).toEqual(fixture.sec_c3d4);
    expect(cleared.row_k1l2).toEqual(fixture.row_k1l2);
    expect(cleared.col_m3n4).toEqual(fixture.col_m3n4);
    expect(cleared.col_p5q6).toEqual(fixture.col_p5q6);
  });

  it("keeps a touched text block's own styling properties", () => {
    const cleared = applyPlan(buildFixture());
    const block = cleared.txt_m1x2;
    if (block?.type !== "text") {
      throw new Error("expected a text block");
    }
    expect(block.properties.textAlign).toBe("left");
    expect(block.properties.textColor).toBe("#333333");
    expect(block.properties.backgroundColor).toBe("#fffbe6");
    expect(block.properties.paddingTop).toBe(20);
  });

  it("never mutates the document it is given", () => {
    const fixture = buildFixture();
    const before = structuredClone(fixture);
    buildClearContentOperations(fixture);
    expect(fixture).toEqual(before);
  });

  // --- Idempotency --------------------------------------------------------

  it("is a no-op the second time — an already-cleared document plans nothing", () => {
    const cleared = applyPlan(buildFixture());
    expect(buildClearContentOperations(cleared)).toEqual([]);
  });

  it("produces the same document whether run once or twice", () => {
    const once = applyPlan(buildFixture());
    const twice = applyPlan(once);
    expect(twice).toEqual(once);
  });

  it("plans nothing for a document that has no content-bearing blocks", () => {
    const structureOnly: EmailDocument = {
      root: { id: "root", type: "root", parentId: null, childrenIds: ["sec_a1b2"], properties: {} },
      sec_a1b2: {
        id: "sec_a1b2",
        type: "section",
        parentId: "root",
        childrenIds: ["spc_a1b2", "div_a1b2"],
        properties: {},
      },
      spc_a1b2: {
        id: "spc_a1b2",
        type: "spacer",
        parentId: "sec_a1b2",
        childrenIds: [],
        properties: { height: 24 },
      },
      div_a1b2: {
        id: "div_a1b2",
        type: "divider",
        parentId: "sec_a1b2",
        childrenIds: [],
        properties: {},
      },
    };
    expect(buildClearContentOperations(structureOnly)).toEqual([]);
  });

  // --- The reverse direction ----------------------------------------------

  it("is exactly undoable: applying the generated inverses restores the original", () => {
    const fixture = buildFixture();
    const operations = buildClearContentOperations(fixture);
    const forward = applyOperations(fixture, operations);
    if (!forward.isOk) {
      throw new Error("clear plan did not apply");
    }
    // `inverses` is already in reverse order — front to back undoes the batch.
    const back = applyOperations(forward.doc, forward.inverses);
    if (!back.isOk) {
      throw new Error("inverses did not apply");
    }
    expect(back.doc).toEqual(fixture);
  });
});
