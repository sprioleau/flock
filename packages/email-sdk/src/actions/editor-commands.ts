import { z } from "zod";
import { imageBlockIdSchema } from "../schema/ids";
import { createDraftCommandSchema } from "./compose-draft";
import { applyThemeToDraftCommandSchema } from "./theme-target";

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

// --- openPanel -----------------------------------------------------------------

/**
 * The UI surfaces the agent can open on the user's behalf — one enum value per
 * named surface in the studio (dialogs, the history sheet, the right-rail
 * tabs). The client's ui-surfaces module store maps each value to the actual
 * open mechanism; extend BOTH ends when adding a surface.
 */
export const UI_PANELS = [
  "theme",
  "brand-kit",
  "library",
  "agents",
  "recommendations",
  "history",
  "blocks",
  "properties",
  "send-test",
] as const;

export const uiPanelSchema = z
  .enum(UI_PANELS)
  .describe(
    'UI surface to open: "theme" (theme picker), "brand-kit", "library" (the asset library: saved sections + images), ' +
      '"agents" (advisory persona picker), "recommendations" (persona recommendations history), ' +
      '"history" (version history), "blocks" (add-blocks tab), "properties" (selected-block properties tab), ' +
      'or "send-test" (send-test-email dialog).',
  );

export type UiPanel = z.infer<typeof uiPanelSchema>;

export const openPanelInputSchema = z
  .strictObject({
    panel: uiPanelSchema,
  })
  .describe("Opens one of the editor's UI panels or dialogs for the user.");

export type OpenPanelInput = z.infer<typeof openPanelInputSchema>;

export const openPanelCommandSchema = z
  .strictObject({
    type: z.literal("openPanel").describe("Command discriminator."),
    panel: uiPanelSchema,
  })
  .describe("Client command: open a named editor UI surface.");

export type OpenPanelCommand = z.infer<typeof openPanelCommandSchema>;

// --- undo / redo ---------------------------------------------------------------

export const undoInputSchema = z
  .strictObject({})
  .describe("Undoes the most recent change to the email document, exactly like the toolbar's Undo button.");

export type UndoInput = z.infer<typeof undoInputSchema>;

export const undoCommandSchema = z
  .strictObject({
    type: z.literal("undo").describe("Command discriminator."),
  })
  .describe("Client command: undo the most recent document change (the toolbar Undo path).");

export type UndoCommand = z.infer<typeof undoCommandSchema>;

export const redoInputSchema = z
  .strictObject({})
  .describe("Reapplies the most recently undone change, exactly like the toolbar's Redo button.");

export type RedoInput = z.infer<typeof redoInputSchema>;

export const redoCommandSchema = z
  .strictObject({
    type: z.literal("redo").describe("Command discriminator."),
  })
  .describe("Client command: redo the most recently undone change (the toolbar Redo path).");

export type RedoCommand = z.infer<typeof redoCommandSchema>;

// --- goToVersion ---------------------------------------------------------------

export const goToVersionInputSchema = z
  .strictObject({
    version: z
      .int()
      .min(0)
      .describe("The version number to restore, as shown in the version history panel."),
  })
  .describe(
    "Restores the email document to an earlier version from the version history. " +
      "The restore itself becomes a new history entry (nothing is lost). Requires human approval.",
  );

export type GoToVersionInput = z.infer<typeof goToVersionInputSchema>;

export const goToVersionCommandSchema = z
  .strictObject({
    type: z.literal("goToVersion").describe("Command discriminator."),
    version: z.int().min(0).describe("The version number being restored."),
  })
  .describe("Client command: restore the document to a numbered history version.");

export type GoToVersionCommand = z.infer<typeof goToVersionCommandSchema>;

// --- createDraft ---------------------------------------------------------------
//
// The createDraft input/command pair lives in ./compose-draft, next to the
// plan→operations translation that gives it meaning (a composed draft is a
// whole email, themed and content-aware). Re-exported here so the editor
// command channel still reads as one file.

