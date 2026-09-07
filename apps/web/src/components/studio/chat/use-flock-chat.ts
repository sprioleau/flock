"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chat, useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  isStaticToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useConvex, useMutation, useQuery } from "convex/react";
import {
  dispatchEditorAction,
  emailActionRegistry,
  isSavedSectionTemplateId,
  SAVED_SECTION_TEMPLATE_ID_PREFIX,
  ROOT_BLOCK_ID,
  type ActionContext,
  type ActionDispatchError,
  type ActionFailureKind,
  type ApplyThemeToDraftCommand,
  type Block,
  type CreateDraftCommand,
  type GlobalStyles,
  type NamedTheme,
  type GenerateImageCommand,
  type ScaffoldSectionPosition,
} from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { buildInsertSavedSectionPlan } from "@/lib/saved-sections";
import {
  CHAT_API_PATH,
  editorCommandDataPartSchema,
  MOCK_MODEL_HEADER,
  validateAndClassifyOp,
  type FlockChatMessage,
  type FlockChatTools,
} from "@/lib/chat-contract";
import {
  acquireEditorStore,
  peekEditorStore,
  releaseEditorStore,
  useEditorStore,
  type DispatchableOp,
  type EditorState,
  type EditorStoreApi,
} from "@/lib/editor-store";
import { setPersonaEnabled } from "@/lib/personas/enabled-personas";
import {
  toHistoryStepToolOutput,
  type HistoryStepDirection,
  type HistoryStepOutcome,
} from "@/lib/history-step-report";
import {
  createEmptyDraftOutcome,
  toCreateDraftToolOutput,
  type CreateDraftOutcome,
} from "@/lib/create-draft-report";
import { getHasIngestedSourceInTurn } from "@/lib/ingested-source";
import { useActiveBrandKit } from "../brand-kit/useActiveBrandKit";
import { applyThemeToDraft } from "../drafts/apply-theme-to-draft";
import {
  toApplyThemeToolOutput,
  type ApplyThemeOutcome,
} from "../drafts/apply-theme-report";
import {
  readCanvasThemeCandidates,
  readTurnPageTheme,
} from "../drafts/theme-candidates";
import { getOrCreateSessionId } from "@/lib/session";
import { requestUiSurfaceOpen } from "@/lib/ui-surfaces";
import { getAppSettings } from "../demo/app-settings";
import { scrollBlockIntoView } from "../add-blocks/scroll-block-into-view";
import { createAgentDrafts } from "../drafts/create-agent-drafts";
import { takeGenerationRequest } from "./pending-generation-request";
import {
  getChatMessageText,
  getVisibleThreadProvisioningError,
  isChatLifecycleCurrent,
  isInterruptedTurnRetrySafe,
  mergePersistedChatMessages,
  createUserChatMessage,
  shouldApplyChatHydration,
  toPersistedChatMessages,
  type PersistedChatTurn,
} from "./durable-chat";

/*
  The Phase 3 chat brain: wires AI SDK v7 `useChat` to the editor store.

  - Request body: current document + selectedBlockId are read from the store
    AT SEND TIME (the transport's `body` resolvable runs per request).
  - Content ops (`tool-<name>` parts, no server execute): applied in
    `onToolCall` at input-available — validateAndClassifyOp gate → store
    dispatch with agent provenance (author "agent", one batchId per turn) —
    then the outcome is reported back with `addToolOutput` so the model sees
    apply results in-loop (`sendAutomaticallyWhen` closes the loop).
  - Editor commands (`data-editor-command` parts): dispatched in `onData`
    (showPreview flips the canvas viewport; sendTestEmail is a Phase 8 stub).
  - CLIENT-RESULT editor actions (undo, redo — `resultSource: "client"` in the
    SDK): no server execute, so they reach `onToolCall` like a content op.
    The browser takes the real history step and reports what it did
    (`takeHistoryStep`), because only the browser can know whether there was
    a step to take — the server used to answer anyway, and got it wrong.
  - sendTestEmail approvals: `addToolApprovalResponse` is exposed for the
    approval chip; a response auto-resubmits so the server can execute.
*/

/*
  Tool names the CLIENT applies (content ops — no execute() on the server).
*/
const CONTENT_TOOL_NAMES: ReadonlySet<string> = new Set(
  emailActionRegistry.actions
    .filter((action) => action.kind === "content")
    .map((action) => action.name),
);

/*
  Editor actions the CLIENT is the result-source for (`resultSource: "client"`
  in the SDK): undo, redo and createDraft. They reach `onToolCall` like a
  content op, and the browser — the only party that can ask Convex whether a
  history step exists, or which drafts landed under which names — writes the
  tool result.

  Derived from the registry rather than listed here, for the same reason
  CONTENT_TOOL_NAMES is: the SDK stays the one place an action is declared,
  including the declaration of who gets to answer for it.
*/
const CLIENT_RESULT_EDITOR_TOOL_NAMES: ReadonlySet<string> = new Set(
  emailActionRegistry.actions
    .filter((action) => action.kind === "editor" && action.resultSource === "client")
    .map((action) => action.name),
);

/*
  One draft's raw globals, or null when it carries none of its own.

  `{}` and null are the same fact — a draft on the shared renderer defaults —
  and collapsing them here is what lets `theme: "current"` refuse honestly
  instead of resolving to an empty payload that would strip the target draft.
*/
function readDraftGlobals(doc: EditorState["doc"]): GlobalStyles | null {
  const root = doc[ROOT_BLOCK_ID];
  if (root === undefined || root.type !== "root") {
    return null;
  }
  const globals = root.properties.globals ?? {};
  return Object.keys(globals).length > 0 ? globals : null;
}

/*
  The history direction a client-result editor tool name asks for.
*/
function getHistoryStepDirection(toolName: string): HistoryStepDirection | null {
  if (toolName === "undo" || toolName === "redo") {
    return toolName;
  }
  return null;
}

/*
  WHICH BROWSER-SIDE EXECUTOR ANSWERS A CLIENT-RESULT COMMAND — the routing
  decision, lifted out of `runClientResultEditorTool` so it can be checked
  against the registry instead of being taken on trust.

  THE FAILURE THIS EXISTS TO CATCH is silent and total. A `resultSource:
  "client"` action gets no server execute and writes no command part, so this
  branch is the ONLY thing that ever answers it. Miss one — add a client-
  result action and forget the branch, or delete a branch during a refactor —
  and the call reaches the browser, does nothing, and is never reported: an
  open tool call the model waits on forever, with no error anywhere and every
  test still green. That is not a hypothetical; deleting the applyThemeToDraft
  branch outright left the whole suite passing and `tsc` clean, which is why
  the decision now lives somewhere a test can reach it.

  Null means "no executor claims this", which the test below turns into a
  build-time-ish failure by holding it against every client-result action the
  SDK declares.
*/
export function getClientResultExecutorKind(
  commandType: string,
): "history" | "createDraft" | "applyThemeToDraft" | null {
  if (getHistoryStepDirection(commandType) !== null) {
    return "history";
  }
  if (commandType === "createDraft" || commandType === "applyThemeToDraft") {
    return commandType;
  }
  return null;
}

/*
  Report one history step's REAL outcome as the tool result. `isStepped: false`
  rides the success channel on purpose — see lib/history-step-report.ts.
*/
function reportHistoryStep({
  chat,
  toolCallId,
  direction,
  outcome,
}: {
  chat: Chat<FlockChatMessage>;
  toolCallId: string;
  direction: HistoryStepDirection;
  outcome: HistoryStepOutcome;
}): void {
  void chat.addToolOutput({
    tool: direction,
    toolCallId,
    output: toHistoryStepToolOutput({ direction, outcome }),
  });
}

