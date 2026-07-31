import type { BlockDetails, FetchWebContentResult } from "@tandem/agent";
import type { UIMessage } from "ai";
import { z } from "zod";
import {
  blockIdSchema,
  classifyActionErrors,
  editorCommandSchema,
  emailDocumentSchema,
  operationSchema,
  scaffoldSectionInputSchema,
  styleTextSpanInputSchema,
  type ActionDispatchError,
  type ActionFailureKind,
  type ScaffoldSectionInput,
  type StyleTextSpanInput,
  type AddBlockOperation,
  type AddSectionOperation,
  type ApplyThemeOperation,
  type BlockId,
  type EditorCommand,
  type MoveBlockOperation,
  type Operation,
  type GenerateImageInput,
  type RemoveBlockOperation,
  type ReorderChildrenOperation,
  type ReplaceBlockPropertiesOperation,
  type RestoreBlocksOperation,
  type SendTestEmailInput,
  type ShowPreviewInput,
  type UpdateBlockPropertiesOperation,
  type UpdateDocumentSettingsOperation,
  type UpdateTextOperation,
} from "@tandem/email-sdk";

/**
 * Chat wire contract — the ONE module both the /api/chat route and the chat UI
 * import. Everything here is isomorphic (Zod + types only, no server code).
 *
 * Transport recap (proven in Spike C, docs/decisions/spike-c-ai-sdk-streaming.md):
 * AI SDK v7 UI-message stream over SSE. The client receives, per assistant turn:
 *
 * - `text` parts — assistant prose, streamed delta by delta.
 * - `tool-<actionName>` parts (e.g. `tool-updateBlockProperties`) — CONTENT
 *   operations. These tools have NO server execute(): the client validates the
 *   input with {@link validateAndClassifyOp} at `input-available` and applies
 *   it optimistically to the local document (Phase 4 makes Convex
 *   authoritative). Partial input during `input-streaming` is cosmetic only.
 * - `data-editor-command` parts — EDITOR actions (showPreview, sendTestEmail),
 *   dispatched server-side; the frontend dispatcher (Phase 3.4) executes the
 *   typed {@link EditorCommand} in `part.data.command`.
 * - `error` parts — terminal failures; `errorText` is a serialized
 *   {@link ChatErrorPayload} (see {@link parseChatErrorText}).
 */

// ---------------------------------------------------------------------------
// Route location & mode override
// ---------------------------------------------------------------------------

export const CHAT_API_PATH = "/api/chat";

/**
 * Send `x-tandem-mock: 1` to force the deterministic mock model even when a
 * real provider key is configured — CI/tests never need a key. The mock is
 * also selected automatically when GOOGLE_GENERATIVE_AI_API_KEY is absent.
 */
export const MOCK_MODEL_HEADER = "x-tandem-mock";

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

/**
 * POST /api/chat body. `document` is re-validated server-side against the full
 * email-sdk schema AND referential integrity; failures return HTTP 400 with a
 * {@link ChatRequestErrorResponse} body (no stream is started).
 */
export const chatRequestBodySchema = z.object({
  /** Chat/thread id (useChat's DefaultChatTransport sends this as `id`). */
  id: z.string().optional(),
  /** UIMessage[] — structurally validated by the AI SDK during conversion. */
  messages: z
    .array(z.custom<TandemChatMessage>((value) => typeof value === "object" && value !== null))
    .min(1),
  /** The current email document (flat block map). */
  document: emailDocumentSchema,
  /** The block currently selected in the editor, if any. */
  selectedBlockId: blockIdSchema.optional(),
});

export type ChatRequestBody = z.infer<typeof chatRequestBodySchema>;

/** Structured 400 body for invalid requests / documents. */
export interface ChatRequestErrorResponse {
  error: "invalid_json" | "invalid_request" | "invalid_document";
  issues: { code: string; message: string; path: string }[];
}

// ---------------------------------------------------------------------------
// Data parts (the Phase 3.4 editor-operations channel)
// ---------------------------------------------------------------------------

