import type {
  ButtonBlock,
  ColumnBlock,
  DividerBlock,
  ImageBlock,
  RowBlock,
  SectionBlock,
  TextBlock,
} from "../schema/blocks";
import type { GlobalStyles } from "../schema/globals";
import type { TextDoc } from "../schema/text";
import type { EmailDocument } from "../store/document";

/**
 * Golden-render fixtures (Phase 1.4 plan requirement): globals-only,
 * block-overrides-only, and mixed. Each exercises every block type and every
 * mark, with deterministic ids so HTML snapshots are stable.
 */

const richTextDoc: TextDoc = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 1 },
      content: [{ type: "text", text: "Spring launch" }],
    },
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Everything new" }],
    },
    {
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "In one place" }],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Plain, " },
        { type: "text", text: "bold", marks: [{ type: "bold" }] },
        { type: "text", text: ", " },
        { type: "text", text: "italic", marks: [{ type: "italic" }] },
        { type: "text", text: ", " },
        { type: "text", text: "underlined", marks: [{ type: "underline" }] },
        { type: "text", text: ", " },
        { type: "text", text: "struck", marks: [{ type: "strike" }] },
        { type: "hardBreak" },
        {
          type: "text",
          text: "bold italic link",
          marks: [
            { type: "bold" },
            { type: "italic" },
            { type: "link", attrs: { href: "https://example.com/launch" } },
          ],
        },
        { type: "text", text: "." },
      ],
    },
  ],
};

/**
 * Shared structure: root > [sec_h1a1 (text, image, divider), sec_c0l2 (row >
 * two columns > text | button)]. Callers supply globals and per-block
 * property overrides.
 */
function buildFixture(options: {
  globals: GlobalStyles;
  sectionProperties: SectionBlock["properties"];
  rowProperties: RowBlock["properties"];
  columnProperties: [ColumnBlock["properties"], ColumnBlock["properties"]];
  textProperties: Omit<TextBlock["properties"], "text">;
  buttonProperties: Omit<ButtonBlock["properties"], "label" | "href">;
  imageProperties: Omit<ImageBlock["properties"], "src" | "alt">;
  dividerProperties: DividerBlock["properties"];
}): EmailDocument {
  return {
    root: {
      id: "root",
      type: "root",
      parentId: null,
      childrenIds: ["sec_h1a1", "sec_c0l2"],
      properties: { globals: options.globals },
    },
    sec_h1a1: {
      id: "sec_h1a1",
      type: "section",
      parentId: "root",
      childrenIds: ["txt_r1ch", "img_h3r0", "div_l1n3"],
      properties: options.sectionProperties,
    },
    txt_r1ch: {
      id: "txt_r1ch",
      type: "text",
      parentId: "sec_h1a1",
      childrenIds: [],
      properties: { text: richTextDoc, ...options.textProperties },
    },
    img_h3r0: {
      id: "img_h3r0",
      type: "image",
      parentId: "sec_h1a1",
      childrenIds: [],
      properties: {
        src: "https://example.com/images/hero.png",
        alt: "Product hero",
        ...options.imageProperties,
      },
    },
    div_l1n3: {
      id: "div_l1n3",
      type: "divider",
      parentId: "sec_h1a1",
      childrenIds: [],
      properties: options.dividerProperties,
    },
    sec_c0l2: {
      id: "sec_c0l2",
      type: "section",
      parentId: "root",
      childrenIds: ["row_tw0c"],
      properties: {},
    },
    row_tw0c: {
      id: "row_tw0c",
      type: "row",
      parentId: "sec_c0l2",
      childrenIds: ["col_l3ft", "col_r1gt"],
      properties: options.rowProperties,
    },
    col_l3ft: {
      id: "col_l3ft",
      type: "column",
      parentId: "row_tw0c",
      childrenIds: ["txt_s1d3"],
      properties: options.columnProperties[0],
    },
    txt_s1d3: {
      id: "txt_s1d3",
      type: "text",
      parentId: "col_l3ft",
      childrenIds: [],
      properties: {
        text: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Side-by-side copy." }],
            },
          ],
        },
      },
    },
    col_r1gt: {
      id: "col_r1gt",
      type: "column",
      parentId: "row_tw0c",
      childrenIds: ["btn_c2ta"],
      properties: options.columnProperties[1],
    },
    btn_c2ta: {
      id: "btn_c2ta",
      type: "button",
      parentId: "col_r1gt",
      childrenIds: [],
      properties: {
        label: "Shop the launch",
        href: "https://example.com/shop",
        ...options.buttonProperties,
      },
    },
  };
}

