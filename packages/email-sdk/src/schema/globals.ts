import { z } from "zod";

/**
 * Global styles — block-type-scoped defaults carried on
 * `root.properties.globals` and resolved at render time as
 * `globals → block-level overrides` (docs/decisions/canvas-architecture.md).
 *
 * Every field is optional. When a field is absent the renderer falls back to
 * the matching value in DEFAULT_GLOBAL_STYLES (exported below), so the
 * defaults documented in each `.describe()` are a contract with the Phase 1.4
 * renderer, not just prose.
 *
 * A theme switch is a single operation replacing this one object.
 */

const cssColor = (what: string, fallback: string) =>
  z
    .string()
    .min(1)
    .describe(`${what} Any email-safe CSS color (hex recommended, e.g. "#1a1a2e"). Renderer default: ${fallback}.`);

const fontFamily = (what: string, fallback: string) =>
  z
    .string()
    .min(1)
    .describe(
      `${what} A CSS font-family stack of email-safe fonts. Renderer default: "${fallback}".`,
    );

/** Horizontal text alignment. */
export const textAlignSchema = z
  .enum(["left", "center", "right"])
  .describe('Horizontal alignment: "left", "center", or "right".');

export type TextAlign = z.infer<typeof textAlignSchema>;

const textAlign = (what: string, fallback: TextAlign) =>
  textAlignSchema.describe(
    `${what} One of "left", "center", "right". Renderer default: "${fallback}".`,
  );

const DEFAULT_FONT_STACK = "Helvetica, Arial, sans-serif";

/**
 * Schema for `root.properties.globals`. Strict: unknown keys fail validation.
 */
export const globalStylesSchema = z
  .strictObject({
    // Canvas
    emailBackgroundColor: cssColor(
      "Background color of the email canvas, behind the centered content area.",
      '"#f4f4f4"',
    ).optional(),
    contentBackgroundColor: cssColor(
      "Background color of the centered content area that sections sit on.",
      '"#ffffff"',
    ).optional(),
    contentWidth: z
      .number()
      .int()
      .min(280)
      .max(900)
      .optional()
      .describe(
        "Width of the centered content area in pixels (280–900). Renderer default: 600 — the email-client-safe standard.",
      ),
    baseSpacing: z
      .number()
      .min(0)
      .optional()
      .describe(
        "Base vertical spacing unit in pixels used between blocks when a block sets no explicit padding. Renderer default: 24.",
      ),

    // Buttons
    buttonBackgroundColor: cssColor("Fill color of all buttons.", '"#000000"').optional(),
    buttonTextColor: cssColor("Label text color of all buttons.", '"#ffffff"').optional(),
    buttonBorderRadius: z
      .number()
      .min(0)
      .optional()
      .describe("Corner radius of all buttons in pixels. Renderer default: 4."),
    buttonBorderSize: z
      .number()
      .min(0)
      .optional()
      .describe("Border width of all buttons in pixels. Renderer default: 0 (no border)."),
    buttonBorderColor: cssColor("Border color of all buttons.", '"#000000"').optional(),
    buttonHorizontalPadding: z
      .number()
      .min(0)
      .optional()
      .describe(
        "Horizontal padding inside all buttons in pixels (left and right of the label). Renderer default: 24.",
      ),
    buttonVerticalPadding: z
      .number()
      .min(0)
      .optional()
      .describe(
        "Vertical padding inside all buttons in pixels (above and below the label). Renderer default: 12.",
      ),
    buttonFontFamily: fontFamily("Font of all button labels.", DEFAULT_FONT_STACK).optional(),

    // Headings (levels 1–3, matching heading nodes inside text blocks)
    heading1FontFamily: fontFamily("Font of level-1 headings.", DEFAULT_FONT_STACK).optional(),
    heading1TextColor: cssColor("Text color of level-1 headings.", '"#111111"').optional(),
    heading1TextAlign: textAlign("Alignment of level-1 headings.", "left").optional(),
    heading2FontFamily: fontFamily("Font of level-2 headings.", DEFAULT_FONT_STACK).optional(),
    heading2TextColor: cssColor("Text color of level-2 headings.", '"#111111"').optional(),
    heading2TextAlign: textAlign("Alignment of level-2 headings.", "left").optional(),
    heading3FontFamily: fontFamily("Font of level-3 headings.", DEFAULT_FONT_STACK).optional(),
    heading3TextColor: cssColor("Text color of level-3 headings.", '"#111111"').optional(),
    heading3TextAlign: textAlign("Alignment of level-3 headings.", "left").optional(),

    // Paragraphs
    paragraphFontFamily: fontFamily("Font of paragraph text.", DEFAULT_FONT_STACK).optional(),
    paragraphTextColor: cssColor("Text color of paragraph text.", '"#333333"').optional(),
    paragraphTextAlign: textAlign("Alignment of paragraph text.", "left").optional(),

    // Inline / misc
    linkTextColor: cssColor("Color of hyperlinks inside text blocks.", '"#067df7"').optional(),
    dividerColor: cssColor("Line color of all divider blocks.", '"#e6e6e6"').optional(),
  })
  .describe(
    "Block-type-scoped global styles for the whole email, carried on the root block and resolved at render time beneath block-level overrides. Replacing this object applies a theme.",
  );

export type GlobalStyles = z.infer<typeof globalStylesSchema>;

/**
 * The renderer's fallback for every global style field. Blocks resolve final
 * styles as: DEFAULT_GLOBAL_STYLES → root.properties.globals → block overrides.
 */
export const DEFAULT_GLOBAL_STYLES: Required<GlobalStyles> = {
  emailBackgroundColor: "#f4f4f4",
  contentBackgroundColor: "#ffffff",
  contentWidth: 600,
  baseSpacing: 24,
  buttonBackgroundColor: "#000000",
  buttonTextColor: "#ffffff",
  buttonBorderRadius: 4,
  buttonBorderSize: 0,
  buttonBorderColor: "#000000",
  buttonHorizontalPadding: 24,
  buttonVerticalPadding: 12,
  buttonFontFamily: DEFAULT_FONT_STACK,
  heading1FontFamily: DEFAULT_FONT_STACK,
  heading1TextColor: "#111111",
  heading1TextAlign: "left",
  heading2FontFamily: DEFAULT_FONT_STACK,
  heading2TextColor: "#111111",
  heading2TextAlign: "left",
  heading3FontFamily: DEFAULT_FONT_STACK,
  heading3TextColor: "#111111",
  heading3TextAlign: "left",
  paragraphFontFamily: DEFAULT_FONT_STACK,
  paragraphTextColor: "#333333",
  paragraphTextAlign: "left",
  linkTextColor: "#067df7",
  dividerColor: "#e6e6e6",
};
