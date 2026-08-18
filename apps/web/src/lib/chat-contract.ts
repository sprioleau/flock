import type {
  AskForClarificationInput,
  BlockDetails,
  FetchWebContentResult,
  ListAssetsInput,
  ListAssetsResult,
  PersonHighlightInput,
  PersonHighlightResult,
  ProposeEditsInput,
  ProposeSectionVariationsInput,
} from "@flock/agent";
import type { DataUIPart, UIMessage } from "ai";
import { z } from "zod";
import { chatProviderIdSchema } from "./chat-provider";
import {
  blockIdSchema,
  classifyActionErrors,
  editorCommandSchema,
  emailDocumentSchema,
  operationSchema,
  updateBlockPropertiesOperationSchema,
  type Block,
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
  type CreateDraftInput,
  type CreatePersonaInput,
  type EditorCommand,
  type GoToVersionInput,
  type MoveBlockOperation,
  type OpenPanelInput,
  type Operation,
  type PlaceBlockBesideOperation,
  type RedoInput,
  type UndoInput,
  type UnplaceBlockBesideOperation,
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
} from "@flock/email-sdk";

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
 * Send `x-flock-mock: 1` to force the deterministic mock model even when a
 * real provider key is configured — CI/tests never need a key. The mock is
 * also selected automatically when GOOGLE_GENERATIVE_AI_API_KEY is absent.
 */
export const MOCK_MODEL_HEADER = "x-flock-mock";

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
    .array(z.custom<FlockChatMessage>((value) => typeof value === "object" && value !== null))
    .min(1),
  /** The current email document (flat block map). */
  document: emailDocumentSchema,
  /*
    WHICH document this turn is about — the Convex row id, not the payload.

    The route uses it for exactly one thing: reading `documents.isDemo` off the
    row so it can force the deterministic mock on a /demo document regardless
    of what this request asked for (lib/demo/mock-authority.ts). The turn still
    runs against `document` above; this is an identity, not a second copy.

    OPTIONAL, and the honest reason is worth writing down. The editor store has
    no document id until it connects, so requiring one would 400 a turn sent in
    that window — and the property this buys is bounded anyway: a request that
    names NO document behaves exactly as it did before, because the server has
    nothing to look up. What it closes is the direction that matters, the one
    /demo actually opens: a demo document cannot have its mock turned off. What
    it does not close is that `/api/chat` is an open POST endpoint anyone can
    call without ever visiting /demo — bounding the endpoints generally is
    separate work (demo-mode.md §H), and /demo does not widen it.
  */
  documentId: z.string().min(1).optional(),
  /** The block currently selected in the editor, if any. */
  selectedBlockId: blockIdSchema.optional(),
  /**
   * Which inference provider to run this turn on. A REQUEST, not a decision:
   * the route honours it only for a caller holding a valid owner override
   * (lib/auth/owner-override.ts) and otherwise falls back to the deployment
   * default. Absent means "whatever the deployment is configured for".
   */
  providerId: chatProviderIdSchema.optional(),
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

// ---------------------------------------------------------------------------
// Widget data parts (generative UI — interactive widgets in the transcript)
// ---------------------------------------------------------------------------

/**
 * Widget channel contract (same reconciliation seam as `data-editor-command`,
 * verified against the AI SDK streaming-data docs for ai@7.0.37): the widget
 * tool's server execute writes ONE `data-*` part with `id = toolCallId`, so
 * same-id rewrites reconcile in place, and `data.toolCallId` lets the
 * transcript's latest-part dedupe supersede the tool chip with the widget.
 * The tool's model-facing output stays COMPACT (a status summary) — the full
 * widget payload rides only the data part, never the model loop.
 */

/** Payload of a `data-section-variations` part: the picker widget's options. */
export const sectionVariationsDataPartSchema = z.object({
  toolCallId: z.string(),
  /** One short line describing what the variations explore (optional). */
  intent: z.string().optional(),
  variations: z
    .array(
      z.object({
        /** Stable per-call id ("v1", "v2", …) — the widget's choice key. */
        id: z.string(),
        title: z.string(),
        templateId: z.string(),
        /**
         * Flat root-first section subtree `[section, ...children]` — the
         * SavedSectionPreview/restoreBlocks payload shape. Structurally
         * trusted (the server materialized it from the SDK catalog); inserts
         * re-validate through the normal dispatch gate anyway.
         */
        blocks: z
          .array(z.custom<Block>((value) => typeof value === "object" && value !== null))
          .min(1),
      }),
    )
    .min(1),
});

