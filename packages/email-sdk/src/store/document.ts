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
 * (convex createDocument's default). It is deliberately a WHOLE email rather
 * than a stub: a new draft should open on something that already looks like a
 * finished send, so the first move is editing a real email instead of filling
 * a blank page. The copy does double duty — it reads as a welcome email, and
 * it points a first-time user at the three things worth knowing on day one
 * (the theme, the section gallery, and sending yourself a test).
 *
 *   root
 *   ├─ sec_hdr1 (header)  → img_lg01 (logo placeholder)
 *   ├─ sec_hero (hero)    → txt_wc01 (h1 + intro), img_hr01, btn_ct01 (primary CTA)
 *   ├─ sec_ways (2-up)    → row_fr01
 *   │                         ├─ col_fc01 → txt_fc01 (h3 + line)
 *   │                         └─ col_fc02 → txt_fc02 (h3 + line)
 *   ├─ sec_step (how-to)  → div_st01, txt_st01 (h2 + three bold-led steps), lnk_sg01
 *   └─ sec_ftr1 (footer)  → div_ft01, txt_ft01 (small-print links/address/unsubscribe)
 *
 * DELIBERATELY SHORT. This document is also what the chat pipeline sends the
 * model on every turn, so each sentence here is paid for on every message of
 * every conversation started from a fresh draft. Prose earns its place or it
 * comes out — prefer cutting words over cutting the visual variety (the
 * two-column row, the images, the divider) that makes a new draft look like a
 * real email.
 *
 * Design discipline (same as the section templates): structural knobs only —
 * no colors, fonts, or padding overrides — so the whole email inherits
 * DEFAULT_GLOBAL_STYLES and restyles cleanly on a theme switch. QA-clean by
 * construction: every image has alt text, every link/button href is a real
 * absolute URL or merge tag, and the footer carries address + unsubscribe.
 * Ids are stable across calls (each document owns its id namespace).
 *
 * LOAD-BEARING DETAILS, do not casually reorder:
 * - `img_lg01`'s alt follows the "<Brand> logo" convention and is the FIRST
 *   image in reading order, so deriveDraftContentClues reads the brand from it.
 * - `txt_wc01` holds the first heading and the first paragraph, and `btn_ct01`
 *   is the first button — those are the headline/body/CTA clues a composed
 *   draft continues from.
 */
export function createStarterDocument(): EmailDocument {
  const footerFontSize = { type: "textStyle" as const, attrs: { fontSize: "12px" } };
  return {
    root: {
      id: "root",
      type: "root",
      parentId: null,
      childrenIds: ["sec_hdr1", "sec_hero", "sec_ways", "sec_step", "sec_ftr1"],
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
    sec_hero: {
      id: "sec_hero",
      type: "section",
      parentId: "root",
      childrenIds: ["txt_wc01", "img_hr01", "btn_ct01"],
      properties: {},
    },
    txt_wc01: {
      id: "txt_wc01",
      type: "text",
      parentId: "sec_hero",
      childrenIds: [],
      properties: {
        text: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 1 },
              content: [{ type: "text", text: "Welcome to Flock." }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "This is a real email, not a blank page — every block below is yours to rewrite, restyle, or delete.",
                },
              ],
            },
          ],
        },
      },
    },
    img_hr01: {
      id: "img_hr01",
      type: "image",
      parentId: "sec_hero",
      childrenIds: [],
      properties: {
        src: "https://placehold.co/1200x600.png",
        alt: "Placeholder image — swap in your own",
        width: 560,
        align: "center",
      },
    },
    btn_ct01: {
      id: "btn_ct01",
      type: "button",
      parentId: "sec_hero",
      childrenIds: [],
      properties: {
        label: "Get started",
        href: "https://example.com/get-started",
        align: "left",
      },
    },
    sec_ways: {
      id: "sec_ways",
      type: "section",
      parentId: "root",
      childrenIds: ["row_fr01"],
      properties: {},
    },
    row_fr01: {
      id: "row_fr01",
      type: "row",
      parentId: "sec_ways",
      childrenIds: ["col_fc01", "col_fc02"],
      properties: {},
    },
    col_fc01: {
      id: "col_fc01",
      type: "column",
      parentId: "row_fr01",
      childrenIds: ["txt_fc01"],
      properties: { widthPercent: 50 },
    },
    txt_fc01: {
      id: "txt_fc01",
      type: "text",
      parentId: "col_fc01",
      childrenIds: [],
      properties: {
        // Column content is centered, the same treatment the feature-columns
        // catalog template uses: side-by-side columns carry no gutter of their
        // own, so centering is what keeps the two blurbs visually apart.
        textAlign: "center",
        text: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 3 },
              content: [{ type: "text", text: "Edit it on the canvas" }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Click any block to change its words, colors or spacing, and drag it wherever you want it.",
                },
              ],
            },
          ],
        },
      },
    },
    col_fc02: {
      id: "col_fc02",
      type: "column",
      parentId: "row_fr01",
      childrenIds: ["txt_fc02"],
      properties: { widthPercent: 50 },
    },
    txt_fc02: {
      id: "txt_fc02",
      type: "text",
      parentId: "col_fc02",
      childrenIds: [],
      properties: {
        textAlign: "center",
        text: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 3 },
              content: [{ type: "text", text: "Or just ask for it" }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Describe the change in chat and the copilot makes it for you, one reversible step at a time.",
                },
              ],
            },
          ],
        },
      },
    },
    sec_step: {
      id: "sec_step",
      type: "section",
      parentId: "root",
      childrenIds: ["div_st01", "txt_st01", "lnk_sg01"],
      properties: {},
    },
    div_st01: {
      id: "div_st01",
      type: "divider",
      parentId: "sec_step",
      childrenIds: [],
      properties: {},
    },
    txt_st01: {
      id: "txt_st01",
      type: "text",
      parentId: "sec_step",
      childrenIds: [],
      properties: {
        text: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "Three moves to make it yours" }],
            },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Set the theme.", marks: [{ type: "bold" }] },
                {
                  type: "text",
                  text: " Pick colors and fonts once and every draft follows, or paste your website address and let Flock read them off it.",
                },
              ],
            },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Drop in a section.", marks: [{ type: "bold" }] },
                {
                  type: "text",
                  text: " Headers, heroes, pricing and footers, each previewed in the theme you already picked.",
                },
              ],
            },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Send yourself a test.", marks: [{ type: "bold" }] },
                {
                  type: "text",
                  text: " Preview the email-safe HTML, then send it to your own inbox from the draft toolbar.",
                },
              ],
            },
          ],
        },
      },
    },
    lnk_sg01: {
      id: "lnk_sg01",
      type: "link",
      parentId: "sec_step",
      childrenIds: [],
      properties: {
        text: "Browse the section gallery",
        href: "https://example.com/sections",
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
