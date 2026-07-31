import { z } from "zod";
import { imageBlockIdSchema } from "../schema/ids";

/**
 * Editor commands — the typed client-command channel (plan §3.4).
 *
 * `kind: "editor"` actions have NO document effect. Their `run` produces one
 * of these command payloads, which Phase 3 transports to the frontend as
 * streamed data parts; a frontend dispatcher executes them against the editor
 * UI (flip the viewport, trigger a test send, …). This discriminated union is
 * the versioned contract shared by both ends — extend it here when adding a
 * new editor action.
 */

// --- showPreview -------------------------------------------------------------

export const PREVIEW_MODES = ["desktop", "mobile"] as const;

export const previewModeSchema = z
  .enum(PREVIEW_MODES)
  .describe('Canvas viewport to preview: "desktop" (600px content) or "mobile".');

export type PreviewMode = z.infer<typeof previewModeSchema>;

export const showPreviewInputSchema = z
  .strictObject({
    mode: previewModeSchema,
  })
  .describe("Switches the editor canvas preview between desktop and mobile viewports.");

export type ShowPreviewInput = z.infer<typeof showPreviewInputSchema>;

export const showPreviewCommandSchema = z
  .strictObject({
    type: z.literal("showPreview").describe("Command discriminator."),
    mode: previewModeSchema,
  })
  .describe("Client command: switch the canvas preview viewport.");

export type ShowPreviewCommand = z.infer<typeof showPreviewCommandSchema>;

// --- sendTestEmail -------------------------------------------------------------

export const sendTestEmailInputSchema = z
  .strictObject({
    to: z.email().describe("Recipient email address for the test send."),
  })
  .describe(
    "Sends a test version of the current email to one recipient for review. Gated behind human approval.",
  );

export type SendTestEmailInput = z.infer<typeof sendTestEmailInputSchema>;

export const sendTestEmailCommandSchema = z
  .strictObject({
    type: z.literal("sendTestEmail").describe("Command discriminator."),
    to: z.email().describe("Recipient email address for the test send."),
  })
  .describe("Client command: send a test email (Phase 8 wires this to Resend).");

export type SendTestEmailCommand = z.infer<typeof sendTestEmailCommandSchema>;

// --- generateImage -------------------------------------------------------------

/** Longest prompt accepted for image generation (intent-level, model-facing). */
export const GENERATE_IMAGE_MAX_PROMPT_LENGTH = 2000;

export const generateImageInputSchema = z
  .strictObject({
    blockId: imageBlockIdSchema.describe(
      'Id of the EXISTING image block to fill, exactly as it appears in the document (e.g. "img_x9k3").',
    ),
    prompt: z
      .string()
      .min(1)
      .max(GENERATE_IMAGE_MAX_PROMPT_LENGTH)
      .describe(
        "Text prompt describing the image to generate (subject, style, mood). Also used to derive the block's alt text.",
      ),
  })
  .describe(
    "Generates an AI image from a text prompt and sets it as an existing image block's source. " +
      "The image is generated and stored server-side; the block's src and alt then update in one operation.",
  );

export type GenerateImageInput = z.infer<typeof generateImageInputSchema>;

/**
 * The generateImage command travels the data-parts channel in two states:
 * `run` produces the UNFULFILLED intent ({ blockId, prompt }); the app-side
 * executor generates the image, uploads it to durable storage, and streams the
 * FULFILLED command (src + alt present). The client dispatcher commits the
 * fulfilled command as one updateBlockProperties operation through the normal
 * validated dispatch spine — image bytes/data URIs never enter the document.
 */
export const generateImageCommandSchema = z
  .strictObject({
    type: z.literal("generateImage").describe("Command discriminator."),
    blockId: imageBlockIdSchema.describe("Id of the image block receiving the generated image."),
    prompt: z.string().min(1).describe("The prompt the image was generated from."),
    src: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Durable https URL of the generated image (present once the executor has stored it).",
      ),
    alt: z
      .string()
      .optional()
      .describe("Alt text derived from the prompt (present once fulfilled)."),
  })
  .describe("Client command: apply a generated image (durable URL + alt) to an image block.");

export type GenerateImageCommand = z.infer<typeof generateImageCommandSchema>;

// --- Union -------------------------------------------------------------------

/** Any editor command — the versioned Zod contract for the data-parts channel. */
export const editorCommandSchema = z
  .discriminatedUnion("type", [
    showPreviewCommandSchema,
    sendTestEmailCommandSchema,
    generateImageCommandSchema,
  ])
  .describe("Any editor UI command, discriminated by its type field.");

export type EditorCommand = z.infer<typeof editorCommandSchema>;