/*
  Ceiling on automatic follow-up requests per user turn. The loop normally
  terminates when the model responds without tool calls; this cap bounds the
  worst case (a model that keeps emitting ops forever).
*/
const MAX_AUTO_CONTINUATIONS_PER_TURN = 1;

function hasPendingToolPart(message: FlockChatMessage): boolean {
  return message.parts.some(
    (part) =>
      isStaticToolUIPart(part) &&
      (part.state === "input-streaming" ||
        part.state === "input-available" ||
        part.state === "approval-requested" ||
        part.state === "approval-responded"),
  );
}

export function shouldDeferAssistantPersistence({
  message,
  messages,
  finishReason,
  isMockEnabled,
  autoContinuationCount,
}: {
  message: FlockChatMessage;
  messages: FlockChatMessage[];
  finishReason: string | undefined;
  isMockEnabled: boolean;
  autoContinuationCount: number;
}): boolean {
  if (hasPendingToolPart(message)) {
    return true;
  }
  return (
    finishReason === "tool-calls" &&
    !isMockEnabled &&
    autoContinuationCount < MAX_AUTO_CONTINUATIONS_PER_TURN &&
    lastAssistantMessageIsCompleteWithToolCalls({ messages })
  );
}

/*
  Structured tool-result payload for a failed client-side op application.
*/
function serializeApplyFailure(failure: {
  failureKind: ActionFailureKind;
  errors: ActionDispatchError[];
}): string {
  return JSON.stringify({
    status: "failed",
    failureKind: failure.failureKind,
    errors: failure.errors.map(({ code, message }) => ({ code, message })),
  });
}

const CLIENT_TOOL_EXECUTOR_FAILURE_MESSAGE = "Flock couldn't complete that action. Try again.";

interface ClientToolOutput {
  tool: keyof FlockChatTools;
  toolCallId: string;
  state?: "output-error";
  output?: unknown;
  errorText?: string;
}

export function settleClientToolCall<T>({
  tool,
  toolCallId,
  execute,
  toOutput,
  addToolOutput,
}: {
  tool: keyof FlockChatTools;
  toolCallId: string;
  execute: () => Promise<T> | T;
  toOutput: (value: T) => unknown;
  addToolOutput: (output: ClientToolOutput) => void;
}): void {
  let isSettled = false;
  const failureOutput = (): ClientToolOutput => ({
    state: "output-error",
    tool,
    toolCallId,
    errorText: JSON.stringify({
      kind: "flock-chat-error",
      failureKind: "retryable",
      errors: [
        {
          code: "client_executor_failed",
          message: CLIENT_TOOL_EXECUTOR_FAILURE_MESSAGE,
        },
      ],
    }),
  });
  const emit = (output: ClientToolOutput): void => {
    if (isSettled) {
      return;
    }
    isSettled = true;
    try {
      addToolOutput(output);
    } catch {
      /*
        The output channel itself failed after settlement was attempted. A
        second write could turn one tool call into two terminal results.
      */
    }
  };

  void Promise.resolve()
    .then(execute)
    .then(
      (value) => {
        try {
          emit({ tool, toolCallId, output: toOutput(value) });
        } catch {
          emit(failureOutput());
        }
      },
      () => {
        emit(failureOutput());
      },
    );
}

/*
  The Chat instance plus methods over the mutable per-turn bookkeeping its
  callbacks close over. Created ONCE per panel mount (useState initializer) —
  plain closures, so no render-time ref access and no state-object mutation.
*/
interface FlockChatController {
  chat: Chat<FlockChatMessage>;
  dispose: () => void;
  /*
    Start a user-initiated turn: fresh agent batchId + continuation budget.
  */
  beginUserTurn: (input: {
    logicalTurnId: string;
    userMessageId: string;
    text: string;
  }) => void;
  /*
    Dev-only x-flock-mock switch, read by the transport at request time.
  */
  setIsMockEnabled: (isMockEnabled: boolean) => void;
  /*
    Keep the controller's saved-sections runtime current (reactive rows +
    the usage-stat recorder) — the agent path resolves scaffoldSection
    `saved:<id>` calls against this cache synchronously, preserving the
    per-section streaming order.
  */
  setSavedSectionsRuntime: (runtime: SavedSectionsRuntime) => void;
  /*
    Inject the createDraft command's executor (agent parity): the hook owns
    the Convex client, so it builds the drafts-machinery loop and hands it
    to the controller's onData closure here. Takes the whole command — a
    composed createDraft carries the plan its new drafts are built from.

    It RESOLVES WITH THE OUTCOME (never rejects) because that outcome is the
    only honest basis for createDraft's tool result — see
    lib/create-draft-report.ts.
  */
  setCreateDrafts: (
    createDrafts: (command: CreateDraftCommand) => Promise<CreateDraftOutcome>,
  ) => void;
  /*
    Inject the applyThemeToDraft executor, for the same reason createDraft's
    is injected: the hook owns the Convex client and the reactive brand kit,
    and the controller owns the turn.

    It RESOLVES WITH THE OUTCOME (never rejects) because that outcome is the
    only honest basis for the tool result — see drafts/apply-theme-report.ts.
  */
  setApplyTheme: (
    applyTheme: (command: ApplyThemeToDraftCommand) => Promise<ApplyThemeOutcome>,
  ) => void;
  /*
    This turn's agent batch id. Read by executors that write to Convex
    DIRECTLY rather than through a store (re-theming an off-screen draft), so
    their ops still revert with the rest of the turn instead of standing
    alone in some other draft's history.
  */
  getTurnBatchId: () => string;
  setTurnLifecycle: (lifecycle: ChatTurnLifecycle) => void;
}

interface ChatTurnLifecycle {
  onUserTurn: (input: { logicalTurnId: string; userMessageId: string; text: string }) => void;
  onAssistantTurn: (input: {
    logicalTurnId: string;
    userMessageId: string;
    message: FlockChatMessage;
  }) => void;
  onInterrupted: (input: {
    logicalTurnId: string;
    userMessageId: string;
    text: string;
    isRetrySafe: boolean;
  }) => void;
}

interface PersistedTurnInput {
  canvasId: Id<"canvases">;
  sessionId: string;
  turnId: string;
  idempotencyKey: string;
  role: "user" | "assistant";
  content: string;
}

interface PendingPersistence {
  input: PersistedTurnInput;
  threadKey: string;
}

interface SavedSectionsRuntime {
  rows: Doc<"savedSections">[];
  /*
    Fails-soft useCount/lastUsedAtMs bump (owner V2 item 4).
  */
  recordUse: (savedSectionId: Id<"savedSections">) => void;
}