/**
 * Payload of a `data-editor-command` part. Written server-side when the model
 * calls an editor action (kind: "editor") — the server runs
 * `dispatchEditorAction` and streams the resulting typed command here.
 * `toolCallId` links the command back to its `tool-<name>` part (the part id
 * is also the toolCallId, so same-id rewrites reconcile).
 */
export const editorCommandDataPartSchema = z.object({
  toolCallId: z.string(),
  command: editorCommandSchema,
});

export type EditorCommandDataPart = z.infer<typeof editorCommandDataPartSchema>;

/** Wire type of the editor-command data part (`data-${name}`). */
export const EDITOR_COMMAND_DATA_PART_TYPE = "data-editor-command" as const;

/** DATA_PARTS generic for {@link TandemChatMessage}, keyed by part name. */
// A type alias (not an interface) so it gets an implicit index signature and
// satisfies the AI SDK's `UIDataTypes` (Record<string, unknown>) constraint.
export type TandemChatDataParts = {
  "editor-command": EditorCommandDataPart;
};

// ---------------------------------------------------------------------------
// Tool parts
// ---------------------------------------------------------------------------

/** Tool output returned by editor actions after a successful server dispatch. */
export interface EditorToolOutput {
  status: "dispatched";
  command: EditorCommand;
  /**
   * Phase 8.1: present only when the command was an executed sendTestEmail —
   * the Resend message id of the real send. The model quotes it when
   * confirming; failed sends never produce an output (the tool call errors
   * with friendly copy instead).
   */
  send?: { messageId: string };
}

/**
 * Tool output returned by ANALYSIS actions (kind: "analysis") — executed
 * server-side against the request's document, returned to the model in-loop.
 * `isFound: false` is the model-facing "no such block" shape for a null
 * lookup result.
 */
export type AnalysisToolOutput<TData = unknown> =
  | { isFound: true; data: TData }
  | { isFound: false; message: string };

/** getBlockDetails result data: the full block JSON + root-first ancestor ids. */
export type GetBlockDetailsToolOutput = AnalysisToolOutput<BlockDetails>;

/**
 * fetchWebContent result data (Phase 7.4a): the extracted article payload or
 * the structured refusal — both are SUCCESSFUL tool outputs (`isFound: true`);
 * a refusal is information the model must relay, not an execution error.
 */
export type FetchWebContentToolOutput = AnalysisToolOutput<FetchWebContentResult>;

/**
 * TOOLS generic for {@link TandemChatMessage} — one entry per registry action
 * (tool names match `emailActionRegistry` action names exactly).
 *
 * Content ops have `output: never` (no execute; the CLIENT applies them).
 * Editor actions execute server-side and produce {@link EditorToolOutput}.
 */
// Type alias for the same implicit-index-signature reason as TandemChatDataParts.
export type TandemChatTools = {
  updateBlockProperties: { input: UpdateBlockPropertiesOperation; output: never };
  replaceBlockProperties: { input: ReplaceBlockPropertiesOperation; output: never };
  updateDocumentSettings: { input: UpdateDocumentSettingsOperation; output: never };
  applyTheme: { input: ApplyThemeOperation; output: never };
  addBlock: { input: AddBlockOperation; output: never };
  addSection: { input: AddSectionOperation; output: never };
  restoreBlocks: { input: RestoreBlocksOperation; output: never };
  removeBlock: { input: RemoveBlockOperation; output: never };
  moveBlock: { input: MoveBlockOperation; output: never };
  reorderChildren: { input: ReorderChildrenOperation; output: never };
  updateText: { input: UpdateTextOperation; output: never };
  styleTextSpan: { input: StyleTextSpanInput; output: never };
  scaffoldSection: { input: ScaffoldSectionInput; output: never };
  showPreview: { input: ShowPreviewInput; output: EditorToolOutput };
  sendTestEmail: { input: SendTestEmailInput; output: EditorToolOutput };
  generateImage: { input: GenerateImageInput; output: EditorToolOutput };
  getBlockDetails: { input: { blockId: BlockId }; output: GetBlockDetailsToolOutput };
  fetchWebContent: { input: { url: string }; output: FetchWebContentToolOutput };
};

