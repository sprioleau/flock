import { z } from "zod";
import {
  buttonBlockIdSchema,
  codeBlockIdSchema,
  columnBlockIdSchema,
  dividerBlockIdSchema,
  imageBlockIdSchema,
  leafBlockIdSchema,
  linkBlockIdSchema,
  rootBlockIdSchema,
  rowBlockIdSchema,
  sectionBlockIdSchema,
  spacerBlockIdSchema,
  textBlockIdSchema,
} from "./ids";
import { globalStylesSchema, textAlignSchema } from "./globals";
import { textDocSchema } from "./text";

/*
  Block schemas — a Zod discriminated union on `type`.

  Base shape for every block: `{ id, type, parentId, childrenIds, properties }`.
  The flat map owns structure and ALL block-level styling; rich text lives
  only in `text.properties.text` (docs/decisions/text-block-model.md).

  Block vocabulary maps to React Email components:
    root → Container semantics · section → Section · row → Row ·
    column → Column · text → Heading/Text · button → Button ·
    image → Img · divider → Hr · link → Link · code → CodeBlock ·
    spacer → an email-safe fixed-height cell (no RE primitive)

  Nesting (also enforced structurally by the integrity checker):
    root > section > (row | leaf) · row > column > leaf

  Every property is an explicit named field with a `.describe()` — no loose
  style objects. Descriptions are the LLM's documentation.
*/

const padding = (side: string, around: string) =>
  z
    .number()
    .min(0)
    .optional()
    .describe(
      `Padding in pixels on the ${side} ${around}. Omit to let the renderer use globals.baseSpacing-derived defaults.`,
    );

const blockPaddingFields = (noun: string) => ({
  paddingTop: padding("top", `of this ${noun}`),
  paddingBottom: padding("bottom", `of this ${noun}`),
  paddingLeft: padding("left", `of this ${noun}`),
  paddingRight: padding("right", `of this ${noun}`),
});

const emptyChildrenIds = (noun: string) =>
  z
    .array(z.never())
    .length(0)
    .describe(`Always empty — ${noun} blocks are leaves and cannot have children.`);

/*
  Border line styles blocks may use — the CSS keywords every mail client
  renders the same way, plus "none" as an explicit off switch that keeps the
  width/color values around.

  Deliberately excluded: `hidden` (a collapsed-table-only synonym for "none"),
  and `groove` / `ridge` / `inset` / `outset` (faux-3D borders that need a
  derived light/dark pair of the base color, which Word-engine Outlook does
  not compute — they degrade to a flat solid line there, so offering them
  would promise a look the medium cannot keep).
*/
export const BORDER_STYLES = ["solid", "dashed", "dotted", "double", "none"] as const;

export type BorderStyle = (typeof BORDER_STYLES)[number];

export const borderStyleSchema = z
  .enum(BORDER_STYLES)
  .describe(
    'Border line style: "solid", "dashed", "dotted", "double", or "none" (no line drawn, whatever the width).',
  );

/*
  ---------------------------------------------------------------------------
  Containers
  ---------------------------------------------------------------------------
*/

/*
  The document root. Exactly one per document; id is literally "root".
*/
export const rootBlockSchema = z
  .strictObject({
    id: rootBlockIdSchema,
    type: z.literal("root").describe("Block type discriminator."),
    parentId: z.null().describe("Always null — the root block has no parent."),
    childrenIds: z
      .array(sectionBlockIdSchema)
      .describe("Ordered ids of the document's top-level sections. Only sections may be direct children of the root."),
    properties: z
      .strictObject({
        globals: globalStylesSchema
          .optional()
          .describe(
            "Document-wide styles resolved beneath block-level overrides at render time. Omit for all renderer defaults.",
          ),
      })
      .describe("Root properties: the document-wide global styles."),
  })
  .describe(
    'The document root. Carries global styles and the ordered list of sections. There is exactly one, with id "root".',
  );

export type RootBlock = z.infer<typeof rootBlockSchema>;