export {
  MAX_CREATE_DRAFT_COUNT,
  createDraftInputSchema,
  createDraftCommandSchema,
} from "./compose-draft";
export type { CreateDraftInput, CreateDraftCommand } from "./compose-draft";

// --- applyThemeToDraft ---------------------------------------------------------

/*
  Re-exported from ./theme-target, where the reference vocabulary lives.

  THE ACTION THAT WAS MISSING. `applyTheme` is a content OPERATION: a pure
  document transform, replayed into one document's op log, with no notion of
  which document — correctly so, since the log it lands in IS the document.
  What did not exist was an action ABOVE it that says which draft, so the only
  draft the agent could ever re-theme was the one its turn was pinned to. Ask
  it to theme a draft it had just created and it would have painted the user's
  current one instead.
*/
export {
  applyThemeToDraftInputSchema,
  applyThemeToDraftCommandSchema,
} from "./theme-target";
export type { ApplyThemeToDraftInput, ApplyThemeToDraftCommand } from "./theme-target";

// --- createPersona -------------------------------------------------------------

export const PERSONA_NAME_MAX_LENGTH = 60;
export const PERSONA_DESCRIPTION_MAX_LENGTH = 300;
export const PERSONA_BEHAVIOR_MAX_LENGTH = 4000;

export const createPersonaInputSchema = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .max(PERSONA_NAME_MAX_LENGTH)
      .describe('Short display name for the persona (e.g. "Accessibility Advocate").'),
    description: z
      .string()
      .min(1)
      .max(PERSONA_DESCRIPTION_MAX_LENGTH)
      .describe("One sentence describing what the persona reviews or advocates for."),
    behavior: z
      .string()
      .min(1)
      .max(PERSONA_BEHAVIOR_MAX_LENGTH)
      .optional()
      .describe(
        "Detailed behavior instructions: what the persona watches for in the email and how it phrases its recommendations. Defaults to the description.",
      ),
  })
  .describe(
    "Creates a new advisory persona (a specialized reviewer agent) for this session. " +
      "The persona reviews the email as the user works and leaves recommendations — it can never edit the document.",
  );

export type CreatePersonaInput = z.infer<typeof createPersonaInputSchema>;

/**
 * Like generateImage, this command travels in two states: `run` produces the
 * UNFULFILLED intent (name/description/behavior); the app-side executor
 * creates the session-owned persona row (server-enforced advisory capability
 * + quota) and streams the FULFILLED command with the new `slug`, which the
 * client uses to enable the persona locally.
 */
export const createPersonaCommandSchema = z
  .strictObject({
    type: z.literal("createPersona").describe("Command discriminator."),
    name: z.string().min(1).describe("The persona's display name."),
    description: z.string().min(1).describe("What the persona reviews or advocates for."),
    behavior: z.string().optional().describe("Detailed behavior instructions, when provided."),
    slug: z
      .string()
      .optional()
      .describe("The created persona's slug (present once the executor has created it)."),
  })
  .describe("Client command: a created advisory persona (slug present once fulfilled).");

export type CreatePersonaCommand = z.infer<typeof createPersonaCommandSchema>;

// --- Union -------------------------------------------------------------------

/** Any editor command — the versioned Zod contract for the data-parts channel. */
export const editorCommandSchema = z
  .discriminatedUnion("type", [
    showPreviewCommandSchema,
    sendTestEmailCommandSchema,
    generateImageCommandSchema,
    openPanelCommandSchema,
    undoCommandSchema,
    redoCommandSchema,
    goToVersionCommandSchema,
    createDraftCommandSchema,
    createPersonaCommandSchema,
    applyThemeToDraftCommandSchema,
  ])
  .describe("Any editor UI command, discriminated by its type field.");

export type EditorCommand = z.infer<typeof editorCommandSchema>;