/** Rich globals on the root; every block relies purely on style resolution. */
export function createGlobalsOnlyFixture(): EmailDocument {
  return buildFixture({
    globals: {
      emailBackgroundColor: "#0b0b14",
      contentBackgroundColor: "#f8f7f2",
      contentWidth: 640,
      baseSpacing: 32,
      buttonBackgroundColor: "#e63946",
      buttonTextColor: "#fffdf5",
      buttonBorderRadius: 999,
      buttonBorderSize: 2,
      buttonBorderColor: "#8d0801",
      buttonHorizontalPadding: 32,
      buttonVerticalPadding: 14,
      buttonFontFamily: "Georgia, serif",
      heading1FontFamily: "Georgia, serif",
      heading1TextColor: "#1d3557",
      heading1TextAlign: "center",
      heading2FontFamily: "Georgia, serif",
      heading2TextColor: "#457b9d",
      heading2TextAlign: "center",
      heading3TextColor: "#2a2a2a",
      heading3TextAlign: "right",
      paragraphFontFamily: "Verdana, Geneva, sans-serif",
      paragraphTextColor: "#333c44",
      paragraphTextAlign: "left",
      linkTextColor: "#e63946",
      dividerColor: "#1d3557",
    },
    sectionProperties: {},
    rowProperties: {},
    columnProperties: [{}, {}],
    textProperties: {},
    buttonProperties: {},
    imageProperties: {},
    dividerProperties: {},
  });
}

/** Empty globals; every style comes from block-level overrides (or renderer defaults). */
export function createBlockOverridesOnlyFixture(): EmailDocument {
  return buildFixture({
    globals: {},
    sectionProperties: {
      innerBackgroundColor: "#fff8e7",
      outerBackgroundColor: "#22223b",
      paddingTop: 40,
      paddingBottom: 20,
      paddingLeft: 16,
      paddingRight: 16,
    },
    rowProperties: { paddingTop: 8, paddingBottom: 8 },
    columnProperties: [
      { widthPercent: 65, verticalAlign: "middle", backgroundColor: "#eef0f2", paddingRight: 12 },
      { widthPercent: 35, verticalAlign: "bottom" },
    ],
    textProperties: { textColor: "#4a4e69", textAlign: "center", paddingTop: 10, paddingBottom: 30 },
    buttonProperties: {
      backgroundColor: "#4a4e69",
      textColor: "#f2e9e4",
      borderRadius: 0,
      borderSize: 3,
      borderColor: "#9a8c98",
      horizontalPadding: 40,
      verticalPadding: 16,
      fontFamily: "Courier New, Courier, monospace",
      align: "right",
      paddingBottom: 4,
    },
    imageProperties: { width: 480, href: "https://example.com/gallery", align: "left" },
    dividerProperties: { color: "#c9ada7", thickness: 4, paddingTop: 12, paddingBottom: 12 },
  });
}

/** Globals AND block overrides together — overrides must win where both are set. */
export function createMixedFixture(): EmailDocument {
  return buildFixture({
    globals: {
      emailBackgroundColor: "#eef1f4",
      contentBackgroundColor: "#ffffff",
      contentWidth: 600,
      buttonBackgroundColor: "#0057b7",
      buttonTextColor: "#ffffff",
      heading1TextColor: "#00296b",
      heading1TextAlign: "center",
      paragraphTextColor: "#2f3e46",
      linkTextColor: "#0057b7",
      dividerColor: "#c5d1de",
    },
    sectionProperties: { outerBackgroundColor: "#00296b", paddingTop: 36 },
    rowProperties: {},
    columnProperties: [{ widthPercent: 55 }, { widthPercent: 45, verticalAlign: "middle" }],
    textProperties: { textAlign: "left" },
    buttonProperties: { backgroundColor: "#ffd500", textColor: "#00296b", align: "center" },
    imageProperties: { width: 520 },
    dividerProperties: { thickness: 2 },
  });
}
