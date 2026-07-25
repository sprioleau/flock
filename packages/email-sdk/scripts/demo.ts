/**
 * Phase 1 demo (plan §5, Phase 1): build an email from operations only —
 * no hand-assembled document — and emit valid email HTML.
 *
 * Run from packages/email-sdk:  pnpm demo
 */
import {
  applyOperations,
  createEmptyDocument,
  createTextDoc,
  renderToHTML,
  checkDocumentIntegrity,
  type Operation,
} from "../src/index";

const ops: Operation[] = [
  {
    name: "updateDocumentSettings",
    globals: {
      emailBackgroundColor: "#f4f4f4",
      contentBackgroundColor: "#ffffff",
      buttonBackgroundColor: "#000000",
      buttonTextColor: "#ffffff",
      heading1TextAlign: "center",
      paragraphTextAlign: "center",
    },
  },
  {
    name: "addSection",
    section: {
      id: "sec_hero",
      type: "section",
      parentId: "root",
      childrenIds: [],
      properties: {},
    },
    index: 0,
  },
  {
    name: "addBlock",
    block: {
      id: "txt_head",
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
              content: [{ type: "text", text: "Built entirely from ops" }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Every mutation flowed through applyOperations — schema-validated, integrity-checked, invertible.",
                },
              ],
            },
          ],
        },
      },
    },
    parentId: "sec_hero",
    index: 0,
  },
  {
    name: "addBlock",
    block: {
      id: "btn_cta1",
      type: "button",
      parentId: "sec_hero",
      childrenIds: [],
      properties: { label: "Open Tandem", href: "https://tandem-one-neon.vercel.app" },
    },
    parentId: "sec_hero",
    index: 1,
  },
  {
    name: "addBlock",
    block: {
      id: "div_end1",
      type: "divider",
      parentId: "sec_hero",
      childrenIds: [],
      properties: {},
    },
    parentId: "sec_hero",
    index: 2,
  },
  // Exercise a few more ops: edit, reorder, then clean up a scratch block.
  {
    name: "updateText",
    blockId: "txt_head",
    text: createTextDoc("Tandem — Phase 1 demo"),
  },
  { name: "reorderChildren", parentId: "sec_hero", orderedChildIds: ["txt_head", "div_end1", "btn_cta1"] },
  { name: "removeBlock", blockId: "div_end1" },
];

const result = applyOperations(createEmptyDocument(), ops);
if (!result.isOk) {
  console.error("apply failed:", JSON.stringify(result.errors, null, 2));
  process.exit(1);
}

const integrity = checkDocumentIntegrity(result.doc);
const html = await renderToHTML(result.doc);

console.log(`ops applied:        ${ops.length} (with ${result.inverses.length} inverses for undo)`);
console.log(`integrity:          ${integrity.isValid ? "valid" : "INVALID"}`);
console.log(`html bytes:         ${html.length}`);
console.log(`looks like email:   ${html.includes("<!DOCTYPE") && html.includes("Tandem — Phase 1 demo") && html.includes("Open Tandem")}`);
console.log("\n--- first 400 chars ---\n" + html.slice(0, 400));
