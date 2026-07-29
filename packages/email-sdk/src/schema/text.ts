import { z } from "zod";

/**
 * Rich-text content schema — a typed, deliberately PERMISSIVE-IN-SHAPE but
 * STRICT-IN-VOCABULARY subset of Tiptap/ProseMirror JSON.
 *
 * Per docs/decisions/text-block-model.md:
 * - One text block's doc may mix headings AND paragraphs (a heading is not
 *   its own flat-map block).
 * - The doc holds ONLY text content and inline marks. Block-level styling
 *   (alignment, colors, spacing) lives on the flat-map block's properties.
 *
 * Email-safety: every object is strict — unknown node types, unknown mark
 * types, and unknown/extra attributes FAIL validation. This is intentional:
 * anything we cannot render to email-safe HTML must be rejected at the
 * boundary, not silently passed through. (E.g. Tiptap's `title` attr on link
 * marks is rejected; normalize it away before validating.)
 */

/** Bold (strong) mark. No attributes allowed. */
export const boldMarkSchema = z
  .strictObject({
    type: z.literal("bold").describe("Bold (strong emphasis) mark."),
  })
  .describe("Renders the covered text bold. Carries no attributes.");

/** Italic (emphasis) mark. No attributes allowed. */
export const italicMarkSchema = z
  .strictObject({
    type: z.literal("italic").describe("Italic (emphasis) mark."),
  })
  .describe("Renders the covered text italic. Carries no attributes.");

/** Underline mark. No attributes allowed. */
export const underlineMarkSchema = z
  .strictObject({
    type: z.literal("underline").describe("Underline mark."),
  })
  .describe("Renders the covered text underlined. Carries no attributes.");

/** Strikethrough mark. No attributes allowed. */
export const strikeMarkSchema = z
  .strictObject({
    type: z.literal("strike").describe("Strikethrough mark."),
  })
  .describe("Renders the covered text struck through. Carries no attributes.");

/**
 * Text-style mark — mirrors Tiptap's TextStyle model: ONE mark type carrying
 * span-level typography attributes (font family, text color, font size), so
 * editor JSON round-trips 1:1. Every attribute renders as plain inline CSS on
 * a <span> (email-safe). At least one attribute must be present — an empty
 * textStyle mark is meaningless and is normalized away before validation.
 */
export const textStyleMarkSchema = z
  .strictObject({
    type: z.literal("textStyle").describe("Span-level typography mark."),
    attrs: z
      .strictObject({
        fontFamily: z
          .string()
          .min(1)
          .optional()
          .describe(
            'A CSS font-family stack of email-safe fonts (e.g. "Georgia, \'Times New Roman\', serif"). Overrides the block-level font for this run only.',
          ),
        color: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Text color for this run. Any email-safe CSS color (hex recommended, e.g. "#c0392b").',
          ),
        fontSize: z
          .string()
          .regex(/^\d+px$/)
          .optional()
          .describe('Font size for this run in pixels, e.g. "18px". Pixel values only.'),
      })
      .refine((attrs) => Object.values(attrs).some((value) => value !== undefined), {
        message: "A textStyle mark must carry at least one attribute.",
      })
      .describe(
        "Typography attributes. At least one of fontFamily, color, fontSize is required.",
      ),
  })
  .describe(
    "Styles the covered text with inline typography: font family, text color, and/or font size. One mark carries all three attributes (Tiptap TextStyle model).",
  );

/** Highlight (background color) mark. `color` is required. */
export const highlightMarkSchema = z
  .strictObject({
    type: z.literal("highlight").describe("Background-color highlight mark."),
    attrs: z
      .strictObject({
        color: z
          .string()
          .min(1)
          .describe(
            'Highlight background color. Any email-safe CSS color (hex recommended, e.g. "#fff3a3").',
          ),
      })
      .describe("Highlight attributes. Only color is allowed, and it is required."),
  })
  .describe(
    "Paints a background color behind the covered text. Renders as an inline background-color span.",
  );

/** Link mark. `href` is the only allowed attribute. */
export const linkMarkSchema = z
  .strictObject({
    type: z.literal("link").describe("Hyperlink mark."),
    attrs: z
      .strictObject({
        href: z
          .string()
          .min(1)
          .describe(
            "Link destination. An absolute URL (https://…), mailto: address, or a merge tag such as *|UNSUB|*.",
          ),
      })
      .describe("Link attributes. Only href is allowed — no title, target, or class."),
  })
  .describe(
    "Turns the covered text into a hyperlink. Link color comes from globals.linkTextColor at render time.",
  );