/*
  A full-width horizontal band of the email. Maps to React Email Section.
*/
export const sectionBlockSchema = z
  .strictObject({
    id: sectionBlockIdSchema,
    type: z.literal("section").describe("Block type discriminator."),
    parentId: rootBlockIdSchema.describe('Sections always live directly under the root, so this is always "root".'),
    childrenIds: z
      .array(z.union([rowBlockIdSchema, leafBlockIdSchema]))
      .describe(
        "Ordered ids of this section's children: rows (for multi-column layout) and/or leaf blocks (text, button, image, divider, link, code, spacer), top to bottom.",
      ),
    properties: z
      .strictObject({
        innerBackgroundColor: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Background color of this section's content area. Omit to inherit globals.contentBackgroundColor.",
          ),
        outerBackgroundColor: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Background color behind this section, outside the content area. Omit to inherit globals.emailBackgroundColor.",
          ),
        ...blockPaddingFields("section"),
      })
      .describe("Section-level style overrides. Only set fields that differ from the globals."),
  })
  .describe(
    "A full-width horizontal band of the email (header, hero, footer, …). Maps to React Email's Section.",
  );

export type SectionBlock = z.infer<typeof sectionBlockSchema>;

/*
  A horizontal group of columns inside a section. Maps to React Email Row.
*/
export const rowBlockSchema = z
  .strictObject({
    id: rowBlockIdSchema,
    type: z.literal("row").describe("Block type discriminator."),
    parentId: sectionBlockIdSchema.describe("Id of the section this row belongs to."),
    childrenIds: z
      .array(columnBlockIdSchema)
      .describe("Ordered ids of this row's columns, left to right. Rows may only contain columns."),
    properties: z
      .strictObject({
        backgroundColor: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Background color filling this row's full width, padding included — the band behind a side-by-side group. Omit for transparent (the section background shows through).",
          ),
        ...blockPaddingFields("row"),
      })
      .describe("Row-level style overrides."),
  })
  .describe(
    "A horizontal group of side-by-side columns inside a section. Maps to React Email's Row. Use only when content must sit side by side; single-column content goes directly in the section.",
  );

export type RowBlock = z.infer<typeof rowBlockSchema>;

/*
  A vertical slice of a row holding leaf blocks. Maps to React Email Column.
*/
export const columnBlockSchema = z
  .strictObject({
    id: columnBlockIdSchema,
    type: z.literal("column").describe("Block type discriminator."),
    parentId: rowBlockIdSchema.describe("Id of the row this column belongs to."),
    childrenIds: z
      .array(leafBlockIdSchema)
      .describe(
        "Ordered ids of this column's leaf blocks (text, button, image, divider, link, code, spacer), top to bottom. Columns may not contain rows or sections.",
      ),
    properties: z
      .strictObject({
        widthPercent: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "This column's share of the row width as a percentage (1–100). Omit on every column in a row for an equal split. Set widths in a row should sum to 100.",
          ),
        verticalAlign: z
          .enum(["top", "middle", "bottom"])
          .optional()
          .describe(
            'Vertical alignment of this column\'s content relative to sibling columns: "top", "middle", or "bottom". Renderer default: "top".',
          ),
        backgroundColor: z
          .string()
          .min(1)
          .optional()
          .describe("Background color of this column. Omit for transparent (the section background shows through)."),
        ...blockPaddingFields("column"),
      })
      .describe("Column-level style overrides."),
  })
  .describe("A vertical slice of a row. Maps to React Email's Column. Holds leaf blocks only.");

export type ColumnBlock = z.infer<typeof columnBlockSchema>;

/*
  ---------------------------------------------------------------------------
  Leaves
  ---------------------------------------------------------------------------
*/

/*
  Rich text (mixed headings and paragraphs). Renders to Heading/Text.
*/
export const textBlockSchema = z
  .strictObject({
    id: textBlockIdSchema,
    type: z.literal("text").describe("Block type discriminator."),
    parentId: z
      .union([sectionBlockIdSchema, columnBlockIdSchema])
      .describe("Id of the section or column containing this text block."),
    childrenIds: emptyChildrenIds("text"),
    properties: z
      .strictObject({
        text: textDocSchema,
        textAlign: textAlignSchema
          .optional()
          .describe(
            "Overrides the heading/paragraph alignment globals for every node in this block. Omit to use the per-node-type globals.",
          ),
        textColor: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Overrides the heading/paragraph text-color globals for every node in this block. Omit to use the per-node-type globals.",
          ),
        backgroundColor: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Background color filling this text block's bounds, padding included — the callout/highlight treatment. Omit for transparent (the container background shows through).",
          ),
        ...blockPaddingFields("text block"),
      })
      .describe(
        "Text block properties. The rich-text doc holds content and inline marks only; alignment, color, and padding are block properties here.",
      ),
  })
  .describe(
    "A rich-text block whose doc may mix headings (levels 1–3) and paragraphs. Renders to React Email Heading/Text elements.",
  );

