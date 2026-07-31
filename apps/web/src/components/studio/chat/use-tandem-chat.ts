"use client";

import { useState } from "react";
import { Chat, useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  isStaticToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useConvex, type ConvexReactClient } from "convex/react";
import {
  dispatchContentAction,
  emailActionRegistry,
  type ActionContext,
  type ActionDispatchError,
  type ActionFailureKind,
  type BlockId,
  type EmailDocument,
} from "@tandem/email-sdk";
import type { Id } from "@convex/_generated/dataModel";
import {
  CHAT_API_PATH,
  editorCommandDataPartSchema,
  MOCK_MODEL_HEADER,
  validateAndClassifyOp,
  type TandemChatMessage,
  type TandemChatTools,
} from "@/lib/chat-contract";
import { submitOperationToConvex, useEditorStore, type DispatchableOp } from "@/lib/editor-store";

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
const MAX_AUTO_CONTINUATIONS_PER_TURN = 3;

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
interface TandemChatController {
  chat: Chat<TandemChatMessage>;
  /** Start a user-initiated turn: fresh agent batchId + continuation budget. */
  beginUserTurn: () => void;
  /** Dev-only x-tandem-mock switch, read by the transport at request time. */
  setIsMockEnabled: (isMockEnabled: boolean) => void;
}

