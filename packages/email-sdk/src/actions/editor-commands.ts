import { z } from "zod";

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

// --- Union -------------------------------------------------------------------

/** Any editor command — the versioned Zod contract for the data-parts channel. */
export const editorCommandSchema = z
  .discriminatedUnion("type", [showPreviewCommandSchema, sendTestEmailCommandSchema])
  .describe("Any editor UI command, discriminated by its type field.");

export type EditorCommand = z.infer<typeof editorCommandSchema>;