export type TextBlock = z.infer<typeof textBlockSchema>;

/*
  A call-to-action button. Maps to React Email Button.
*/
export const buttonBlockSchema = z
  .strictObject({
    id: buttonBlockIdSchema,
    type: z.literal("button").describe("Block type discriminator."),
    parentId: z
      .union([sectionBlockIdSchema, columnBlockIdSchema])
      .describe("Id of the section or column containing this button."),
    childrenIds: emptyChildrenIds("button"),
    properties: z
      .strictObject({
        label: z.string().min(1).describe("The visible button text. Plain text only — no rich text inside buttons."),
        href: z
          .string()
          .min(1)
          .describe("Destination when the button is clicked: an absolute URL, mailto: address, or merge tag."),
        backgroundColor: z
          .string()
          .min(1)
          .optional()
          .describe("Overrides globals.buttonBackgroundColor for this button only."),
        textColor: z
          .string()
          .min(1)
          .optional()
          .describe("Overrides globals.buttonTextColor for this button only."),
        borderRadius: z
          .number()
          .min(0)
          .optional()
          .describe("Overrides globals.buttonBorderRadius (pixels) for this button only."),
        borderSize: z
          .number()
          .min(0)
          .optional()
          .describe("Overrides globals.buttonBorderSize (pixels) for this button only."),
        borderColor: z
          .string()
          .min(1)
          .optional()
          .describe("Overrides globals.buttonBorderColor for this button only."),
        borderStyle: borderStyleSchema
          .optional()
          .describe(
            'Line style of the button border, drawn only when the border size is above 0. Renderer default: "solid".',
          ),
        horizontalPadding: z
          .number()
          .min(0)
          .optional()
          .describe(
            "Overrides globals.buttonHorizontalPadding: pixels inside the button, left and right of the label.",
          ),
        verticalPadding: z
          .number()
          .min(0)
          .optional()
          .describe(
            "Overrides globals.buttonVerticalPadding: pixels inside the button, above and below the label.",
          ),
        fontFamily: z
          .string()
          .min(1)
          .optional()
          .describe("Overrides globals.buttonFontFamily for this button only."),
        align: textAlignSchema
          .optional()
          .describe(
            'Horizontal placement of the button within its container: "left", "center", or "right". Renderer default: "left".',
          ),
        ...blockPaddingFields("button block"),
      })
      .describe(
        "Button properties. label and href are required; style fields override the button globals for this button only.",
      ),
  })
  .describe("A call-to-action button. Maps to React Email's Button (a styled link).");

export type ButtonBlock = z.infer<typeof buttonBlockSchema>;