/**
 * Any inline mark. Unknown mark types (e.g. code, subscript) fail
 * validation — the email renderer only supports this exact set.
 */
export const textMarkSchema = z
  .discriminatedUnion("type", [
    boldMarkSchema,
    italicMarkSchema,
    underlineMarkSchema,
    strikeMarkSchema,
    linkMarkSchema,
    textStyleMarkSchema,
    highlightMarkSchema,
  ])
  .describe(
    "An inline formatting mark: bold, italic, underline, strike, link, textStyle (font family / text color / font size), or highlight.",
  );

export type TextMark = z.infer<typeof textMarkSchema>;

/** A run of text with optional marks. */
export const textNodeSchema = z
  .strictObject({
    type: z.literal("text").describe("A run of plain text."),
    text: z.string().min(1).describe("The text content. Must be non-empty."),
    marks: z
      .array(textMarkSchema)
      .optional()
      .describe("Formatting marks applied to this entire run. Omit for unformatted text."),
  })
  .describe("A text run — the only node type that carries actual characters.");

export type TextNode = z.infer<typeof textNodeSchema>;

/** A hard line break within a paragraph or heading. */
export const hardBreakNodeSchema = z
  .strictObject({
    type: z.literal("hardBreak").describe("A hard line break (<br>) within the parent node."),
  })
  .describe("Forces a line break without starting a new paragraph.");

export type HardBreakNode = z.infer<typeof hardBreakNodeSchema>;

/** Any inline node: a text run or a hard break. */
export const inlineNodeSchema = z
  .discriminatedUnion("type", [textNodeSchema, hardBreakNodeSchema])
  .describe("Inline content: a text run or a hard line break.");

export type InlineNode = z.infer<typeof inlineNodeSchema>;

/** A paragraph of inline content. */
export const paragraphNodeSchema = z
  .strictObject({
    type: z.literal("paragraph").describe("A paragraph."),
    content: z
      .array(inlineNodeSchema)
      .optional()
      .describe("Inline content in reading order. Omit for an empty paragraph."),
  })
  .describe(
    "A paragraph. Styled at render time from globals.paragraph* plus the owning text block's overrides.",
  );

export type ParagraphNode = z.infer<typeof paragraphNodeSchema>;

/** A heading (levels 1–3) of inline content. */
export const headingNodeSchema = z
  .strictObject({
    type: z.literal("heading").describe("A heading."),
    attrs: z
      .strictObject({
        level: z
          .union([z.literal(1), z.literal(2), z.literal(3)])
          .describe("Heading level: 1, 2, or 3. Levels 4+ are not supported."),
      })
      .describe("Heading attributes. Only level is allowed."),
    content: z
      .array(inlineNodeSchema)
      .optional()
      .describe("Inline content in reading order. Omit for an empty heading."),
  })
  .describe(
    "A heading. Styled at render time from the level-matching globals.heading{1..3}* fields plus the owning text block's overrides.",
  );

export type HeadingNode = z.infer<typeof headingNodeSchema>;

/** Any block-level node inside a text doc: heading or paragraph. */
export const textBlockNodeSchema = z
  .discriminatedUnion("type", [headingNodeSchema, paragraphNodeSchema])
  .describe("A block-level rich-text node: heading or paragraph.");

export type TextBlockNode = z.infer<typeof textBlockNodeSchema>;

/**
 * The full rich-text document stored in a text block's `properties.text`.
 * One doc per text block; may freely mix headings and paragraphs.
 */
export const textDocSchema = z
  .strictObject({
    type: z.literal("doc").describe("Tiptap document wrapper. Always the literal \"doc\"."),
    content: z
      .array(textBlockNodeSchema)
      .min(1)
      .describe(
        "Block-level nodes in reading order. At least one node — an empty text block is a doc with one empty paragraph.",
      ),
  })
  .describe(
    "A Tiptap/ProseMirror rich-text document. Holds ONLY text content and inline marks — block-level styling (alignment, color, padding) lives on the flat-map text block.",
  );

export type TextDoc = z.infer<typeof textDocSchema>;

/** A minimal valid text doc: one paragraph containing the given text (or empty). */
export function createTextDoc(text?: string): TextDoc {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        ...(text !== undefined && text.length > 0
          ? { content: [{ type: "text", text }] }
          : {}),
      },
    ],
  };
}
