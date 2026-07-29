"use client";

import { useState } from "react";
import { Chat, useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  isStaticToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import {
  emailActionRegistry,
  type ActionDispatchError,
  type ActionFailureKind,
} from "@tandem/email-sdk";
import {
  CHAT_API_PATH,
  editorCommandDataPartSchema,
  MOCK_MODEL_HEADER,
  validateAndClassifyOp,
  type TandemChatMessage,
} from "@/lib/chat-contract";
import { useEditorStore } from "@/lib/editor-store";

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

function createTandemChatController(): TandemChatController {
  // toolCallIds already applied / commands already executed (same-id stream
  // rewrites and repeated deliveries must not double-apply).
  const appliedToolCallIds = new Set<string>();
  const executedCommandToolCallIds = new Set<string>();

  // One batchId per user-initiated turn: every agent op the turn produces
  // (including auto-continuation rounds) shares it, so Phase 4 can revert the
  // whole AI turn in one step.
  const turnState = {
    isMockEnabled: false,
    batchId: crypto.randomUUID(),
    autoContinuationCount: 0,
  };

  const transport = new DefaultChatTransport<TandemChatMessage>({
    api: CHAT_API_PATH,
    headers: (): Record<string, string> =>
      turnState.isMockEnabled ? { [MOCK_MODEL_HEADER]: "1" } : {},
    // Resolved per request → the CURRENT document + selection at send time.
    body: () => {
      const { doc, selectedBlockId } = useEditorStore.getState();
      return { document: doc, selectedBlockId: selectedBlockId ?? undefined };
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

  return {
    chat,
    beginUserTurn: () => {
      turnState.batchId = crypto.randomUUID();
      turnState.autoContinuationCount = 0;
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
  const [controller] = useState(createTandemChatController);
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
