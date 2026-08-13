"use client";

import { useEffect, useState } from "react";
import { Chat, useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  isStaticToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useConvex, useMutation, useQuery } from "convex/react";
import {
  emailActionRegistry,
  isSavedSectionTemplateId,
  SAVED_SECTION_TEMPLATE_ID_PREFIX,
  type ActionContext,
  type ActionDispatchError,
  type ActionFailureKind,
  type Block,
  type CreateDraftCommand,
  type GenerateImageCommand,
  type ScaffoldSectionPosition,
} from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { buildInsertSavedSectionPlan } from "@/lib/saved-sections";
import {
  CHAT_API_PATH,
  editorCommandDataPartSchema,
  GENERATION_REQUEST_DATA_PART_TYPE,
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
  type EditorStoreApi,
} from "@/lib/editor-store";
import { setPersonaEnabled } from "@/lib/personas/enabled-personas";
import { getOrCreateSessionId } from "@/lib/session";
import { requestUiSurfaceOpen } from "@/lib/ui-surfaces";
import { getAppSettings } from "../demo/app-settings";
import { scrollBlockIntoView } from "../add-blocks/scroll-block-into-view";
import { createAgentDrafts } from "../drafts/create-agent-drafts";
import { takeGenerationRequest } from "./pending-generation-request";

/**
 * The Phase 3 chat brain: wires AI SDK v7 `useChat` to the editor store.
 *
 * - Request body: current document + selectedBlockId are read from the store
 *   AT SEND TIME (the transport's `body` resolvable runs per request).
 * - Content ops (`tool-<name>` parts, no server execute): applied in
 *   `onToolCall` at input-available — validateAndClassifyOp gate → store
 *   dispatch with agent provenance (author "agent", one batchId per turn) —
 *   then the outcome is reported back with `addToolOutput` so the model sees
 *   apply results in-loop (`sendAutomaticallyWhen` closes the loop).
 * - Editor commands (`data-editor-command` parts): dispatched in `onData`
 *   (showPreview flips the canvas viewport; sendTestEmail is a Phase 8 stub).
 * - sendTestEmail approvals: `addToolApprovalResponse` is exposed for the
 *   approval chip; a response auto-resubmits so the server can execute.
 */

/** Tool names the CLIENT applies (content ops — no execute() on the server). */
const CONTENT_TOOL_NAMES: ReadonlySet<string> = new Set(
  emailActionRegistry.actions
    .filter((action) => action.kind === "content")
    .map((action) => action.name),
);

/**
 * Ceiling on automatic follow-up requests per user turn. The loop normally
 * terminates when the model responds without tool calls; this cap bounds the
 * worst case (a model that keeps emitting ops forever).
 */
const MAX_AUTO_CONTINUATIONS_PER_TURN = 1;

/** Structured tool-result payload for a failed client-side op application. */
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

/**
 * The Chat instance plus methods over the mutable per-turn bookkeeping its
 * callbacks close over. Created ONCE per panel mount (useState initializer) —
 * plain closures, so no render-time ref access and no state-object mutation.
 */
interface FlockChatController {
  chat: Chat<FlockChatMessage>;
  /** Start a user-initiated turn: fresh agent batchId + continuation budget. */
  beginUserTurn: () => void;
  /** Dev-only x-flock-mock switch, read by the transport at request time. */
  setIsMockEnabled: (isMockEnabled: boolean) => void;
  /**
   * Keep the controller's saved-sections runtime current (reactive rows +
   * the usage-stat recorder) — the agent path resolves scaffoldSection
   * `saved:<id>` calls against this cache synchronously, preserving the
   * per-section streaming order.
   */
  setSavedSectionsRuntime: (runtime: SavedSectionsRuntime) => void;
  /**
   * Inject the createDraft command's executor (agent parity): the hook owns
   * the Convex client, so it builds the drafts-machinery loop and hands it
   * to the controller's onData closure here. Takes the whole command — a
   * composed createDraft carries the plan its new drafts are built from.
   */
  setCreateDrafts: (createDrafts: (command: CreateDraftCommand) => Promise<void>) => void;
}