function createTandemChatController(convexClient: ConvexReactClient): TandemChatController {
  // toolCallIds already applied / commands already executed (same-id stream
  // rewrites and repeated deliveries must not double-apply).
  const appliedToolCallIds = new Set<string>();
  const executedCommandToolCallIds = new Set<string>();

  // One batchId per user-initiated turn: every agent op the turn produces
  // (including auto-continuation rounds) shares it, so Phase 4 can revert the
  // whole AI turn in one step.
  //
  // documentId / docAfterLastOp / selectedBlockId pin the turn to the
  // document it STARTED in (the mid-turn draft-switch fix): the drafts bar
  // can retarget the store while a turn is still streaming, and without the
  // pin the turn's remaining ops would apply to whichever draft is active.
  // `docAfterLastOp` is the turn document's shadow — the doc at turn start,
  // advanced by every tool op this turn applied — used as the dispatch base
  // and the continuation request body once the turn document is inactive.
  // (Human edits landing between the last tool op and the switch are not in
  // the shadow; the server validates authoritatively on submit.)
  const turnState = {
    isMockEnabled: false,
    batchId: crypto.randomUUID(),
    autoContinuationCount: 0,
    documentId: null as Id<"documents"> | null,
    docAfterLastOp: null as EmailDocument | null,
    selectedBlockId: null as BlockId | null,
  };

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

  const transport = new DefaultChatTransport<TandemChatMessage>({
    api: CHAT_API_PATH,
    headers: (): Record<string, string> =>
      turnState.isMockEnabled ? { [MOCK_MODEL_HEADER]: "1" } : {},
    // Resolved per request → the CURRENT document + selection at send time —
    // unless a mid-turn draft switch disconnected the turn's document, in
    // which case continuation rounds (tool results, approval resubmits — the
    // approved sendTestEmail renders the REQUEST's document) keep describing
    // the document the turn started in via its shadow.
    body: () => {
      if (getIsTurnDocumentActive()) {
        const { doc, selectedBlockId } = useEditorStore.getState();
        return { document: doc, selectedBlockId: selectedBlockId ?? undefined };
      }
      return {
        document: turnState.docAfterLastOp ?? useEditorStore.getState().doc,
        selectedBlockId: turnState.selectedBlockId ?? undefined,
      };
    },
  });

  const chat = new Chat<TandemChatMessage>({
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

      // Mid-turn draft switch: the store now renders a DIFFERENT document, so
      // this op must bypass it and land in the turn's own document directly.
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
      // Advance the turn-document shadow (the full store doc, so concurrent
      // human edits up to this op ride along) — see turnState.
      turnState.docAfterLastOp = result.doc;
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
      // Mid-turn draft switch (owner decision, follow-on to the op pinning):
      // editor commands act on the ACTIVE canvas — the viewport is ONE store
      // field bound to the active draft (DraftFrameToolbar renders only on
      // the active frame); there is no per-draft view state to retarget. So
      // a view command from a turn pinned to a now-inactive draft is DROPPED
      // outright: never flip a different draft's viewport. (Marked executed
      // above on purpose — the command belonged to that moment of the turn,
      // not to whenever its draft is next activated.)
      if (!getIsTurnDocumentActive()) {
        return;
      }
      if (command.type === "showPreview") {
        useEditorStore.getState().setViewport(command.mode);
      }
      // sendTestEmail: the actual send is a Phase 8 stub — nothing to run
      // client-side; the tool output renders as a "queued" chip.
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
   * Apply one content op to the turn's document AFTER a mid-turn draft
   * switch: dry-run against the turn-document shadow (same SDK action layer
   * the store uses — validation, failureKind classification, and intent
   * resolution included), advance the shadow, then submit the settled op
   * straight to Convex via the SAME mutation routing as the store's outbound
   * overlay (submitOperationToConvex). The turn document's live query
   * subscriptions — its drafts-bar frame preview, and the store itself when
   * the draft is re-activated — pick the change up from the server snapshot.
   *
   * Unlike the active path (optimistic: output reported before the ack), the
   * tool output here waits for the server verdict — there is no local
   * overlay to roll back, so the server is the only truth worth reporting.
   */
  function applyOpToInactiveTurnDocument({
    toolName,
    toolCallId,
    operation,
  }: {
    toolName: keyof TandemChatTools;
    toolCallId: string;
    operation: DispatchableOp;
  }): void {
    const turnDocumentId = turnState.documentId;
    const shadowDoc = turnState.docAfterLastOp;
    const context: ActionContext = {
      caller: "tool",
      author: "agent",
      authorId: chat.id,
      batchId: turnState.batchId,
      threadId: chat.id,
    };
    if (turnDocumentId === null || shadowDoc === null) {
      // Unreachable in practice (both are captured at turn start); reported
      // rather than thrown so a bad state never kills the stream handler.
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

    const localResult = dispatchContentAction({
      registry: emailActionRegistry,
      doc: shadowDoc,
      name: operation.name,
      input: operation,
      context,
    });
    if (!localResult.isOk) {
      void chat.addToolOutput({
        state: "output-error",
        tool: toolName,
        toolCallId,
        errorText: serializeApplyFailure(localResult),
      });
      return;
    }
    turnState.docAfterLastOp = localResult.doc;

    submitOperationToConvex({
      convexClient,
      documentId: turnDocumentId,
      op: localResult.logEntry.op,
      styleTextSpanIntent: operation.name === "styleTextSpan" ? operation : null,
      context,
    })
      .then((serverResult) => {
        if (!serverResult.isOk) {
          void chat.addToolOutput({
            state: "output-error",
            tool: toolName,
            toolCallId,
            errorText: JSON.stringify({
              status: "failed",
              errors: serverResult.errors.map(({ code, message }) => ({ code, message })),
            }),
          });
          return;
        }
        void chat.addToolOutput({
          tool: toolName,
          toolCallId,
          output: { status: "applied", batchId: turnState.batchId } as never,
        });
      })
      .catch(() => {
        void chat.addToolOutput({
          state: "output-error",
          tool: toolName,
          toolCallId,
          errorText: JSON.stringify({
            status: "failed",
            errors: [
              {
                code: "network_error",
                message: "The edit could not be saved (connection error).",
              },
            ],
          }),
        });
      });
  }

  return {
    chat,
    beginUserTurn: () => {
      const { documentId, doc, selectedBlockId } = useEditorStore.getState();
      turnState.batchId = crypto.randomUUID();
      turnState.autoContinuationCount = 0;
      // Pin this turn to the document it starts in (see turnState).
      turnState.documentId = documentId;
      turnState.docAfterLastOp = doc;
      turnState.selectedBlockId = selectedBlockId;
    },
    setIsMockEnabled: (isMockEnabled) => {
      turnState.isMockEnabled = isMockEnabled;
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
function getHasPendingApproval(messages: TandemChatMessage[]): boolean {
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

export interface TandemChat {
  messages: TandemChatMessage[];
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
   * the deterministic mock model via the x-tandem-mock header. The server
   * still falls back to the mock automatically when no API key is set.
   */
  isMockEnabled: boolean;
  setIsMockEnabled: (isMockEnabled: boolean) => void;
}

export function useTandemChat(): TandemChat {
  const convexClient = useConvex();
  // The client is provider-stable; the controller is created once per mount.
  const [controller] = useState(() => createTandemChatController(convexClient));
  const [isMockEnabled, setIsMockEnabledState] = useState(false);

  const chat = useChat<TandemChatMessage>({ chat: controller.chat });

  const sendUserMessage = (text: string): void => {
    const trimmedText = text.trim();
    if (trimmedText.length === 0) {
      return;
    }
    controller.beginUserTurn();
    chat.clearError();
    void chat.sendMessage({ text: trimmedText });
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