/*
  An image, optionally linked. Maps to React Email Img.
*/
export const imageBlockSchema = z
  .strictObject({
    id: imageBlockIdSchema,
    type: z.literal("image").describe("Block type discriminator."),
    parentId: z
      .union([sectionBlockIdSchema, columnBlockIdSchema])
      .describe("Id of the section or column containing this image."),
    childrenIds: emptyChildrenIds("image"),
    properties: z
      .strictObject({
        src: z
          .string()
          .min(1)
          .describe("Absolute URL of the image (https://…). Email clients cannot load relative or data: URLs reliably."),
        alt: z
          .string()
          .describe(
            "Alternative text for accessibility and blocked-image fallback. Use an empty string only for purely decorative images.",
          ),
        width: z
          .number()
          .positive()
          .optional()
          .describe(
            "Display width in pixels. Omit to render at natural width capped to the content width. Height scales to preserve aspect ratio.",
          ),
        href: z
          .string()
          .min(1)
          .optional()
          .describe("Makes the image a link to this absolute URL. Omit for a non-clickable image."),
        align: textAlignSchema
          .optional()
          .describe(
            'Horizontal placement of the image within its container: "left", "center", or "right". Renderer default: "center".',
          ),
        backgroundColor: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Background color filling this image block's bounds around the image — visible through the block padding and wherever the image is narrower than the block. Omit for transparent (the container background shows through).",
          ),
        borderRadius: z
          .number()
          .min(0)
          .optional()
          .describe(
            "Corner radius of the image in pixels. Overrides globals.imageBorderRadius for this image only. Word-engine Outlook squares rounded corners off (same limitation as button corners), so treat it as a progressive enhancement.",
          ),
        borderWidth: z
          .number()
          .min(0)
          .optional()
          .describe("Border width around the image in pixels. Renderer default: 0 (no border)."),
        borderStyle: borderStyleSchema
          .optional()
          .describe(
            'Line style of the image border, drawn only when the border width is above 0. Renderer default: "solid".',
          ),
        borderColor: z
          .string()
          .min(1)
          .optional()
          .describe('Border color of the image. Renderer default: "#000000".'),
        role: z
          .literal("logo")
          .optional()
          .describe(
            'Semantic marker, not a visual property: "logo" tags this image as the brand logo. Brand propagation re-sources role-marked images to the brand kit\'s confirmed logo when the brand is applied or updated. Omit for regular images.',
          ),
        ...blockPaddingFields("image block"),
      })
      .describe("Image properties. src is required; alt is required (may be empty for decorative images)."),
  })
  .describe("An image, optionally wrapped in a link. Maps to React Email's Img.");

export type ImageBlock = z.infer<typeof imageBlockSchema>;

/*
  A horizontal rule. Maps to React Email Hr.
*/
export const dividerBlockSchema = z
  .strictObject({
    id: dividerBlockIdSchema,
    type: z.literal("divider").describe("Block type discriminator."),
    parentId: z
      .union([sectionBlockIdSchema, columnBlockIdSchema])
      .describe("Id of the section or column containing this divider."),
    childrenIds: emptyChildrenIds("divider"),
    properties: z
      .strictObject({
        color: z
          .string()
          .min(1)
          .optional()
          .describe("Overrides globals.dividerColor for this divider only."),
        thickness: z
          .number()
          .positive()
          .optional()
          .describe("Line thickness in pixels. Renderer default: 1."),
        ...blockPaddingFields("divider block"),
      })
      .describe("Divider properties."),
  })
  .describe("A horizontal separator line. Maps to React Email's Hr.");

export type DividerBlock = z.infer<typeof dividerBlockSchema>;

/*
  Languages the code block can highlight — a curated, developer-recognizable
  subset of React Email's Prism languages, kept small so agent-facing tool
  schemas stay readable.
*/
export const CODE_BLOCK_LANGUAGES = [
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "diff",
  "go",
  "graphql",
  "html",
  "java",
  "javascript",
  "json",
  "jsx",
  "kotlin",
  "markdown",
  "php",
  "python",
  "ruby",
  "rust",
  "sql",
  "swift",
  "tsx",
  "typescript",
  "yaml",
] as const;

export type CodeBlockLanguage = (typeof CODE_BLOCK_LANGUAGES)[number];

/*
  Color scheme names for the code block, mapped to Prism themes by the renderer.
*/
export const CODE_BLOCK_THEMES = ["light", "dark"] as const;

export type CodeBlockTheme = (typeof CODE_BLOCK_THEMES)[number];

/*
  A standalone styled hyperlink. Maps to React Email Link.
*/
export const linkBlockSchema = z
  .strictObject({
    id: linkBlockIdSchema,
    type: z.literal("link").describe("Block type discriminator."),
    parentId: z
      .union([sectionBlockIdSchema, columnBlockIdSchema])
      .describe("Id of the section or column containing this link."),
    childrenIds: emptyChildrenIds("link"),
    properties: z
      .strictObject({
        text: z.string().min(1).describe("The visible link text. Plain text only."),
        href: z
          .string()
          .min(1)
          .describe("Destination when the link is clicked: an absolute URL, mailto: address, or merge tag."),
        textColor: z
          .string()
          .min(1)
          .optional()
          .describe("Overrides globals.linkTextColor for this link only."),
        fontFamily: z
          .string()
          .min(1)
          .optional()
          .describe("Overrides globals.paragraphFontFamily for this link only."),
        fontSize: z
          .number()
          .positive()
          .optional()
          .describe("Font size in pixels. Renderer default: 14."),
        isUnderlined: z
          .boolean()
          .optional()
          .describe("Whether the link text is underlined. Renderer default: true."),
        align: textAlignSchema
          .optional()
          .describe(
            'Horizontal placement of the link within its container: "left", "center", or "right". Renderer default: "left".',
          ),
        ...blockPaddingFields("link block"),
      })
      .describe(
        "Link properties. text and href are required; style fields override the link/paragraph globals for this link only.",
      ),
  })
  .describe(
    "A standalone styled hyperlink on its own line (e.g. \"View in browser\", \"Unsubscribe\"). Maps to React Email's Link. For a link inside flowing prose, use a link mark in a text block; for a prominent call to action, use a button.",
  );