interface SavedSectionsRuntime {
  rows: Doc<"savedSections">[];
  /** Fails-soft useCount/lastUsedAtMs bump (owner V2 item 4). */
  recordUse: (savedSectionId: Id<"savedSections">) => void;
}

function createFlockChatController(): FlockChatController {
  // toolCallIds already applied / commands already executed (same-id stream
  // rewrites and repeated deliveries must not double-apply).
  const appliedToolCallIds = new Set<string>();
  const executedCommandToolCallIds = new Set<string>();

  // One batchId per user-initiated turn: every agent op the turn produces
  // (including auto-continuation rounds) shares it, so Phase 4 can revert the
  // whole AI turn in one step.
  //
  // `documentId` pins the turn to the document it STARTED in (the mid-turn
  // draft-switch fix): the drafts bar can retarget the active store while a
  // turn is still streaming, and without the pin the turn's remaining ops
  // would apply to whichever draft is active. The pin is backed by a
  // REGISTRY HOLD (drafts v2 per-document store factory): beginUserTurn
  // acquires the turn document's store instance, so a draft switch cannot
  // dispose it — the turn's remaining ops dispatch into that retained
  // instance (full local-overlay semantics, including human edits made
  // before the switch), and the draft simply shows them when reactivated.
  // The hold is released when the NEXT user turn begins.
  const turnState = {
    isMockEnabled: false,
    batchId: crypto.randomUUID(),
    autoContinuationCount: 0,
    documentId: null as Id<"documents"> | null,
  };

  let heldTurnDocumentId: Id<"documents"> | null = null;

  // Reactive saved-sections cache (kept current by setSavedSectionsRuntime):
  // saved scaffold calls resolve against it synchronously — never an async
  // fetch that could reorder a per-section streaming turn's inserts.
  let savedSectionsRuntime: SavedSectionsRuntime = { rows: [], recordUse: () => {} };

  // The createDraft command executor (injected by the hook — it owns the
  // Convex client). No-op until injected; the hook wires it on mount.
  let createDrafts: (command: CreateDraftCommand) => Promise<void> = async () => {};

  /** Swap the chat's registry hold from the previous turn's doc to `documentId`. */
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

  /** The turn document's retained store instance (null only if never pinned). */
  const getTurnDocumentStore = (): EditorStoreApi | null =>
    turnState.documentId !== null ? peekEditorStore(turnState.documentId) : null;

  /**
   * True while the USER is still on the turn's own document. The ?doc= param
   * is the authoritative signal: a drafts-bar switch updates it SYNCHRONOUSLY
   * (pushState), while the store re-connects only when the incoming draft's
   * first snapshot arrives — a window long enough for a streamed op or
   * command to slip through and hit the wrong draft. Store fallback covers
   * non-browser contexts.
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
    // Resolved per request → the CURRENT document + selection at send time —
    // unless a mid-turn draft switch deactivated the turn's document, in
    // which case continuation rounds (tool results, approval resubmits — the
    // approved sendTestEmail renders the REQUEST's document) keep describing
    // the turn document via its RETAINED store instance (the chat's registry
    // hold keeps it alive across the switch).
    body: () => {
      const store = getIsTurnDocumentActive()
        ? useEditorStore.getState()
        : (getTurnDocumentStore()?.getState() ?? useEditorStore.getState());
      // The provider preference rides every turn rather than being stashed
      // server-side, so switching provider takes effect on the NEXT send with
      // no reload. Omitted unless an owner deliberately picked one — the
      // route treats it as a request and ignores it without a valid override.
      const { chatProviderId } = getAppSettings();
      return {
        document: store.doc,
        selectedBlockId: store.selectedBlockId ?? undefined,
        ...(chatProviderId === null ? {} : { providerId: chatProviderId }),
      };
    },
  });

  const chat = new Chat<FlockChatMessage>({
    transport,

    // Content ops reach here at input-available (editor/analysis tools have a
    // server execute and are skipped). Apply → report the outcome as the tool
    // result (per the hook docs, addToolOutput is called without awaiting).
    onToolCall: ({ toolCall }) => {
      if (toolCall.dynamic === true) {
        return;
      }
      const { toolName, toolCallId, input } = toolCall;
      if (!CONTENT_TOOL_NAMES.has(toolName) || appliedToolCallIds.has(toolCallId)) {
        return;
      }
      appliedToolCallIds.add(toolCallId);

      // Saved-section scaffolds (templateId "saved:<rowId>") resolve HERE,
      // against the session's saved subtrees — the catalog resolver can't
      // (owner V2 item 3). Checked before the registry gate on purpose: the
      // registry resolves catalog ids only.
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

      // Mid-turn draft switch: the ACTIVE store now renders a DIFFERENT
      // document, so this op must land in the turn document's own retained
      // store instance instead.
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
      // Scroll-follow for streamed section inserts: when the agent composes
      // an email one section per tool call (the per-section streaming
      // contract), reveal each section as it lands so the user watches the
      // email assemble. The APPLIED op is read from the dispatch result —
      // scaffoldSection resolves to an addSection op inside dispatch.
      const appliedOp = result.logEntry.op;
      if (appliedOp.name === "addSection") {
        scrollBlockIntoView(appliedOp.section.id);
      }
      void chat.addToolOutput({
        tool: toolName,
        toolCallId,
        // Content tools are declared `output: never` in the wire contract
        // (they have no server execute); the client-side apply result is
        // still reported so the model sees it on the continuation request.
        output: { status: "applied", batchId: turnState.batchId } as never,
      });
    },

    // The Phase 3.4 editor-command dispatcher.
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
      // generateImage is NOT a view command: its fulfilled payload (durable
      // storage URL + alt) must land as a document op even after a mid-turn
      // draft switch — a billed generation is never dropped. Handled before
      // the active-canvas gate below.
      if (command.type === "generateImage") {
        applyGeneratedImageCommand(command);
        return;
      }
      // createPersona / createDraft are SESSION-level commands (personas and
      // drafts belong to the browser session/canvas, not to one draft), so a
      // mid-turn draft switch never drops them. createPersona was already
      // executed server-side; the client's only job is to enable the new
      // persona locally — exactly what the picker's create form does.
      if (command.type === "createPersona") {
        if (command.slug !== undefined) {
          setPersonaEnabled({ slug: command.slug, isEnabled: true });
        }
        return;
      }
      if (command.type === "createDraft") {
        void createDrafts(command);
        return;
      }
      // undo / redo / goToVersion are DOCUMENT commands pinned to the turn's
      // origin draft (the generateImage routing rule): they ride the exact
      // store machinery the toolbar buttons and the history panel's restore
      // use — acting on the user's behalf per their request — against the
      // active store, or the turn document's retained instance after a
      // mid-turn draft switch.
      if (
        command.type === "undo" ||
        command.type === "redo" ||
        command.type === "goToVersion"
      ) {
        const store = getIsTurnDocumentActive()
          ? useEditorStore.getState()
          : getTurnDocumentStore()?.getState();
        if (store === undefined) {
          return;
        }
        if (command.type === "undo") {
          store.undo();
        } else if (command.type === "redo") {
          store.redo();
        } else {
          void store.restoreVersion(command.version).then((result) => {
            if (!result.isOk) {
              store.showNotice(result.message);
            }
          });
        }
        return;
      }
      // Mid-turn draft switch (owner decision, follow-on to the op pinning):
      // editor commands act on the ACTIVE canvas — the viewport is ONE store
      // field bound to the active draft (DraftFrameToolbar renders only on
      // the active frame); there is no per-draft view state to retarget. So
      // a view command from a turn pinned to a now-inactive draft is DROPPED
      // outright: never flip a different draft's viewport. (Marked executed
      // above on purpose — the command belonged to that moment of the turn,
      // not to whenever its draft is next activated.) openPanel follows the
      // same rule: a panel opened for a draft the user has left behind would
      // be noise, not help.
      if (!getIsTurnDocumentActive()) {
        return;
      }
      if (command.type === "showPreview") {
        useEditorStore.getState().setViewport(command.mode);
      }
      if (command.type === "openPanel") {
        requestUiSurfaceOpen(command.panel);
      }
      // sendTestEmail: the real send already happened server-side (Phase
      // 8.1) — nothing to run client-side; the chip renders the result.
    },

    sendAutomaticallyWhen: ({ messages }) => {
      // Approval responses must always round-trip so the server can execute
      // the approved sendTestEmail (or record the denial).
      if (lastAssistantMessageIsCompleteWithApprovalResponses({ messages })) {
        return true;
      }
      // The scripted mock re-emits the same tool call on every request —
      // auto-continuing on tool results would loop, so only real models do.
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

  /**
   * Commit a FULFILLED generateImage command (agent path): the server already
   * generated the image and uploaded it to Convex storage; the pure-doc
   * consequence is ONE updateBlockProperties op { src, alt } dispatched with
   * this turn's agent provenance through the normal validated spine — so it
   * shares the turn's batch (revertable) and undo restores the previous src.
   * Base64 never appears here: the command carries only the durable URL.
   */
  function applyGeneratedImageCommand(command: GenerateImageCommand): void {
    if (command.src === undefined) {
      // Unfulfilled command — the executor failed before upload; the tool
      // call errored server-side, so there is nothing to commit.
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
    // Mid-turn draft switch: land the op in the turn document's RETAINED
    // store instance (same path as content ops after a switch — the store's
    // own overlay submits and reconciles). No tool output to report: the
    // editor tool already returned its result server-side. A missing store
    // means the turn was never pinned — nothing to commit into.
    getTurnDocumentStore()?.getState().dispatch(operation, context);
  }

  /**
   * Resolve and apply one saved-section scaffold call (owner V2 item 3):
   * find the row in the reactive cache, plan the ONE restoreBlocks op with
   * fresh ids honoring the call's scaffold position (SDK-shared resolution),
   * and dispatch with this turn's agent provenance — the same store-routing
   * rules as every other content op (active document, else the turn's
   * retained instance). Missing rows report a retryable tool error so the
   * model can fall back to the catalog. Every successful insert bumps the
   * row's usage stats (fails soft).
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

  /**
   * Apply one content op to the turn's document AFTER a mid-turn draft
   * switch: dispatch into the turn document's RETAINED store instance (the
   * chat's registry hold keeps it alive) — the exact same validated dispatch
   * path as the active branch, overlay/submit/reconciliation included, and
   * with any human edits made before the switch already in the store's doc.
   * When the draft is reactivated, StudioShell re-feeds the same instance
   * with snapshots and the overlay rebases — the turn's ops are simply
   * there. The op is reported exactly like the active path (optimistic:
   * local apply result; the overlay drops-and-notices on a server reject).
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
      // Unreachable in practice (the pin + hold are taken at turn start);
      // reported rather than thrown so a bad state never kills the stream
      // handler.
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
    beginUserTurn: () => {
      const { documentId } = useEditorStore.getState();
      turnState.batchId = crypto.randomUUID();
      turnState.autoContinuationCount = 0;
      // Pin this turn to the document it starts in, and take a registry
      // hold so a mid-turn draft switch cannot dispose its store instance
      // (see turnState). The previous turn's hold is released here.
      turnState.documentId = documentId;
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
  };
}

/**
 * True while the LAST assistant message holds a tool approval the user has
 * not finished resolving: `approval-requested` (waiting on Approve/Deny) or
 * `approval-responded` (answered, but the auto-resubmit round has not yet
 * rewritten the part with its outcome). Both must hold the message queue —
 * a queued user message must never auto-send past a pending approval, and
 * the responded→resubmit window is a race the queue must not slip through.
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
  /** Send one user text message (starts a fresh agent batch). */
  sendUserMessage: (text: string) => void;
  /** Respond to a tool approval request (sendTestEmail). */
  respondToApproval: (input: { approvalId: string; isApproved: boolean }) => void;
  /** Reactive: an approval chip is on screen (or mid-resubmit) — see above. */
  hasPendingApproval: boolean;
  /**
   * LIVE idle check against the Chat instance (not render-stale props):
   * status is "ready" AND no approval is pending. The message queue re-checks
   * this at dispatch time so mid-turn "ready" flickers (the SDK sets status
   * "ready" before evaluating sendAutomaticallyWhen between continuation
   * rounds) and StrictMode double-effects can never double-send.
   */
  getIsAgentIdle: () => boolean;
  /**
   * Test-only lever (no UI since the dev "mock" checkbox was removed): force
   * the deterministic mock model via the x-flock-mock header. The server
   * still falls back to the mock automatically when no API key is set.
   */
  isMockEnabled: boolean;
  setIsMockEnabled: (isMockEnabled: boolean) => void;
}

export function useFlockChat(): FlockChat {
  // The controller is created once per mount.
  const [controller] = useState(() => createFlockChatController());
  const [isMockEnabled, setIsMockEnabledState] = useState(false);

  const chat = useChat<FlockChatMessage>({ chat: controller.chat });

  // Saved-sections runtime for the agent's `saved:<id>` scaffold calls:
  // reactive rows (a delete/save reflects immediately) + the fails-soft
  // usage recorder, pushed into the controller's closure on every change.
  const sessionId = useEditorStore((state) => state.authorId);
  const savedSections = useQuery(
    api.savedSections.listForSession,
    sessionId === null ? "skip" : { sessionId },
  );
  const recordSavedSectionUse = useMutation(api.savedSections.recordUse);
  useEffect(() => {
    controller.setSavedSectionsRuntime({
      rows: savedSections ?? [],
      recordUse: (savedSectionId) => {
        if (sessionId !== null) {
          void recordSavedSectionUse({ sessionId, savedSectionId }).catch(() => {});
        }
      },
    });
  }, [controller, savedSections, recordSavedSectionUse, sessionId]);

  // The createDraft command executor (agent parity): the DraftSelector's own
  // machinery, on the active canvas, WITHOUT activating the new drafts (the
  // user's current draft stays where they are; the drafts bar updates
  // reactively). The loop itself lives beside that machinery in
  // drafts/create-agent-drafts — a composed command builds whole emails there,
  // a bare count still creates starter drafts.
  const convexClient = useConvex();
  useEffect(() => {
    controller.setCreateDrafts(async (command) => {
      const { canvasId, doc } = useEditorStore.getState();
      if (canvasId === null) {
        return;
      }
      const { failureNotice } = await createAgentDrafts({
        convexClient,
        canvasId,
        sessionId: getOrCreateSessionId(),
        command,
        sourceDoc: doc,
        authorId: controller.chat.id,
      });
      if (failureNotice !== null) {
        useEditorStore.getState().showNotice(failureNotice);
      }
    });
  }, [controller, convexClient]);

  const sendUserMessage = (text: string): void => {
    const trimmedText = text.trim();
    if (trimmedText.length === 0) {
      return;
    }
    controller.beginUserTurn();
    chat.clearError();
    // A drafts-menu AI send (pending-generation-request.ts) carries a second,
    // machine-readable part: `{ kind, sourceDocumentId, direction }`. The server
    // expands it into the targeted brief; the transcript renders `text` parts
    // only, so nothing internal is ever shown. Read-and-clear — an ordinary
    // typed message is unchanged.
    const generationRequest = takeGenerationRequest();
    if (generationRequest === null) {
      void chat.sendMessage({ text: trimmedText });
      return;
    }
    void chat.sendMessage({
      parts: [
        { type: "text", text: trimmedText },
        { type: GENERATION_REQUEST_DATA_PART_TYPE, data: generationRequest },
      ],
    });
  };

  const respondToApproval = ({
    approvalId,
    isApproved,
  }: {
    approvalId: string;
    isApproved: boolean;
  }): void => {
    void chat.addToolApprovalResponse({ id: approvalId, approved: isApproved });
  };

  const setIsMockEnabled = (nextIsMockEnabled: boolean): void => {
    controller.setIsMockEnabled(nextIsMockEnabled);
    setIsMockEnabledState(nextIsMockEnabled);
  };

  const getIsAgentIdle = (): boolean =>
    controller.chat.status === "ready" && !getHasPendingApproval(controller.chat.messages);

  return {
    messages: chat.messages,
    status: chat.status,
    error: chat.error,
    sendUserMessage,
    respondToApproval,
    hasPendingApproval: getHasPendingApproval(chat.messages),
    getIsAgentIdle,
    isMockEnabled,
    setIsMockEnabled,
  };
}