function createFlockChatController({
  chatId,
  lifecycle = {
    onUserTurn: () => {},
    onAssistantTurn: () => {},
    onInterrupted: () => {},
  },
}: {
  chatId: string;
  lifecycle?: ChatTurnLifecycle;
}): FlockChatController {
  /*
    toolCallIds already applied / commands already executed (same-id stream
    rewrites and repeated deliveries must not double-apply).
  */
  const appliedToolCallIds = new Set<string>();
  const executedCommandToolCallIds = new Set<string>();

  /*
    One batchId per user-initiated turn: every agent op the turn produces
    (including auto-continuation rounds) shares it, so Phase 4 can revert the
    whole AI turn in one step.
  */
  //
  /*
    `documentId` pins the turn to the document it STARTED in (the mid-turn
    draft-switch fix): the drafts bar can retarget the active store while a
    turn is still streaming, and without the pin the turn's remaining ops
    would apply to whichever draft is active. The pin is backed by a
    REGISTRY HOLD (drafts v2 per-document store factory): beginUserTurn
    acquires the turn document's store instance, so a draft switch cannot
    dispose it — the turn's remaining ops dispatch into that retained
    instance (full local-overlay semantics, including human edits made
    before the switch), and the draft simply shows them when reactivated.
    The hold is released when the NEXT user turn begins.
  */
  const turnState = {
    isMockEnabled: false,
    batchId: crypto.randomUUID(),
    autoContinuationCount: 0,
    documentId: null as Id<"documents"> | null,
    activeTurn: null as {
      logicalTurnId: string;
      userMessageId: string;
      text: string;
    } | null,
  };

  let turnLifecycle = lifecycle;
  let isDisposed = false;

  let heldTurnDocumentId: Id<"documents"> | null = null;

  /*
    Reactive saved-sections cache (kept current by setSavedSectionsRuntime):
    saved scaffold calls resolve against it synchronously — never an async
    fetch that could reorder a per-section streaming turn's inserts.
  */
  let savedSectionsRuntime: SavedSectionsRuntime = { rows: [], recordUse: () => {} };

  /*
    The createDraft command executor (injected by the hook — it owns the
    Convex client). No-op until injected; the hook wires it on mount.
  */
  let createDrafts: (command: CreateDraftCommand) => Promise<CreateDraftOutcome> = async () =>
    createEmptyDraftOutcome();

  /*
    The applyThemeToDraft executor (injected by the hook, same as above).
    No-op until injected; "unreachable" is the honest answer for a call that
    never got to look at anything.
  */
  let applyTheme: (command: ApplyThemeToDraftCommand) => Promise<ApplyThemeOutcome> = async () => ({
    kind: "unreachable",
  });

  /*
    Swap the chat's registry hold from the previous turn's doc to `documentId`.
  */
  const holdTurnDocument = (documentId: Id<"documents"> | null): void => {
    if (documentId === heldTurnDocumentId) {
      return;
    }
    if (documentId !== null) {
      acquireEditorStore(documentId);
    }
    if (heldTurnDocumentId !== null) {
      releaseEditorStore(heldTurnDocumentId);
    }
    heldTurnDocumentId = documentId;
  };

  /*
    The turn document's retained store instance (null only if never pinned).
  */
  const getTurnDocumentStore = (): EditorStoreApi | null =>
    turnState.documentId !== null ? peekEditorStore(turnState.documentId) : null;

  /*
    True while the USER is still on the turn's own document. The ?doc= param
    is the authoritative signal: a drafts-bar switch updates it SYNCHRONOUSLY
    (pushState), while the store re-connects only when the incoming draft's
    first snapshot arrives — a window long enough for a streamed op or
    command to slip through and hit the wrong draft. Store fallback covers
    non-browser contexts.
  */
  const getIsTurnDocumentActive = (): boolean => {
    if (turnState.documentId === null) {
      return true;
    }
    if (typeof window !== "undefined") {
      const urlDocumentId = new URLSearchParams(window.location.search).get("doc");
      if (urlDocumentId !== null) {
        return urlDocumentId === turnState.documentId;
      }
    }
    return useEditorStore.getState().documentId === turnState.documentId;
  };

  const transport = new DefaultChatTransport<FlockChatMessage>({
    api: CHAT_API_PATH,
    headers: (): Record<string, string> =>
      turnState.isMockEnabled ? { [MOCK_MODEL_HEADER]: "1" } : {},
    /*
      Resolved per request → the CURRENT document + selection at send time —
      unless a mid-turn draft switch deactivated the turn's document, in
      which case continuation rounds (tool results, approval resubmits — the
      approved sendTestEmail renders the REQUEST's document) keep describing
      the turn document via its RETAINED store instance (the chat's registry
      hold keeps it alive across the switch).
    */
    body: () => {
      const store = getIsTurnDocumentActive()
        ? useEditorStore.getState()
        : (getTurnDocumentStore()?.getState() ?? useEditorStore.getState());
      /*
        The provider preference rides every turn rather than being stashed
        server-side, so switching provider takes effect on the NEXT send with
        no reload. Omitted unless an owner deliberately picked one — the
        route treats it as a request and ignores it without a valid override.
      */
      const { chatProviderId } = getAppSettings();
      return {
        document: store.doc,
        /*
          WHICH document, not a second copy of it. The route reads
          `documents.isDemo` off this row to decide whether the turn may spend
          real inference (lib/demo/mock-authority.ts) — on /demo it may not.
          Sent from the same store the document came from, so a mid-turn draft
          switch cannot pair one draft's content with another's id.
        */
        ...(store.documentId === null ? {} : { documentId: store.documentId }),
        selectedBlockId: store.selectedBlockId ?? undefined,
        ...(chatProviderId === null ? {} : { providerId: chatProviderId }),
      };
    },
  });

  const chat = new Chat<FlockChatMessage>({
    id: chatId,
    transport,

    onFinish: ({ message, messages, finishReason, isAbort, isDisconnect, isError }) => {
      if (isDisposed) {
        return;
      }
      const activeTurn = turnState.activeTurn;
      if (activeTurn === null) {
        return;
      }
      if (isAbort || isDisconnect || isError) {
        turnLifecycle.onInterrupted({
          ...activeTurn,
          isRetrySafe: isInterruptedTurnRetrySafe({
            messages,
            userMessageId: activeTurn.userMessageId,
          }),
        });
        return;
      }
      /*
        Tool continuations are separate onFinish callbacks. Their assistant
        message is not durable until the logical turn has stopped requesting
        another round and no tool part is still awaiting input or output.
      */
      if (
        message.role !== "assistant" ||
        shouldDeferAssistantPersistence({
          message,
          messages,
          finishReason,
          isMockEnabled: turnState.isMockEnabled,
          autoContinuationCount: turnState.autoContinuationCount,
        })
      ) {
        return;
      }
      turnLifecycle.onAssistantTurn({ ...activeTurn, message });
      turnState.activeTurn = null;
    },
    onError: () => {
      if (isDisposed) {
        return;
      }
      const activeTurn = turnState.activeTurn;
      if (activeTurn !== null) {
        turnLifecycle.onInterrupted({
          ...activeTurn,
          isRetrySafe: isInterruptedTurnRetrySafe({
            messages: chat.messages,
            userMessageId: activeTurn.userMessageId,
          }),
        });
      }
    },

    /*
      Content ops and CLIENT-RESULT editor actions reach here at
      input-available (every tool with a server execute is skipped). Apply →
      report the outcome as the tool result (per the hook docs, addToolOutput
      is called without awaiting).
    */
    onToolCall: ({ toolCall }) => {
      if (toolCall.dynamic === true) {
        return;
      }
      const { toolName, toolCallId, input } = toolCall;
      const isClientResultEditorTool = CLIENT_RESULT_EDITOR_TOOL_NAMES.has(toolName);
      if (
        (!CONTENT_TOOL_NAMES.has(toolName) && !isClientResultEditorTool) ||
        appliedToolCallIds.has(toolCallId)
      ) {
        return;
      }
      appliedToolCallIds.add(toolCallId);

      /*
        undo / redo / createDraft: do the real work, then report what it did.
      */
      if (isClientResultEditorTool) {
        runClientResultEditorTool({ toolName, toolCallId, input });
        return;
      }

      /*
        Saved-section scaffolds (templateId "saved:<rowId>") resolve HERE,
        against the session's saved subtrees — the catalog resolver can't
        (owner V2 item 3). Checked before the registry gate on purpose: the
        registry resolves catalog ids only.
      */
      const scaffoldTemplateId =
        toolName === "scaffoldSection" && typeof input === "object" && input !== null
          ? (input as { templateId?: unknown }).templateId
          : undefined;
      if (typeof scaffoldTemplateId === "string" && isSavedSectionTemplateId(scaffoldTemplateId)) {
        applySavedSectionScaffold({ toolName, toolCallId, input });
        return;
      }

      const validation = validateAndClassifyOp(input);
      if (!validation.isValid) {
        void chat.addToolOutput({
          state: "output-error",
          tool: toolName,
          toolCallId,
          errorText: serializeApplyFailure(validation),
        });
        return;
      }

      /*
        Mid-turn draft switch: the ACTIVE store now renders a DIFFERENT
        document, so this op must land in the turn document's own retained
        store instance instead.
      */
      if (!getIsTurnDocumentActive()) {
        applyOpToInactiveTurnDocument({ toolName, toolCallId, operation: validation.operation });
        return;
      }

      const result = useEditorStore.getState().dispatch(validation.operation, {
        caller: "tool",
        author: "agent",
        authorId: chat.id,
        batchId: turnState.batchId,
        threadId: chat.id,
      });
      if (!result.isOk) {
        void chat.addToolOutput({
          state: "output-error",
          tool: toolName,
          toolCallId,
          errorText: serializeApplyFailure(result),
        });
        return;
      }
      /*
        Scroll-follow for streamed section inserts: when the agent composes
        an email one section per tool call (the per-section streaming
        contract), reveal each section as it lands so the user watches the
        email assemble. The APPLIED op is read from the dispatch result —
        scaffoldSection resolves to an addSection op inside dispatch.
      */
      const appliedOp = result.op;
      if (appliedOp.name === "addSection") {
        scrollBlockIntoView(appliedOp.section.id);
      }
      void chat.addToolOutput({
        tool: toolName,
        toolCallId,
        /*
          Content tools are declared `output: never` in the wire contract
          (they have no server execute); the client-side apply result is
          still reported so the model sees it on the continuation request.
        */
        output: { status: "applied", batchId: turnState.batchId } as never,
      });
    },

    /*
      The Phase 3.4 editor-command dispatcher.
    */
    onData: (dataPart) => {
      if (dataPart.type !== "data-editor-command") {
        return;
      }
      const parsed = editorCommandDataPartSchema.safeParse(dataPart.data);
      if (!parsed.success) {
        return;
      }
      const { toolCallId, command } = parsed.data;
      if (executedCommandToolCallIds.has(toolCallId)) {
        return;
      }
      executedCommandToolCallIds.add(toolCallId);
      /*
        generateImage is NOT a view command: its fulfilled payload (durable
        storage URL + alt) must land as a document op even after a mid-turn
        draft switch — a billed generation is never dropped. Handled before
        the active-canvas gate below.
      */
      if (command.type === "generateImage") {
        applyGeneratedImageCommand(command);
        return;
      }
      /*
        createPersona is a SESSION-level command (personas belong to the
        browser session, not to one draft), so a mid-turn draft switch never
        drops it. It was already executed server-side; the client's only job
        is to enable the new persona locally — exactly what the picker's
        create form does.
      */
      //
      /*
        createDraft used to be handled here too, off a server-written command
        part. It is now client-result: no such part is written, and the call
        is answered in `runClientResultEditorTool` by the browser that built
        the drafts. A branch here would be a second route to the same work,
        and the whole point is that there is only one.
      */
      if (command.type === "createPersona") {
        if (command.slug !== undefined) {
          setPersonaEnabled({ slug: command.slug, isEnabled: true });
        }
        return;
      }
      /*
        goToVersion is a DOCUMENT command pinned to the turn's origin draft
        (the generateImage routing rule): it rides the exact store machinery
        the history panel's restore uses — acting on the user's behalf per
        their request — against the active store, or the turn document's
        retained instance after a mid-turn draft switch.

        undo/redo used to be handled here too. They are now client-result
        tools handled in `onToolCall` (takeHistoryStep), because a command
        executed from a data part has nowhere to report its outcome and the
        model was being told the step succeeded regardless. goToVersion has
        the SAME defect — `restoreVersion` returns a real result and it is
        swallowed into a notice below — and is the obvious next one to move;
        it is left here for now only because it is approval-gated, so moving
        its execution also moves it relative to the approval halt.
      */
      if (command.type === "goToVersion") {
        const store = getIsTurnDocumentActive()
          ? useEditorStore.getState()
          : getTurnDocumentStore()?.getState();
        if (store === undefined) {
          return;
        }
        void store.restoreVersion(command.version).then((result) => {
          if (!result.isOk) {
            store.showNotice(result.message);
          }
        });
        return;
      }
      /*
        Mid-turn draft switch (owner decision, follow-on to the op pinning):
        editor commands act on the ACTIVE canvas — the viewport is ONE store
        field bound to the active draft (DraftFrameToolbar renders only on
        the active frame); there is no per-draft view state to retarget. So
        a view command from a turn pinned to a now-inactive draft is DROPPED
        outright: never flip a different draft's viewport. (Marked executed
        above on purpose — the command belonged to that moment of the turn,
        not to whenever its draft is next activated.) openPanel follows the
        same rule: a panel opened for a draft the user has left behind would
        be noise, not help.
      */
      if (!getIsTurnDocumentActive()) {
        return;
      }
      if (command.type === "showPreview") {
        useEditorStore.getState().setViewport(command.mode);
      }
      if (command.type === "openPanel") {
        requestUiSurfaceOpen(command.panel);
      }
      /*
        sendTestEmail: the real send already happened server-side (Phase
        8.1) — nothing to run client-side; the chip renders the result.
      */
    },

    sendAutomaticallyWhen: ({ messages }) => {
      /*
        Approval responses must always round-trip so the server can execute
        the approved sendTestEmail (or record the denial).
      */
      if (lastAssistantMessageIsCompleteWithApprovalResponses({ messages })) {
        return true;
      }
      /*
        The scripted mock re-emits the same tool call on every request —
        auto-continuing on tool results would loop, so only real models do.
      */
      if (turnState.isMockEnabled) {
        return false;
      }
      if (turnState.autoContinuationCount >= MAX_AUTO_CONTINUATIONS_PER_TURN) {
        return false;
      }
      if (lastAssistantMessageIsCompleteWithToolCalls({ messages })) {
        turnState.autoContinuationCount += 1;
        return true;
      }
      return false;
    },
  });

  /*
    Run ONE client-result editor action and report what it actually did back
    to the model.

    This is the whole point of `resultSource: "client"`. The work happens
    where it can be observed — a history step against the same store the
    toolbar's own buttons use, a draft creation against the drafts machinery
    — and the OUTCOME becomes the tool result. Nothing here reports a success
    it did not see.

    A NEGATIVE OUTCOME IS STILL A SUCCESSFUL TOOL CALL: "there was nothing
    left to undo", "two sections are still sample copy". Both are terminal and
    legitimate, and routing them through the error channel would invite the
    model to retry past them — which for createDraft would create a SECOND
    draft. See lib/history-step-report.ts and lib/create-draft-report.ts.
  */
  function runClientResultEditorTool({
    toolName,
    toolCallId,
    input,
  }: {
    toolName: keyof FlockChatTools;
    toolCallId: string;
    input: unknown;
  }): void {
    /*
      Through the SDK dispatcher, not straight to the store. Execution moved
      to the browser; the ACTION SPINE did not. `dispatchEditorAction`
      re-validates against the action's FULL schema and runs its authorization
      gate — the same guarantees the server branch gave this call before — so
      a gate added to undo later is enforced on this path too instead of being
      silently skipped by a hand-rolled shortcut.
    */
    const dispatched = dispatchEditorAction({
      registry: emailActionRegistry,
      name: toolName,
      input,
      context: {
        caller: "tool",
        author: "agent",
        authorId: chat.id,
        batchId: turnState.batchId,
        threadId: chat.id,
      },
    });
    if (!dispatched.isOk) {
      void chat.addToolOutput({
        state: "output-error",
        tool: toolName,
        toolCallId,
        errorText: serializeApplyFailure(dispatched),
      });
      return;
    }
    /*
      createDraft: build the drafts, then say what landed — real names, and
      per draft whether its copy came from the plan, from the draft the user
      is looking at, or from the template's sample text.

      THIS BRANCH IS THE ONLY THING THAT ANSWERS FOR createDraft. It is
      declared `resultSource: "client"` in the SDK's actions/builtins.ts, so
      the server registers no execute and writes no `data-editor-command`
      part: the call arrives here, and the composition plan reaches the drafts
      machinery only through the `input` dispatched above. There is no second
      route to fall back on — returning without reporting leaves the model
      with an open tool call, which is the honest state, where the old server
      route left it with a success nobody had verified.
    */
    const executorKind = getClientResultExecutorKind(dispatched.command.type);
    if (executorKind === "createDraft" && dispatched.command.type === "createDraft") {
      const command = dispatched.command;
      settleClientToolCall({
        tool: "createDraft",
        toolCallId,
        execute: () => createDrafts(command),
        toOutput: (outcome) => toCreateDraftToolOutput(outcome),
        addToolOutput: (output) => {
          void Promise.resolve(chat.addToolOutput(output as never)).catch(() => {});
        },
      });
      return;
    }
    /*
      applyThemeToDraft: resolve the theme NAME and the draft NAME against
      lists the browser holds, write the one applyTheme op into whichever
      draft that turned out to be, and report which draft and whether anything
      changed.

      Answered here for the same reason createDraft is: the server has no
      canvas listing, no brand kit, and no way to know whether the target
      draft was already wearing the theme — the three facts the result is made
      of. It also never sees a colour on this path, which is the point.
    */
    if (executorKind === "applyThemeToDraft" && dispatched.command.type === "applyThemeToDraft") {
      const command = dispatched.command;
      settleClientToolCall({
        tool: "applyThemeToDraft",
        toolCallId,
        execute: () => applyTheme(command),
        toOutput: (outcome) => toApplyThemeToolOutput(outcome),
        addToolOutput: (output) => {
          void Promise.resolve(chat.addToolOutput(output as never)).catch(() => {});
        },
      });
      return;
    }
    const direction = getHistoryStepDirection(dispatched.command.type);
    if (direction === null) {
      return; /* unreachable: the registry declares no other client-result action */
    }

    const store = getIsTurnDocumentActive()
      ? useEditorStore.getState()
      : getTurnDocumentStore()?.getState();
    if (store === undefined) {
      /*
        The turn's draft was closed mid-turn — say so rather than nothing.
      */
      reportHistoryStep({
        chat,
        toolCallId,
        direction,
        outcome: { isOk: false, reason: "draft_unavailable" },
      });
      return;
    }
    const step = direction === "undo" ? store.undo() : store.redo();
    void step.then((outcome) => reportHistoryStep({ chat, toolCallId, direction, outcome }));
  }

  /*
    Commit a FULFILLED generateImage command (agent path): the server already
    generated the image and uploaded it to Convex storage; the pure-doc
    consequence is ONE updateBlockProperties op { src, alt } dispatched with
    this turn's agent provenance through the normal validated spine — so it
    shares the turn's batch (revertable) and undo restores the previous src.
    Base64 never appears here: the command carries only the durable URL.
  */
  function applyGeneratedImageCommand(command: GenerateImageCommand): void {
    if (command.src === undefined) {
      /*
        Unfulfilled command — the executor failed before upload; the tool
        call errored server-side, so there is nothing to commit.
      */
      return;
    }
    const operation = {
      name: "updateBlockProperties",
      blockId: command.blockId,
      properties: { src: command.src, alt: command.alt ?? "" },
    } as const;
    const context: ActionContext = {
      caller: "tool",
      author: "agent",
      authorId: chat.id,
      batchId: turnState.batchId,
      threadId: chat.id,
    };
    if (getIsTurnDocumentActive()) {
      useEditorStore.getState().dispatch(operation, context);
      return;
    }
    /*
      Mid-turn draft switch: land the op in the turn document's RETAINED
      store instance (same path as content ops after a switch — the store's
      own overlay submits and reconciles). No tool output to report: the
      editor tool already returned its result server-side. A missing store
      means the turn was never pinned — nothing to commit into.
    */
    getTurnDocumentStore()?.getState().dispatch(operation, context);
  }

  /*
    Resolve and apply one saved-section scaffold call (owner V2 item 3):
    find the row in the reactive cache, plan the ONE restoreBlocks op with
    fresh ids honoring the call's scaffold position (SDK-shared resolution),
    and dispatch with this turn's agent provenance — the same store-routing
    rules as every other content op (active document, else the turn's
    retained instance). Missing rows report a retryable tool error so the
    model can fall back to the catalog. Every successful insert bumps the
    row's usage stats (fails soft).
  */
  function applySavedSectionScaffold({
    toolName,
    toolCallId,
    input,
  }: {
    toolName: keyof FlockChatTools;
    toolCallId: string;
    input: unknown;
  }): void {
    const { templateId, position } = input as {
      templateId: string;
      position?: ScaffoldSectionPosition;
    };
    const rowId = templateId.slice(SAVED_SECTION_TEMPLATE_ID_PREFIX.length);
    const row = savedSectionsRuntime.rows.find((candidate) => candidate._id === rowId);

    const reportFailure = (message: string): void => {
      void chat.addToolOutput({
        state: "output-error",
        tool: toolName,
        toolCallId,
        errorText: serializeApplyFailure({
          failureKind: "retryable",
          errors: [{ code: "target_not_found", message }],
        }),
      });
    };

    if (row === undefined) {
      reportFailure(
        `No saved section "${templateId}" exists in this session's saved list — use an id exactly as listed under "Saved sections" in the document context, or a catalog templateId.`,
      );
      return;
    }

    const isTurnDocumentActive = getIsTurnDocumentActive();
    const store = isTurnDocumentActive
      ? useEditorStore.getState()
      : getTurnDocumentStore()?.getState();
    if (store === undefined) {
      reportFailure("The document this turn was editing is no longer available.");
      return;
    }

    const plan = buildInsertSavedSectionPlan({
      doc: store.doc,
      savedBlocks: row.blocks as Block[],
      selectedBlockId: null,
      position: position ?? "bottom",
    });
    if (plan === null) {
      reportFailure(
        "The saved section could not be inserted at that position — anchor to an existing top-level section id, or use \"top\"/\"bottom\".",
      );
      return;
    }

    const result = store.dispatch(plan.op, {
      caller: "tool",
      author: "agent",
      authorId: chat.id,
      batchId: turnState.batchId,
      threadId: chat.id,
    });
    if (!result.isOk) {
      void chat.addToolOutput({
        state: "output-error",
        tool: toolName,
        toolCallId,
        errorText: serializeApplyFailure(result),
      });
      return;
    }
    if (isTurnDocumentActive) {
      scrollBlockIntoView(plan.sectionId);
    }
    savedSectionsRuntime.recordUse(row._id);
    void chat.addToolOutput({
      tool: toolName,
      toolCallId,
      output: { status: "applied", batchId: turnState.batchId } as never,
    });
  }

  /*
    Apply one content op to the turn's document AFTER a mid-turn draft
    switch: dispatch into the turn document's RETAINED store instance (the
    chat's registry hold keeps it alive) — the exact same validated dispatch
    path as the active branch, overlay/submit/reconciliation included, and
    with any human edits made before the switch already in the store's doc.
    When the draft is reactivated, StudioShell re-feeds the same instance
    with snapshots and the overlay rebases — the turn's ops are simply
    there. The op is reported exactly like the active path (optimistic:
    local apply result; the overlay drops-and-notices on a server reject).
  */
  function applyOpToInactiveTurnDocument({
    toolName,
    toolCallId,
    operation,
  }: {
    toolName: keyof FlockChatTools;
    toolCallId: string;
    operation: DispatchableOp;
  }): void {
    const turnStore = getTurnDocumentStore();
    if (turnStore === null) {
      /*
        Unreachable in practice (the pin + hold are taken at turn start);
        reported rather than thrown so a bad state never kills the stream
        handler.
      */
      void chat.addToolOutput({
        state: "output-error",
        tool: toolName,
        toolCallId,
        errorText: serializeApplyFailure({
          failureKind: "terminal",
          errors: [
            {
              code: "target_not_found",
              message: "The document this turn was editing is no longer available.",
            },
          ],
        }),
      });
      return;
    }

    const result = turnStore.getState().dispatch(operation, {
      caller: "tool",
      author: "agent",
      authorId: chat.id,
      batchId: turnState.batchId,
      threadId: chat.id,
    });
    if (!result.isOk) {
      void chat.addToolOutput({
        state: "output-error",
        tool: toolName,
        toolCallId,
        errorText: serializeApplyFailure(result),
      });
      return;
    }
    void chat.addToolOutput({
      tool: toolName,
      toolCallId,
      output: { status: "applied", batchId: turnState.batchId } as never,
    });
  }

  return {
    chat,
    dispose: () => {
      if (isDisposed) {
        return;
      }
      isDisposed = true;
      turnState.activeTurn = null;
      void chat.stop();
      holdTurnDocument(null);
    },
    beginUserTurn: (input) => {
      if (isDisposed) {
        return;
      }
      const { documentId } = useEditorStore.getState();
      turnState.batchId = crypto.randomUUID();
      turnState.autoContinuationCount = 0;
      /*
        Pin this turn to the document it starts in, and take a registry
        hold so a mid-turn draft switch cannot dispose its store instance
        (see turnState). The previous turn's hold is released here.
      */
      turnState.documentId = documentId;
      turnState.activeTurn = input;
      holdTurnDocument(documentId);
    },
    setIsMockEnabled: (isMockEnabled) => {
      turnState.isMockEnabled = isMockEnabled;
    },
    setSavedSectionsRuntime: (runtime) => {
      savedSectionsRuntime = runtime;
    },
    setCreateDrafts: (nextCreateDrafts) => {
      createDrafts = nextCreateDrafts;
    },
    setApplyTheme: (nextApplyTheme) => {
      applyTheme = nextApplyTheme;
    },
    getTurnBatchId: () => turnState.batchId,
    setTurnLifecycle: (nextLifecycle) => {
      turnLifecycle = nextLifecycle;
    },
  };
}