export type SectionVariationsDataPart = z.infer<typeof sectionVariationsDataPartSchema>;

/** Payload of a `data-edit-suggestions` part: pre-validated Apply cards. */
export const editSuggestionsDataPartSchema = z.object({
  toolCallId: z.string(),
  suggestions: z
    .array(
      z.object({
        /** Stable per-call id ("s1", "s2", …) — the widget's apply/dismiss key. */
        id: z.string(),
        title: z.string(),
        description: z.string().optional(),
        /** Ops already dry-run against the request document server-side. */
        ops: z.array(updateBlockPropertiesOperationSchema).min(1),
      }),
    )
    .min(1),
  /** Suggestions the server dropped (failed validation/dry-run). */
  droppedCount: z.number().int().min(0),
});

export type EditSuggestionsDataPart = z.infer<typeof editSuggestionsDataPartSchema>;

/** Compact-table row cap (owner spec: small tables, ~6 rows). */
export const CHAT_TABLE_MAX_ROWS = 6;

/** Payload of a `data-table` part: one small user-facing table. */
export const tableDataPartSchema = z.object({
  toolCallId: z.string(),
  title: z.string().optional(),
  /** User-facing column headers (never internal field names). */
  headers: z.array(z.string()).min(1).max(5),
  rows: z.array(z.array(z.string())).max(CHAT_TABLE_MAX_ROWS),
  /** Rows beyond the cap, mentioned as "+N more" by the widget. */
  moreRowCount: z.number().int().min(0).optional(),
});

export type TableDataPart = z.infer<typeof tableDataPartSchema>;

// ---------------------------------------------------------------------------
// Generation requests (the drafts menu's AI actions)
// ---------------------------------------------------------------------------

/** Longest "Anything to change?" direction accepted on the wire. */
const MAX_GENERATION_DIRECTION_LENGTH = 2_000;

/**
 * Payload of a `data-generation-request` part: the WHOLE machine-readable half
 * of an "Ideate with AI" / "Add design variation" send.
 *
 * It rides the user's message as a data part rather than as prose, because the
 * two halves of that send have different audiences: the `text` part is a
 * sentence a person would write and is the only thing the transcript renders,
 * while this is expanded server-side into the targeted brief the model reads
 * (api/chat/generation-brief.ts). Before this existed the brief WAS the message
 * text, so the chat bubble showed block ids, hex colours and instruction lists.
 *
 * Deliberately minimal: an id, not a document. The server reads the source
 * draft from Convex itself, so the only free text here is the person's own
 * direction.
 */
export const generationRequestDataPartSchema = z.object({
  kind: z.enum(["ideate", "designVariation"]),
  /**
   * The draft being reimagined, by Convex document id. An UNTRUSTED string:
   * the server resolves it through `getDocumentByKey`, which normalizes an
   * unrecognised id to null.
   */
  sourceDocumentId: z.string().min(1).max(128),
  /** What the person typed in "Anything to change?", verbatim and unparsed. */
  direction: z.string().max(MAX_GENERATION_DIRECTION_LENGTH).optional(),
});

export type GenerationRequestDataPart = z.infer<typeof generationRequestDataPartSchema>;

/** Wire type of the generation-request data part (`data-${name}`). */
export const GENERATION_REQUEST_DATA_PART_TYPE = "data-generation-request" as const;

/** DATA_PARTS generic for {@link FlockChatMessage}, keyed by part name. */
// A type alias (not an interface) so it gets an implicit index signature and
// satisfies the AI SDK's `UIDataTypes` (Record<string, unknown>) constraint.
export type FlockChatDataParts = {
  "editor-command": EditorCommandDataPart;
  "section-variations": SectionVariationsDataPart;
  "edit-suggestions": EditSuggestionsDataPart;
  table: TableDataPart;
  "generation-request": GenerationRequestDataPart;
};

// ---------------------------------------------------------------------------
// Tool parts
// ---------------------------------------------------------------------------