export type LinkBlock = z.infer<typeof linkBlockSchema>;

/*
  A syntax-highlighted code snippet. Maps to React Email CodeBlock.
*/
export const codeBlockSchema = z
  .strictObject({
    id: codeBlockIdSchema,
    type: z.literal("code").describe("Block type discriminator."),
    parentId: z
      .union([sectionBlockIdSchema, columnBlockIdSchema])
      .describe("Id of the section or column containing this code block."),
    childrenIds: emptyChildrenIds("code"),
    properties: z
      .strictObject({
        code: z
          .string()
          .min(1)
          .describe("The source code to display, verbatim (newlines preserved)."),
        language: z
          .enum(CODE_BLOCK_LANGUAGES)
          .describe("Language for syntax highlighting."),
        theme: z
          .enum(CODE_BLOCK_THEMES)
          .optional()
          .describe(
            'Color scheme of the snippet: "light" or "dark". The renderer maps each to a matching Prism theme with inline, email-safe styles. Renderer default: "dark".',
          ),
        shouldShowLineNumbers: z
          .boolean()
          .optional()
          .describe("Whether to show line numbers in the gutter. Renderer default: false."),
        ...blockPaddingFields("code block"),
      })
      .describe("Code block properties. code and language are required."),
  })
  .describe(
    "A syntax-highlighted code snippet rendered with inline, email-safe styles. Maps to React Email's CodeBlock.",
  );

export type CodeBlock = z.infer<typeof codeBlockSchema>;

/*
  Fixed vertical whitespace. Rendered as an email-safe fixed-height cell.
*/
export const spacerBlockSchema = z
  .strictObject({
    id: spacerBlockIdSchema,
    type: z.literal("spacer").describe("Block type discriminator."),
    parentId: z
      .union([sectionBlockIdSchema, columnBlockIdSchema])
      .describe("Id of the section or column containing this spacer."),
    childrenIds: emptyChildrenIds("spacer"),
    properties: z
      .strictObject({
        height: z
          .number()
          .positive()
          .describe("Height of the gap in pixels."),
      })
      .describe("Spacer properties: just the gap height. Spacers are transparent — the container background shows through."),
  })
  .describe(
    "Fixed vertical whitespace between blocks. React Email has no Spacer primitive, so this renders as the email-safe idiom: a fixed-height table cell. Use it for explicit vertical rhythm beyond the padding-based defaults.",
  );

export type SpacerBlock = z.infer<typeof spacerBlockSchema>;

/*
  ---------------------------------------------------------------------------
  Union
  ---------------------------------------------------------------------------
*/

/*
  Any block — discriminated union on `type`.
*/
export const blockSchema = z
  .discriminatedUnion("type", [
    rootBlockSchema,
    sectionBlockSchema,
    rowBlockSchema,
    columnBlockSchema,
    textBlockSchema,
    buttonBlockSchema,
    imageBlockSchema,
    dividerBlockSchema,
    linkBlockSchema,
    codeBlockSchema,
    spacerBlockSchema,
  ])
  .describe("Any block in the email document, discriminated by its type field.");

export type Block = z.infer<typeof blockSchema>;

/*
  Any container block (may have children).
*/
export type ContainerBlock = RootBlock | SectionBlock | RowBlock | ColumnBlock;

/*
  Any leaf block (never has children).
*/
export type LeafBlock =
  | TextBlock
  | ButtonBlock
  | ImageBlock
  | DividerBlock
  | LinkBlock
  | CodeBlock
  | SpacerBlock;