/*
  True while the LAST assistant message holds a tool approval the user has
  not finished resolving: `approval-requested` (waiting on Approve/Deny) or
  `approval-responded` (answered, but the auto-resubmit round has not yet
  rewritten the part with its outcome). Both must hold the message queue —
  a queued user message must never auto-send past a pending approval, and
  the responded→resubmit window is a race the queue must not slip through.
*/
function getHasPendingApproval(messages: FlockChatMessage[]): boolean {
  const lastMessage = messages.at(-1);
  if (lastMessage === undefined || lastMessage.role !== "assistant") {
    return false;
  }
  return lastMessage.parts.some(
    (part) =>
      isStaticToolUIPart(part) &&
      (part.state === "approval-requested" || part.state === "approval-responded"),
  );
}

export interface FlockChat {
  messages: FlockChatMessage[];
  status: "submitted" | "streaming" | "ready" | "error";
  error: Error | undefined;
  isReady: boolean;
  /*
    Send one user text message (starts a fresh agent batch).
  */
  sendUserMessage: (text: string) => void;
  /*
    Respond to a tool approval request (sendTestEmail).
  */
  respondToApproval: (input: { approvalId: string; isApproved: boolean }) => void;
  /*
    Reactive: an approval chip is on screen (or mid-resubmit) — see above.
  */
  hasPendingApproval: boolean;
  /*
    LIVE idle check against the Chat instance (not render-stale props):
    status is "ready" AND no approval is pending. The message queue re-checks
    this at dispatch time so mid-turn "ready" flickers (the SDK sets status
    "ready" before evaluating sendAutomaticallyWhen between continuation
    rounds) and StrictMode double-effects can never double-send.
  */
  getIsAgentIdle: () => boolean;
  /*
    Test-only lever (no UI since the dev "mock" checkbox was removed): force
    the deterministic mock model via the x-flock-mock header. The server
    still falls back to the mock automatically when no API key is set.
  */
  isMockEnabled: boolean;
  setIsMockEnabled: (isMockEnabled: boolean) => void;
  retryLastTurn: () => void;
  isRetryAvailable: boolean;
  retryNotice: string | undefined;
  persistenceError: string | undefined;
  retryPersistence: () => void;
  threadProvisioningError: string | undefined;
  retryThreadProvisioning: () => void;
}