/** Tool output returned by editor actions after a successful server dispatch. */
export interface EditorToolOutput {
  status: "dispatched";
  command: EditorCommand;
  /**
   * A short model-facing sentence about what happened, for commands whose
   * echoed payload is deliberately trimmed (a composed createDraft's plan is
   * several whole emails — the client gets it on the data part, the model gets
   * this instead of paying for it again on every continuation round).
   */
  note?: string;
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
 * fetchPersonHighlight result data (Phase 7.4b): the attributed person payload
 * or the structured refusal. Same rule as fetchWebContent — a refusal is a
 * SUCCESSFUL tool output the model must relay, not an execution error.
 */
export type FetchPersonHighlightToolOutput = AnalysisToolOutput<PersonHighlightResult>;

/**
 * Model-facing output of a widget tool (proposeSectionVariations,
 * proposeEdits): a COMPACT confirmation that the widget is on screen plus a
 * behavioral note ("the user picks; don't act yourself") — the full payload
 * rides the widget's data part, never the model loop.
 */
export interface WidgetPresentedOutput {
  status: "presented";
  note: string;
}

export type ProposeSectionVariationsToolOutput = WidgetPresentedOutput & {
  variationCount: number;
};

export type ProposeEditsToolOutput = WidgetPresentedOutput & {
  suggestionCount: number;
  droppedCount: number;
};

/** listAssets result data: the session's library, newest first (capped). */
export type ListAssetsToolOutput = AnalysisToolOutput<ListAssetsResult>;

/**
 * TOOLS generic for {@link FlockChatMessage} — one entry per registry action
 * (tool names match `emailActionRegistry` action names exactly).
 *
 * Content ops have `output: never` (no execute; the CLIENT applies them).
 * Editor actions execute server-side and produce {@link EditorToolOutput}.
 */
// Type alias for the same implicit-index-signature reason as FlockChatDataParts.
export type FlockChatTools = {
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
  placeBlockBeside: { input: PlaceBlockBesideOperation; output: never };
  unplaceBlockBeside: { input: UnplaceBlockBesideOperation; output: never };
  updateText: { input: UpdateTextOperation; output: never };
  styleTextSpan: { input: StyleTextSpanInput; output: never };
  scaffoldSection: { input: ScaffoldSectionInput; output: never };
  showPreview: { input: ShowPreviewInput; output: EditorToolOutput };
  sendTestEmail: { input: SendTestEmailInput; output: EditorToolOutput };
  generateImage: { input: GenerateImageInput; output: EditorToolOutput };
  openPanel: { input: OpenPanelInput; output: EditorToolOutput };
  undo: { input: UndoInput; output: EditorToolOutput };
  redo: { input: RedoInput; output: EditorToolOutput };
  goToVersion: { input: GoToVersionInput; output: EditorToolOutput };
  createDraft: { input: CreateDraftInput; output: EditorToolOutput };
  createPersona: { input: CreatePersonaInput; output: EditorToolOutput };
  getBlockDetails: { input: { blockId: BlockId }; output: GetBlockDetailsToolOutput };
  fetchWebContent: { input: { url: string }; output: FetchWebContentToolOutput };
  fetchPersonHighlight: {
    input: PersonHighlightInput;
    output: FetchPersonHighlightToolOutput;
  };
  // Widget tools (generative UI). askForClarification never executes — the
  // turn ends on the call and the user's answer arrives as their next message.
  askForClarification: { input: AskForClarificationInput; output: never };
  proposeSectionVariations: {
    input: ProposeSectionVariationsInput;
    output: ProposeSectionVariationsToolOutput;
  };
  proposeEdits: { input: ProposeEditsInput; output: ProposeEditsToolOutput };
  listAssets: { input: ListAssetsInput; output: ListAssetsToolOutput };
};

/** The typed UI message flowing over /api/chat in both directions. */
export type FlockChatMessage = UIMessage<never, FlockChatDataParts, FlockChatTools>;

/**
 * Any ONE of this app's data parts, discriminated on `type`. Exactly what
 * `convertToModelMessages`' convertDataPart hook is handed, so server code that
 * reads a data part can type its parameter with this and still have
 * `part.type === …` narrow `part.data`.
 */
export type FlockChatDataPart = DataUIPart<FlockChatDataParts>;

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
  kind: z.literal("flock-chat-error"),
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
