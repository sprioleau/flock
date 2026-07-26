import { z } from "zod";
import { blockSchema, type Block } from "../schema/blocks";
import { blockIdSchema, ROOT_BLOCK_ID, type BlockId } from "../schema/ids";

/**
 * The flat, normalized email document: blocks keyed by id. This is the sole
 * source of truth; the nested tree is derived, ephemeral, and render-time
 * only (see inflate/deflate in ./tree.ts).
 */
export type EmailDocument = Record<BlockId, Block>;

/**
 * Schema for a whole flat document. Validates each block's shape and that
 * keys are well-formed ids — referential integrity (pointer agreement,
 * nesting, reachability) is checked separately by checkDocumentIntegrity.
 */
export const emailDocumentSchema = z
  .record(blockIdSchema, blockSchema)
  .describe(
    "A flat email document: every block keyed by its id. Structure is expressed through parentId/childrenIds pointers, never nesting.",
  );

/** A new document: just a root block with no sections and empty globals. */
export function createEmptyDocument(): EmailDocument {
  return {
    [ROOT_BLOCK_ID]: {
      id: ROOT_BLOCK_ID,
      type: "root",
      parentId: null,
      childrenIds: [],
      properties: { globals: {} },
    },
  };
}

/**
 * A small, deterministic sample document exercising every block type:
 *
 *   root
 *   ├─ sec_a1b2 (hero)
 *   │   ├─ txt_e5f6 (heading + marked-up paragraph)
 *   │   ├─ img_g7h8
 *   │   └─ div_i9j0
 *   └─ sec_c3d4 (two-column)
 *       └─ row_k1l2
 *           ├─ col_m3n4 → txt_r7s8
 *           └─ col_p5q6 → btn_t9u0
 *
 * Intended for tests and demos; ids are stable across calls.
 */
export function createSampleDocument(): EmailDocument {
  return {
    root: {
      id: "root",
      type: "root",
      parentId: null,
      childrenIds: ["sec_a1b2", "sec_c3d4"],
      properties: {
        globals: {
          emailBackgroundColor: "#f4f4f4",
          contentBackgroundColor: "#ffffff",
          contentWidth: 600,
          buttonBackgroundColor: "#1a1a2e",
          heading1TextAlign: "center",
        },
      },
    },
    sec_a1b2: {
      id: "sec_a1b2",
      type: "section",
      parentId: "root",
      childrenIds: ["txt_e5f6", "img_g7h8", "div_i9j0"],
      properties: {},
    },
    txt_e5f6: {
      id: "txt_e5f6",
      type: "text",
      parentId: "sec_a1b2",
      childrenIds: [],
      properties: {
        text: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 1 },
              content: [{ type: "text", text: "Welcome to Tandem" }],
            },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "You describe, " },
                { type: "text", text: "your partner builds", marks: [{ type: "bold" }] },
                { type: "text", text: " — read the " },
                {
                  type: "text",
                  text: "docs",
                  marks: [{ type: "link", attrs: { href: "https://example.com/docs" } }],
                },
                { type: "text", text: "." },
              ],
            },
          ],
        },
        paddingTop: 24,
        paddingBottom: 12,
      },
    },
    img_g7h8: {
      id: "img_g7h8",
      type: "image",
      parentId: "sec_a1b2",
      childrenIds: [],
      properties: {
        src: "https://placehold.co/600x400",
        alt: "Two riders on a tandem bicycle",
        width: 520,
        align: "center",
      },
    },
    div_i9j0: {
      id: "div_i9j0",
      type: "divider",
      parentId: "sec_a1b2",
      childrenIds: [],
      properties: { paddingTop: 16, paddingBottom: 16 },
    },
    sec_c3d4: {
      id: "sec_c3d4",
      type: "section",
      parentId: "root",
      childrenIds: ["row_k1l2"],
      properties: { innerBackgroundColor: "#fafafa" },
    },
    row_k1l2: {
      id: "row_k1l2",
      type: "row",
      parentId: "sec_c3d4",
      childrenIds: ["col_m3n4", "col_p5q6"],
      properties: {},
    },
    col_m3n4: {
      id: "col_m3n4",
      type: "column",
      parentId: "row_k1l2",
      childrenIds: ["txt_r7s8"],
      properties: { widthPercent: 60, verticalAlign: "middle" },
    },
    txt_r7s8: {
      id: "txt_r7s8",
      type: "text",
      parentId: "col_m3n4",
      childrenIds: [],
      properties: {
        text: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Ready to ride?", marks: [{ type: "italic" }] },
                { type: "hardBreak" },
                { type: "text", text: "Grab a seat on the right." },
              ],
            },
          ],
        },
      },
    },
    col_p5q6: {
      id: "col_p5q6",
      type: "column",
      parentId: "row_k1l2",
      childrenIds: ["btn_t9u0"],
      properties: { widthPercent: 40, verticalAlign: "middle" },
    },
    btn_t9u0: {
      id: "btn_t9u0",
      type: "button",
      parentId: "col_p5q6",
      childrenIds: [],
      properties: {
        label: "Get started",
        href: "https://example.com/start",
        align: "center",
      },
    },
  };
}