export function useFlockChat(): FlockChat {
  const canvasId = useEditorStore((state) => state.canvasId);
  const editorSessionId = useEditorStore((state) => state.authorId);
  const sessionId = editorSessionId;
  const chatThread = useQuery(
    api.chat.getThread,
    canvasId !== null && sessionId !== null ? { canvasId, sessionId } : "skip",
  );
  const ensureChatThread = useMutation(api.chat.getOrCreateThread);
  const persistedTurns = useQuery(
    api.chat.listTurns,
    canvasId !== null && sessionId !== null ? { canvasId, sessionId } : "skip",
  );
  const [ensuredThread, setEnsuredThread] = useState<{
    canvasId: Id<"canvases">;
    threadId: string;
  } | null>(null);
  const [threadProvisioningAttempt, setThreadProvisioningAttempt] = useState(0);
  const [threadProvisioningError, setThreadProvisioningError] = useState<
    { key: string; message: string } | undefined
  >(undefined);
  const provisioningKey = canvasId === null ? null : String(canvasId);
  useEffect(() => {
    if (canvasId === null || sessionId === null || chatThread === undefined) {
      return;
    }
    if (chatThread !== null || ensuredThread?.canvasId === canvasId) {
      return;
    }
    void ensureChatThread({ canvasId, sessionId })
      .then((thread) => {
        setEnsuredThread({ canvasId, threadId: thread._id });
      })
      .catch(() => {
        if (provisioningKey !== null) {
          setThreadProvisioningError({
            key: provisioningKey,
            message: "This canvas conversation could not be loaded. Retry to continue.",
          });
        }
      });
  }, [canvasId, chatThread, ensureChatThread, ensuredThread, provisioningKey, sessionId, threadProvisioningAttempt]);

  const resolvedThread =
    chatThread !== null && chatThread !== undefined && chatThread.canvasId === canvasId
      ? chatThread
      : ensuredThread?.canvasId === canvasId
        ? { _id: ensuredThread.threadId }
        : null;
  const threadId = resolvedThread?._id ?? null;
  const retryTurnRef = useRef<{
    logicalTurnId: string;
    userMessageId: string;
    text: string;
  } | null>(null);
  const currentThreadKey = canvasId !== null && threadId !== null ? `${canvasId}:${threadId}` : null;
  const [retryState, setRetryState] = useState<{
    key: string;
    turn: { logicalTurnId: string; userMessageId: string; text: string };
    isRetrySafe: boolean;
  } | null>(null);
  const [persistenceError, setPersistenceError] = useState<
    { key: string; message: string } | undefined
  >(undefined);
  const pendingPersistenceRef = useRef(new Map<string, PendingPersistence>());
  const persistenceRef = useRef({
    canvasId,
    sessionId,
    threadKey: currentThreadKey,
    persistFinalizedTurn: null as
      | ((args: {
          canvasId: Id<"canvases">;
          sessionId: string;
          turnId: string;
          idempotencyKey: string;
          role: "user" | "assistant";
          content: string;
        }) => Promise<unknown>)
      | null,
  });
  const persistFinalizedTurn = useMutation(api.chat.persistFinalizedTurn);
  useEffect(() => {
    persistenceRef.current = {
      ...persistenceRef.current,
      canvasId,
      sessionId,
      threadKey: currentThreadKey,
      persistFinalizedTurn,
    };
  }, [canvasId, currentThreadKey, persistFinalizedTurn, sessionId]);

  function getPersistenceKey(input: PersistedTurnInput): string {
    return `${input.canvasId}:${input.idempotencyKey}`;
  }

  function hasPendingPersistenceForThread(threadKey: string): boolean {
    return Array.from(pendingPersistenceRef.current.values()).some(
      (pending) => pending.threadKey === threadKey,
    );
  }

  const persistTurn = useCallback(function persistTurn(
    input: PersistedTurnInput,
    threadKey: string,
  ): void {
    const persist = persistenceRef.current.persistFinalizedTurn;
    if (persist === null) {
      return;
    }
    const persistenceKey = getPersistenceKey(input);
    pendingPersistenceRef.current.set(persistenceKey, { input, threadKey });
    void persist(input)
      .then(() => {
        pendingPersistenceRef.current.delete(persistenceKey);
        setPersistenceError((currentError) =>
          currentError?.key === threadKey && !hasPendingPersistenceForThread(threadKey)
            ? undefined
            : currentError,
        );
      })
      .catch(() => {
        if (persistenceRef.current.threadKey === threadKey) {
          setPersistenceError({
            key: threadKey,
            message: "This chat turn could not be saved. Retry saving it.",
          });
        }
      });
  }, []);

  const lifecycle = useMemo<ChatTurnLifecycle>(
    () => {
      const origin = {
        canvasId,
        sessionId,
        threadKey: currentThreadKey,
      };
      const isCurrentOrigin = (): boolean => {
        const current = persistenceRef.current;
        return isChatLifecycleCurrent({
          originCanvasId: origin.canvasId,
          originSessionId: origin.sessionId,
          originThreadKey: origin.threadKey,
          currentCanvasId: current.canvasId,
          currentSessionId: current.sessionId,
          currentThreadKey: current.threadKey,
        });
      };

      return {
        onUserTurn: () => {},
        onAssistantTurn: ({ logicalTurnId, message }) => {
          if (!isCurrentOrigin()) {
            return;
          }
          retryTurnRef.current = null;
          setRetryState((state) =>
            state?.key === persistenceRef.current.threadKey ? null : state,
          );
          const {
            canvasId: currentCanvasId,
            sessionId: currentSessionId,
            threadKey,
          } = persistenceRef.current;
          if (
            currentCanvasId === null ||
            currentSessionId === null ||
            threadKey === null
          ) {
            return;
          }
          const content = getChatMessageText(message);
          if (content.length === 0) {
            return;
          }
          const input = {
            canvasId: currentCanvasId,
            sessionId: currentSessionId,
            turnId: message.id,
            idempotencyKey: `assistant:${logicalTurnId}`,
            role: "assistant",
            content,
          } satisfies PersistedTurnInput;
          persistTurn(input, threadKey);
        },
        onInterrupted: (turn) => {
          if (!isCurrentOrigin()) {
            return;
          }
          retryTurnRef.current = turn;
          const key = persistenceRef.current.threadKey;
          if (key !== null) {
            setRetryState({ key, turn, isRetrySafe: turn.isRetrySafe });
          }
        },
      };
    },
    [canvasId, currentThreadKey, persistTurn, sessionId],
  );
  const controller = useMemo(
    () =>
      threadId === null
        ? null
        : createFlockChatController({
            chatId: threadId,
          }),
    [threadId],
  );
  const [isMockEnabled, setIsMockEnabledState] = useState(false);

  const chat = useChat<FlockChatMessage>(controller === null ? undefined : { chat: controller.chat });
  const { setMessages } = chat;

  const [hydratedThreadKey, setHydratedThreadKey] = useState<string | null>(null);
  const hydratedSnapshotRef = useRef<{
    threadKey: string;
    turns: readonly PersistedChatTurn[];
  } | null>(null);
  useEffect(() => {
    if (controller === null || persistedTurns === undefined) {
      return;
    }
    if (currentThreadKey === null) {
      return;
    }
    const isSamePersistedSnapshot =
      hydratedSnapshotRef.current?.threadKey === currentThreadKey &&
      hydratedSnapshotRef.current.turns === persistedTurns;
    if (
      !shouldApplyChatHydration({
        currentThreadKey,
        hydratedThreadKey,
        persistedTurns,
        isSamePersistedSnapshot,
      })
    ) {
      return;
    }
    hydratedSnapshotRef.current = { threadKey: currentThreadKey, turns: persistedTurns };
    setMessages((liveMessages) =>
      mergePersistedChatMessages(toPersistedChatMessages(persistedTurns), liveMessages),
    );
    queueMicrotask(() => {
      setHydratedThreadKey(currentThreadKey);
    });
  }, [controller, currentThreadKey, hydratedThreadKey, persistedTurns, setMessages]);
  useEffect(() => {
    if (controller !== null) {
      controller.setTurnLifecycle(lifecycle);
    }
  }, [controller, lifecycle]);
  useEffect(() => {
    if (controller === null) {
      return;
    }
    return () => {
      controller.dispose();
    };
  }, [controller]);

  /*
    Saved-sections runtime for the agent's `saved:<id>` scaffold calls:
    reactive rows (a delete/save reflects immediately) + the fails-soft
    usage recorder, pushed into the controller's closure on every change.
  */
  const savedSections = useQuery(
    api.savedSections.listForSession,
    sessionId === null ? "skip" : { sessionId },
  );
  const recordSavedSectionUse = useMutation(api.savedSections.recordUse);
  useEffect(() => {
    if (controller === null) {
      return;
    }
    controller.setSavedSectionsRuntime({
      rows: savedSections ?? [],
      recordUse: (savedSectionId) => {
        if (sessionId !== null) {
          void recordSavedSectionUse({ sessionId, savedSectionId }).catch(() => {});
        }
      },
    });
  }, [controller, savedSections, recordSavedSectionUse, sessionId]);

  /*
    The createDraft command executor (agent parity): the DraftSelector's own
    machinery, on the active canvas, WITHOUT activating the new drafts (the
    user's current draft stays where they are; the drafts bar updates
    reactively). The loop itself lives beside that machinery in
    drafts/create-agent-drafts — a composed command builds whole emails there,
    a bare count still creates starter drafts.
  */
  const convexClient = useConvex();
  /*
    The canvas's LIVE themes, reactive: binding a kit, saving one, or deleting
    a theme changes what the agent may name on the very next call, with no
    reload — the same subscription the theme menu renders from, so the agent
    and the dropdown can never disagree about what this canvas has.
  */
  const { brandKit } = useActiveBrandKit();
  const kitThemes: NamedTheme[] = readCanvasThemeCandidates(brandKit);
  useEffect(() => {
    if (controller === null) {
      return;
    }
    controller.setCreateDrafts(async (command) => {
      const { canvasId, documentId, doc } = useEditorStore.getState();
      if (canvasId === null || documentId === null) {
        return {
          ...createEmptyDraftOutcome(),
          failureNotice: "The editor isn't connected to a canvas yet.",
        };
      }
      const outcome = await createAgentDrafts({
        convexClient,
        canvasId,
        sourceDocumentId: documentId,
        sessionId: getOrCreateSessionId(),
        command,
        sourceDoc: doc,
        /*
          The theme half of the same argument the carry-over flag makes: the
          page this turn read exists ONLY in the transcript, and it is read at
          COMPOSITION time because the ingestion result and the createDraft
          call arrive in the same assistant message. Consulted only when the
          command names it — reading a page never restyles a draft by itself.
        */
        pageTheme: readTurnPageTheme({ messages: controller.chat.messages }),
        kitThemes,
        sourceGlobals: readDraftGlobals(doc),
        /*
          Read HERE, at composition time, not at send time: the ingestion tool
          result and this createDraft call arrive in the same assistant
          message, so the answer only becomes true partway through the turn.
          It decides whether the source draft's copy may fill the plan's gaps
          — see lib/ingested-source.ts for why the transcript is the only
          place this fact exists.
        */
        hasIngestedSource: getHasIngestedSourceInTurn({ messages: controller.chat.messages }),
        authorId: controller.chat.id,
      });
      if (outcome.failureNotice !== null) {
        useEditorStore.getState().showNotice(outcome.failureNotice);
      }
      return outcome;
    });
  }, [controller, convexClient, kitThemes]);

  /*
    The applyThemeToDraft executor. "Current" here means the draft the user is
    LOOKING AT — the active store — rather than the draft the turn started in,
    because the word is the user's and that is what they mean by it. Every
    other draft is reached by name, through the canvas's own listing.
  */
  useEffect(() => {
    if (controller === null) {
      return;
    }
    controller.setApplyTheme(async (command) => {
      const { canvasId, documentId, doc } = useEditorStore.getState();
      if (canvasId === null) {
        return { kind: "unreachable" };
      }
      const outcome = await applyThemeToDraft({
        convexClient,
        canvasId,
        sessionId: getOrCreateSessionId(),
        command,
        currentDocumentId: documentId,
        currentGlobals: readDraftGlobals(doc),
        pageTheme: readTurnPageTheme({ messages: controller.chat.messages }),
        kitThemes,
        authorId: controller.chat.id,
        batchId: controller.getTurnBatchId(),
      });
      return outcome;
    });
  }, [controller, convexClient, kitThemes]);

  const sendUserMessage = (text: string): void => {
    const trimmedText = text.trim();
    if (trimmedText.length === 0 || controller === null || !isReady) {
      return;
    }
    const logicalTurnId = crypto.randomUUID();
    const userMessageId = `user:${logicalTurnId}`;
    const turn = { logicalTurnId, userMessageId, text: trimmedText };
    retryTurnRef.current = null;
    setRetryState(null);
    controller.beginUserTurn(turn);
    const { canvasId: currentCanvasId, sessionId: currentSessionId, persistFinalizedTurn: persist } =
      persistenceRef.current;
    if (currentCanvasId !== null && currentSessionId !== null && persist !== null) {
      const input = {
        canvasId: currentCanvasId,
        sessionId: currentSessionId,
        turnId: userMessageId,
        idempotencyKey: `user:${logicalTurnId}`,
        role: "user",
        content: trimmedText,
      } satisfies PersistedTurnInput;
      if (currentThreadKey !== null) {
        persistTurn(input, currentThreadKey);
      }
    }
    chat.clearError();
    /*
      A drafts-menu AI send (pending-generation-request.ts) carries a second,
      machine-readable part: `{ kind, sourceDocumentId, direction }`. The server
      expands it into the targeted brief; the transcript renders `text` parts
      only, so nothing internal is ever shown. Read-and-clear — an ordinary
      typed message is unchanged.
    */
    const generationRequest = takeGenerationRequest();
    if (generationRequest === null) {
      void chat.sendMessage(createUserChatMessage({ id: userMessageId, text: trimmedText }));
      return;
    }
    void chat.sendMessage(
      createUserChatMessage({
        id: userMessageId,
        text: trimmedText,
        generationRequest,
      }),
    );
  };

  const respondToApproval = ({
    approvalId,
    isApproved,
  }: {
    approvalId: string;
    isApproved: boolean;
  }): void => {
    if (controller === null || !isReady) {
      return;
    }
    void chat.addToolApprovalResponse({ id: approvalId, approved: isApproved });
  };

  const setIsMockEnabled = (nextIsMockEnabled: boolean): void => {
    controller?.setIsMockEnabled(nextIsMockEnabled);
    setIsMockEnabledState(nextIsMockEnabled);
  };

  const getIsAgentIdle = (): boolean =>
    controller !== null &&
    controller.chat.status === "ready" &&
    !getHasPendingApproval(controller.chat.messages);

  const retryLastTurn = (): void => {
    const turn = retryTurnRef.current;
    const isRetrySafe = retryState?.key === currentThreadKey && retryState.isRetrySafe;
    if (turn === null || controller === null || !isReady || !isRetrySafe) {
      return;
    }
    controller.beginUserTurn(turn);
    setRetryState(null);
    chat.clearError();
    void chat.sendMessage({ text: turn.text, messageId: turn.userMessageId });
  };

  const retryPersistence = (): void => {
    const persist = persistenceRef.current.persistFinalizedTurn;
    const threadKey = persistenceRef.current.threadKey;
    if (persist === null || threadKey === null) {
      return;
    }
    const pending = Array.from(pendingPersistenceRef.current.values()).filter(
      (item) => item.threadKey === threadKey,
    );
    for (const item of pending) {
      persistTurn(item.input, threadKey);
    }
  };

  const retryThreadProvisioning = useCallback((): void => {
    setThreadProvisioningError(undefined);
    setThreadProvisioningAttempt((attempt) => attempt + 1);
  }, []);

  const isReady =
    controller !== null &&
    threadId !== null &&
    persistedTurns !== undefined &&
    hydratedThreadKey === currentThreadKey;

  return {
    messages: isReady ? chat.messages : [],
    status: isReady ? chat.status : "ready",
    error: isReady ? chat.error : undefined,
    isReady,
    sendUserMessage,
    respondToApproval,
    hasPendingApproval: getHasPendingApproval(chat.messages),
    getIsAgentIdle,
    isMockEnabled,
    setIsMockEnabled,
    retryLastTurn,
    isRetryAvailable: isReady && retryState?.key === currentThreadKey && retryState.isRetrySafe,
    retryNotice:
      isReady && retryState?.key === currentThreadKey && !retryState.isRetrySafe
        ? "This response may have already changed your email. Flock won't replay it automatically; send a fresh instruction if you still need a change."
        : undefined,
    persistenceError:
      persistenceError?.key === currentThreadKey ? persistenceError.message : undefined,
    retryPersistence,
    threadProvisioningError: getVisibleThreadProvisioningError({
      error: threadProvisioningError?.message,
      errorKey: threadProvisioningError?.key,
      currentCanvasKey: provisioningKey,
      hasThread: chatThread !== null || ensuredThread?.canvasId === canvasId,
    }),
    retryThreadProvisioning,
  };
}