/** The typed UI message flowing over /api/chat in both directions. */
export type TandemChatMessage = UIMessage<never, TandemChatDataParts, TandemChatTools>;

// ---------------------------------------------------------------------------
// Client-side validation gate (Phase 3.3, layer 3)
// ---------------------------------------------------------------------------

/**
 * What the client-side gate hands to the store's dispatch: a plain email-sdk
 * Operation, or one of the TWO intent-shaped content inputs — styleTextSpan
 * and scaffoldSection. The store resolves intents into canonical ops against
 * the CURRENT document via the SDK's resolveOperation hooks (styleTextSpan →
 * updateText, scaffoldSection → addSection); only plain ops reach the op log.
 */
export type DispatchableContentInput = Operation | StyleTextSpanInput | ScaffoldSectionInput;

export type ValidateAndClassifyOpResult =
  | { isValid: true; operation: DispatchableContentInput }
  | { isValid: false; failureKind: ActionFailureKind; errors: ActionDispatchError[] };

const formatZodIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");

/**
 * The client-side gate for content ops: when a `tool-<name>` part reaches
 * `input-available`, re-parse the input against the FULL operation union
 * (the model only saw the compact agent schema) and classify any failure with
 * the SDK's stop-vs-retry taxonomy before applying to the canvas.
 *
 * styleTextSpan and scaffoldSection are the two content tools whose input is
 * NOT an Operation (intent-level args; the translation to an updateText /
 * addSection op happens in the store's dispatch, against the current
 * document) — their inputs are gated against their own intent schemas
 * instead, discriminated by `name`.
 */
const INTENT_INPUT_SCHEMAS = {
  styleTextSpan: styleTextSpanInputSchema,
  scaffoldSection: scaffoldSectionInputSchema,
} as const;

export function validateAndClassifyOp(input: unknown): ValidateAndClassifyOpResult {
  const intentName =
    typeof input === "object" && input !== null
      ? (input as { name?: unknown }).name
      : undefined;
  if (intentName === "styleTextSpan" || intentName === "scaffoldSection") {
    const parsedIntent = INTENT_INPUT_SCHEMAS[intentName].safeParse(input);
    if (parsedIntent.success) {
      return { isValid: true, operation: parsedIntent.data };
    }
    const intentErrors: ActionDispatchError[] = [
      {
        code: "op_validation_failed",
        message: `${intentName} input failed validation: ${formatZodIssues(parsedIntent.error)}`,
      },
    ];
    return { isValid: false, failureKind: classifyActionErrors(intentErrors), errors: intentErrors };
  }
  const parsed = operationSchema.safeParse(input);
  if (parsed.success) {
    return { isValid: true, operation: parsed.data };
  }
  const errors: ActionDispatchError[] = [
    {
      code: "op_validation_failed",
      message: `Operation failed validation: ${formatZodIssues(parsed.error)}`,
    },
  ];
  return { isValid: false, failureKind: classifyActionErrors(errors), errors };
}

// ---------------------------------------------------------------------------
// Error part payload (terminal failures on the stream)
// ---------------------------------------------------------------------------

/**
 * Structured payload serialized into the stream's `error` part `errorText`.
 * Terminal failures stop the turn; retryable ones only reach the client after
 * the one server-side repair round-trip has been exhausted.
 */
export const chatErrorPayloadSchema = z.object({
  kind: z.literal("tandem-chat-error"),
  failureKind: z.enum(["retryable", "terminal"]),
  errors: z.array(z.object({ code: z.string(), message: z.string() })),
});

export type ChatErrorPayload = z.infer<typeof chatErrorPayloadSchema>;

export function serializeChatError(payload: ChatErrorPayload): string {
  return JSON.stringify(payload);
}

/** Parse an error part's `errorText`; undefined when it isn't a structured payload. */
export function parseChatErrorText(errorText: string): ChatErrorPayload | undefined {
  try {
    const parsed = chatErrorPayloadSchema.safeParse(JSON.parse(errorText));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
