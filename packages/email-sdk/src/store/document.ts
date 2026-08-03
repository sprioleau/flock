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
 * The designed starter document seeded into every NEW document and NEW draft
 * (convex createDocument's default). Modeled on Resend / react-email's
 * out-of-the-box welcome templates: brand-bar logo, a left-aligned heading +
 * short intro, one clear CTA button, then a divider and muted small-print
 * footer (company line + unsubscribe merge tag).
 *
 *   root
 *   ├─ sec_hdr1 (header)  → img_lg01 (logo placeholder)
 *   ├─ sec_body (body)    → txt_wc01 (h1 + intro), btn_ct01 (CTA)
 *   └─ sec_ftr1 (footer)  → div_ft01, txt_ft01 (small-print links/address/unsubscribe)
 *
 * Design discipline (same as the section templates): structural knobs only —
 * no colors, fonts, or padding overrides — so the whole email inherits
 * DEFAULT_GLOBAL_STYLES and restyles cleanly on a theme switch. QA-clean by
 * construction: every image has alt text, every link/button href is a real
 * absolute URL or merge tag, and the footer carries address + unsubscribe.
 * Ids are stable across calls (each document owns its id namespace).
 */
export function createStarterDocument(): EmailDocument {
  const footerFontSize = { type: "textStyle" as const, attrs: { fontSize: "12px" } };
  return {
    root: {
      id: "root",
      type: "root",
      parentId: null,
      childrenIds: ["sec_hdr1", "sec_body", "sec_ftr1"],
      properties: { globals: {} },
    },
    sec_hdr1: {
      id: "sec_hdr1",
      type: "section",
      parentId: "root",
      childrenIds: ["img_lg01"],
      properties: {},
    },
    img_lg01: {
      id: "img_lg01",
      type: "image",
      parentId: "sec_hdr1",
      childrenIds: [],
      properties: {
        src: "https://placehold.co/280x80.png",
        alt: "Acme logo",
        width: 140,
        align: "left",
      },
    },
    sec_body: {
      id: "sec_body",
      type: "section",
      parentId: "root",
      childrenIds: ["txt_wc01", "btn_ct01"],
      properties: {},
    },
    txt_wc01: {
      id: "txt_wc01",
      type: "text",
      parentId: "sec_body",
      childrenIds: [],
      properties: {
        text: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 1 },
              content: [{ type: "text", text: "Welcome to Acme" }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Thanks for signing up — we're glad you're here. It takes about two minutes to finish setting up your account, and then you're ready to go.",
                },
              ],
            },
          ],
        },
      },
    },
    btn_ct01: {
      id: "btn_ct01",
      type: "button",
      parentId: "sec_body",
      childrenIds: [],
      properties: {
        label: "Get started",
        href: "https://example.com/get-started",
        align: "left",
      },
    },
    sec_ftr1: {
      id: "sec_ftr1",
      type: "section",
      parentId: "root",
      childrenIds: ["div_ft01", "txt_ft01"],
      properties: {},
    },
    div_ft01: {
      id: "div_ft01",
      type: "divider",
      parentId: "sec_ftr1",
      childrenIds: [],
      properties: {},
    },
    txt_ft01: {
      id: "txt_ft01",
      type: "text",
      parentId: "sec_ftr1",
      childrenIds: [],
      properties: {
        textAlign: "center",
        text: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Privacy",
                  marks: [
                    { type: "link", attrs: { href: "https://example.com/privacy" } },
                    footerFontSize,
                  ],
                },
                { type: "text", text: "   ·   ", marks: [footerFontSize] },
                {
                  type: "text",
                  text: "Terms",
                  marks: [
                    { type: "link", attrs: { href: "https://example.com/terms" } },
                    footerFontSize,
                  ],
                },
              ],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Acme Inc. · 123 Market Street, Suite 400, San Francisco, CA",
                  marks: [footerFontSize],
                },
              ],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Unsubscribe",
                  marks: [{ type: "link", attrs: { href: "*|UNSUB|*" } }, footerFontSize],
                },
              ],
            },
          ],
        },
      },
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
 *   ├─ sec_c3d4 (two-column)
 *   │   └─ row_k1l2
 *   │       ├─ col_m3n4 → txt_r7s8
 *   │       └─ col_p5q6 → btn_t9u0
 *   └─ sec_e5f6 (developer digest)
 *       ├─ txt_v1w2 (heading-only text)
 *       ├─ cod_x3y4 (code snippet)
 *       ├─ spc_z5a6 (spacer)
 *       └─ lnk_b7c8 (standalone link)
 *
 * Intended for tests and demos; ids are stable across calls.
 */
export function createSampleDocument(): EmailDocument {
  return {
    root: {
      id: "root",
      type: "root",
      parentId: null,
      childrenIds: ["sec_a1b2", "sec_c3d4", "sec_e5f6"],
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
              content: [{ type: "text", text: "Welcome to Flock" }],
            },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "You describe, " },
                { type: "text", text: "your flock builds", marks: [{ type: "bold" }] },
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
        alt: "Two riders on a flock bicycle",
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
    sec_e5f6: {
      id: "sec_e5f6",
      type: "section",
      parentId: "root",
      childrenIds: ["txt_v1w2", "cod_x3y4", "spc_z5a6", "lnk_b7c8"],
      properties: {},
    },
    txt_v1w2: {
      id: "txt_v1w2",
      type: "text",
      parentId: "sec_e5f6",
      childrenIds: [],
      properties: {
        text: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "For developers" }],
            },
          ],
        },
      },
    },
    cod_x3y4: {
      id: "cod_x3y4",
      type: "code",
      parentId: "sec_e5f6",
      childrenIds: [],
      properties: {
        code: 'npm install @flock/email-sdk\n\nimport { renderToHTML } from "@flock/email-sdk";',
        language: "bash",
      },
    },
    spc_z5a6: {
      id: "spc_z5a6",
      type: "spacer",
      parentId: "sec_e5f6",
      childrenIds: [],
      properties: { height: 16 },
    },
    lnk_b7c8: {
      id: "lnk_b7c8",
      type: "link",
      parentId: "sec_e5f6",
      childrenIds: [],
      properties: {
        text: "Read the changelog",
        href: "https://example.com/changelog",
        align: "center",
      },
    },
  };
}
