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
 * - `data-editor-command` parts — EDITOR actions the SERVER answers for
 *   (showPreview, sendTestEmail, …): dispatched server-side, and the frontend
 *   dispatcher (Phase 3.4) executes the typed {@link EditorCommand} in
 *   `part.data.command`. Editor actions the CLIENT answers for (undo, redo)
 *   write NO data part — they arrive as an ordinary `tool-<name>` part and
 *   the browser reports the real outcome (see {@link HistoryStepToolOutput}).
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

/*
  RESPONSE header naming the model that actually served the turn — the real
  model id, never a boolean, and never the id that was merely asked for.
  Sent by /api/chat and /api/personas.

  WHY IT EXISTS. Which model ran was previously recorded in ONE place: a
  server log line. That makes the deployment's most expensive guarantee — that
  a /demo turn, or a deployment with no key, spends no provider quota —
  unobservable to anything outside the process. A caller could believe it;
  nothing could assert it. This header moves the verdict onto the wire, where
  an end-to-end test (or an operator with curl) can read it back and FAIL when
  a turn that was supposed to be free reached for Gemini.

  It leaks nothing a caller does not already control: the model id is either a
  published id the deployment configured or the mock's constant. It is not a
  spend authority — mock-authority.ts is, and it reads a Convex row.
*/
export const MODEL_RESPONSE_HEADER = "x-flock-model";

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

/*
  THE HISTORY STEPS' TOOL RESULT (undo / redo) — written by the BROWSER, which
  is the only party that knows whether a step existed to take.

  `isStepped: false` IS A SUCCESSFUL TOOL RESULT. "There was nothing left to
  undo" is a terminal, legitimate answer, not a repairable error: nothing about
  the call was wrong and calling it again cannot change it. Routing it through
  the error channel instead would put the model on the retry path, where the
  SDK invites it to correct itself — the same instinct `not_authorized` is
  classified terminal to prevent, and the same rule the web-ingestion tools
  already follow ("a refusal is not an error", api/chat/tools.ts).

  So the shape mirrors those refusals: the call succeeded, and the payload says
  what happened. `note` is written to be relayed verbatim-ish — it carries both
  the fact and the instruction not to try again.
*/
export const HISTORY_STEP_FAILURE_REASONS = [
  /** The document's history has no eligible step for this session. */
  "nothing_to_undo",
  "nothing_to_redo",
  /** The editor never connected to a document, so no step could be attempted. */
  "not_connected",
  /** The turn's draft was closed mid-turn; its store was gone. */
  "draft_unavailable",
  /** A newer change conflicts with the inverse. */
  "conflict",
  "document_not_found",
  /** The mutation never completed (network). */
  "connection_error",
  /** A reason the client does not have curated copy for. */
  "failed",
] as const;

export type HistoryStepFailureReason = (typeof HISTORY_STEP_FAILURE_REASONS)[number];

export type HistoryStepToolOutput =
  | {
      isStepped: true;
      /** What the model may tell the user, in plain English. */
      note: string;
    }
  | {
      isStepped: false;
      reason: HistoryStepFailureReason;
      note: string;
    };

/*
  THE createDraft TOOL RESULT — the same rule as the history steps, applied to
  the other action the server used to answer for.

  The reported defect: "create a draft based on my portfolio website" produced
  a draft made of the catalog's sample copy and the user's OTHER draft's
  paragraphs, and the agent said it had built the draft "directly from your
  website details and portfolio projects". The sentence was not a hallucination
  in the usual sense — it was assembled from the PLAN the model had sent,
  server-side, before the browser had created anything. A result composed from
  intent cannot be wrong about the intent and cannot be right about the outcome.

  So the browser reports what landed: which drafts exist now, under the names
  the drafts bar actually allocated (they are deduped per canvas, so the
  model's requested name is not the name), and where each draft's words came
  from — the model's own copy, the source draft's copy carried over, or the
  section template's sample text.

  A PARTIAL OR EMPTY OUTCOME RIDES THIS SAME SUCCESS CHANNEL. "Two of the three
  sections are still sample copy" and "the drafts could not be created" are
  facts to relay, not errors to repair: re-calling createDraft would add MORE
  drafts to the user's canvas, which is the one response that makes the
  situation worse. Every `note` below therefore closes the loop explicitly.
*/

/** Where one created draft's words came from, in the drafts bar's own terms. */
export interface CreatedDraftReport {
  /** The name the drafts bar allocated — deduped, so possibly not the asked-for one. */
  name: string;
  /** Sections the model wrote copy for. */
  plannedSectionCount: number;
  /** Sections filled from the draft the user is looking at. */
  carriedOverSectionCount: number;
  /** Sections left showing the section template's sample copy. */
  templateDefaultSectionCount: number;
}

/** What a createDraft call actually did, written by the browser that did it. */
export interface CreateDraftReport {
  /** True when at least one new draft now exists in the drafts bar. */
  isCreated: boolean;
  /** The drafts that exist now, in creation order. Empty when none landed. */
  createdDrafts: CreatedDraftReport[];
  /** What the model may tell the user, in plain English. */
  note: string;
}

/*
  IN TRANSITION, deliberately visible. `createDraft` is still declared
  `resultSource: "server"` in the SDK, so today the server's dispatch echo
  ({@link EditorToolOutput}) is what reaches the model; the browser-written
  {@link CreateDraftReport} takes over the moment that declaration flips to
  "client", at which point the `EditorToolOutput` arm here is dead and should
  be deleted with it. Both arms are listed rather than one being asserted,
  because a contract that describes a wire nobody is putting that shape on is
  not a contract.
*/
export type CreateDraftToolOutput = CreateDraftReport | EditorToolOutput;

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
  undo: { input: UndoInput; output: HistoryStepToolOutput };
  redo: { input: RedoInput; output: HistoryStepToolOutput };
  goToVersion: { input: GoToVersionInput; output: EditorToolOutput };
  createDraft: { input: CreateDraftInput; output: CreateDraftToolOutput };
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
