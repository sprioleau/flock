"use client";

import { useEffect, useRef, useState } from "react";
import { isStaticToolUIPart } from "ai";
import { Loader2Icon, MessagesSquareIcon, TriangleAlertIcon, Undo2Icon } from "lucide-react";
import { parseChatErrorText, type FlockChatMessage } from "@/lib/chat-contract";
import { useEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";
import { EditorCommandChip } from "./EditorCommandChip";
import { ToolPartChip } from "./ToolPartChip";
import { TurnActivityIndicator } from "./TurnActivityIndicator";
import { toTurnParts } from "./turn-activity";
import { ChatTableWidget } from "./widgets/ChatTableWidget";
import { ClarificationWidget } from "./widgets/ClarificationWidget";
import { EditSuggestionsWidget } from "./widgets/EditSuggestionsWidget";
import { SectionVariationsWidget } from "./widgets/SectionVariationsWidget";

/**
 * The scrollable transcript: user/assistant text bubbles, tool-call chips,
 * editor-command chips, interactive widget parts (clarification questions,
 * section-variation pickers, apply-able suggestions, compact tables), and a
 * distinct error bubble for terminal stream failures. Auto-scrolls to the
 * newest content.
 */

/**
 * Payload error codes whose message is a RAW wrapped Error.message (see the
 * route's toChatErrorText): provider/API dumps, Zod traces — never curated
 * copy, so never user-facing.
 */
const RAW_WRAPPED_ERROR_CODES: ReadonlySet<string> = new Set([
  "stream_error",
  "op_validation_failed",
]);

/**
 * User-facing copy for a terminal turn failure. Structured payloads carry
 * curated messages EXCEPT for the raw-wrapped codes above; those — and
 * unstructured errors (raw provider/network failures) — are translated, so
 * internal details like API error dumps never render as the message. The raw
 * text stays available behind a collapsed "Details" disclosure.
 */
function getFriendlyErrorMessage(error: Error): { messageText: string; rawText?: string } {
  const payload = parseChatErrorText(error.message);
  const curatedMessages =
    payload?.errors
      .filter(({ code }) => !RAW_WRAPPED_ERROR_CODES.has(code))
      .map(({ message }) => message) ?? [];
  if (curatedMessages.length > 0) {
    return { messageText: curatedMessages.join(" ") };
  }
  const rawText = payload?.errors.map(({ message }) => message).join(" ") ?? error.message;
  const isRateLimited = /quota|rate.?limit|resource.?exhausted|429/i.test(rawText);
  return {
    messageText: isRateLimited
      ? "The AI service is temporarily over its usage limit. Wait a moment, then try again."
      : "Something went wrong while responding. Try sending your message again.",
    rawText,
  };
}

function ErrorBubble({ error }: { error: Error }) {
  const { messageText, rawText } = getFriendlyErrorMessage(error);

  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive"
      data-chat-error
    >
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="break-words">{messageText}</p>
        {rawText !== undefined && (
          <details className="mt-1 text-destructive/70">
            <summary className="cursor-pointer select-none">Details</summary>
            <p className="mt-1 break-words whitespace-pre-wrap">{rawText}</p>
          </details>
        )}
      </div>
    </div>
  );
}

function getPartToolCallId(part: FlockChatMessage["parts"][number]): string | null {
  if (isStaticToolUIPart(part)) {
    return part.toolCallId;
  }
  // Widget data parts carry their tool call's id so the LATEST part for a
  // toolCallId — the widget, written after the chip's part — wins rendering.
  if (
    part.type === "data-editor-command" ||
    part.type === "data-section-variations" ||
    part.type === "data-edit-suggestions" ||
    part.type === "data-table"
  ) {
    return part.data.toolCallId;
  }
  return null;
}

/**
 * Continuation rounds (tool results, approval responses) can re-stream a
 * prior turn's tool parts under a new assistant message. Application is
 * already deduped by toolCallId; this dedupes RENDERING — for each
 * toolCallId only the latest occurrence (freshest state) draws a chip.
 */
function buildLatestToolPartKeys(messages: FlockChatMessage[]): Map<string, string> {
  const latestKeyByToolCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    message.parts.forEach((part, partIndex) => {
      const toolCallId = getPartToolCallId(part);
      if (toolCallId !== null) {
        latestKeyByToolCallId.set(toolCallId, `${message.id}-${partIndex}`);
      }
    });
  }
  return latestKeyByToolCallId;
}

/**
 * Keys of failed tool parts (output-error) SUPERSEDED by a later successful
 * call to the same tool in the same assistant message. A repaired/retried
 * call gets a fresh toolCallId, so the toolCallId dedupe never reconciles the
 * stale failure — this does: continuation rounds merge into the SAME
 * assistant message (the route streams with originalMessages), so a
 * same-message, same-tool success after a failure means the agent recovered
 * and the intermediate error is noise. Suppression is scoped to one message
 * on purpose — a genuinely failed edit must not be hidden by an unrelated
 * success in a later turn.
 */
function getSupersededFailureKeys(message: FlockChatMessage): Set<string> {
  const supersededKeys = new Set<string>();
  message.parts.forEach((part, partIndex) => {
    if (!isStaticToolUIPart(part) || part.state !== "output-error") {
      return;
    }
    const hasLaterSuccessOfSameTool = message.parts.some(
      (laterPart, laterPartIndex) =>
        laterPartIndex > partIndex &&
        isStaticToolUIPart(laterPart) &&
        laterPart.type === part.type &&
        laterPart.state === "output-available",
    );
    if (hasLaterSuccessOfSameTool) {
      supersededKeys.add(`${message.id}-${partIndex}`);
    }
  });
  return supersededKeys;
}

/**
 * batchIds of successfully-applied agent ops in one assistant message,
 * counting only parts that are this toolCallId's LATEST occurrence (matching
 * the chip-rendering dedupe, so the affordance lands on the visible turn).
 */
function getAppliedBatchIds({
  message,
  latestToolPartKeys,
}: {
  message: FlockChatMessage;
  latestToolPartKeys: Map<string, string>;
}): string[] {
  const batchIds: string[] = [];
  message.parts.forEach((part, partIndex) => {
    if (!isStaticToolUIPart(part) || part.state !== "output-available") {
      return;
    }
    if (latestToolPartKeys.get(part.toolCallId) !== `${message.id}-${partIndex}`) {
      return;
    }
    const output = part.output as { status?: string; batchId?: string } | undefined;
    if (output?.status === "applied" && typeof output.batchId === "string") {
      if (!batchIds.includes(output.batchId)) {
        batchIds.push(output.batchId);
      }
    }
  });
  return batchIds;
}

type RevertPhase =
  | { name: "idle" }
  | { name: "reverting" }
  | { name: "reverted" }
  | { name: "failed"; message: string };

/**
 * The AI-batch revert affordance (Phase 4): one small action per assistant
 * turn that applied ops. Uses the turn's batchId → history.revertBatch, so
 * the whole batch is undone atomically in every open tab; failures (e.g.
 * conflicts with later edits) surface inline.
 */
function RevertBatchAction({ batchId }: { batchId: string }) {
  const revertAgentBatch = useEditorStore((state) => state.revertAgentBatch);
  const [phase, setPhase] = useState<RevertPhase>({ name: "idle" });

  const handleRevert = async (): Promise<void> => {
    setPhase({ name: "reverting" });
    const result = await revertAgentBatch(batchId);
    setPhase(result.isOk ? { name: "reverted" } : { name: "failed", message: result.message });
  };

  if (phase.name === "reverted") {
    return (
      <p className="text-xs text-muted-foreground" data-batch-reverted={batchId}>
        Changes reverted.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={phase.name === "reverting"}
        onClick={() => void handleRevert()}
        className={cn(
          "inline-flex w-fit items-center gap-1 rounded-md border px-2 py-1 text-xs",
          "text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50",
        )}
        data-batch-revert={batchId}
      >
        {phase.name === "reverting" ? (
          <Loader2Icon className="size-3 animate-spin" />
        ) : (
          <Undo2Icon className="size-3" />
        )}
        Revert these changes
      </button>
      {phase.name === "failed" && (
        <p className="text-xs text-destructive" data-batch-revert-error={batchId}>
          {phase.message}
        </p>
      )}
    </div>
  );
}

function AssistantMessageParts({
  message,
  latestToolPartKeys,
  isRetryPending,
  hasLaterUserMessage,
  onApprovalResponse,
}: {
  message: FlockChatMessage;
  latestToolPartKeys: Map<string, string>;
  /** True while this message's turn is still in flight (a retry may follow). */
  isRetryPending: boolean;
  /** True when any user message follows this one (locks stale clarifications). */
  hasLaterUserMessage: boolean;
  onApprovalResponse: (input: { approvalId: string; isApproved: boolean }) => void;
}) {
  const appliedBatchIds = getAppliedBatchIds({ message, latestToolPartKeys });
  const supersededFailureKeys = getSupersededFailureKeys(message);
  return (
    <div className="flex flex-col gap-1.5">
      {message.parts.map((part, partIndex) => {
        const key = `${message.id}-${partIndex}`;
        const toolCallId = getPartToolCallId(part);
        if (toolCallId !== null && latestToolPartKeys.get(toolCallId) !== key) {
          return null;
        }
        // Transient failures the agent already recovered from draw nothing.
        if (supersededFailureKeys.has(key)) {
          return null;
        }
        if (part.type === "text") {
          if (part.text.length === 0) {
            return null;
          }
          return (
            <p key={key} className="break-words whitespace-pre-wrap text-sm">
              {part.text}
            </p>
          );
        }
        // askForClarification has no server execute: the validated call IS
        // the widget (the turn ended on it; the user's click answers it).
        // While the input is still streaming, the generic chip spins below.
        if (part.type === "tool-askForClarification" && part.state === "input-available") {
          return (
            <ClarificationWidget
              key={key}
              question={part.input.question}
              options={[...part.input.options]}
              hasBeenAnswered={hasLaterUserMessage}
            />
          );
        }
        // The registry only produces statically-typed tools; dynamic tool
        // parts do not occur on this route.
        if (isStaticToolUIPart(part)) {
          return (
            <ToolPartChip
              key={key}
              part={part}
              isRetryPending={isRetryPending}
              onApprovalResponse={onApprovalResponse}
            />
          );
        }
        if (part.type === "data-editor-command") {
          return <EditorCommandChip key={key} data={part.data} />;
        }
        if (part.type === "data-section-variations") {
          return <SectionVariationsWidget key={key} data={part.data} />;
        }
        if (part.type === "data-edit-suggestions") {
          return <EditSuggestionsWidget key={key} data={part.data} />;
        }
        if (part.type === "data-table") {
          return <ChatTableWidget key={key} data={part.data} />;
        }
        return null;
      })}
      {appliedBatchIds.map((batchId) => (
        <RevertBatchAction key={batchId} batchId={batchId} />
      ))}
    </div>
  );
}

export interface ChatMessageListProps {
  messages: FlockChatMessage[];
  error: Error | undefined;
  isAwaitingResponse: boolean;
  /**
   * True while a turn is in flight (submitted or streaming). Failed tool
   * parts in the LAST assistant message read as "retrying" while this holds —
   * the error round-trips to the model in-loop — and settle to a final
   * friendly failure (or are suppressed by a successful retry) once it drops.
   */
  isTurnInProgress: boolean;
  onApprovalResponse: (input: { approvalId: string; isApproved: boolean }) => void;
}

export function ChatMessageList({
  messages,
  error,
  isAwaitingResponse,
  isTurnInProgress,
  onApprovalResponse,
}: ChatMessageListProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Keep the newest content in view as text/chips stream in.
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer !== null) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
    // isTurnInProgress is a dep because the activity indicator appears and
    // disappears with it — the newest content must stay in view either way.
  }, [messages, error, isAwaitingResponse, isTurnInProgress]);

  if (messages.length === 0 && error === undefined) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <MessagesSquareIcon className="size-8 text-muted-foreground/50" />
        <div>
          <p className="text-sm font-medium">Build your email together</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Describe a change and watch it land on the canvas.
          </p>
        </div>
      </div>
    );
  }

  const latestToolPartKeys = buildLatestToolPartKeys(messages);
  // The in-flight turn's parts, empty until the agent opens its message —
  // which is exactly the "nothing has come back yet" case the indicator
  // narrates. A trailing USER message means the turn hasn't started streaming.
  const lastMessage = messages.at(-1);
  const liveTurnParts =
    lastMessage?.role === "assistant" ? toTurnParts(lastMessage.parts) : [];
  // Identity of the turn in flight: the user message that opened it. Stable
  // for the whole turn, new on the next one — which is what gives the
  // indicator a fresh elapsed clock per turn without resetting state.
  const turnKey = messages.findLast((message) => message.role === "user")?.id ?? "turn";

  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
      <div className="flex flex-col gap-3 p-3">
        {messages.map((message, messageIndex) =>
          message.role === "user" ? (
            <div
              key={message.id}
              className={cn(
                "ml-8 self-end whitespace-pre-wrap wrap-anywhere rounded-lg bg-primary px-3 py-2",
                "text-sm text-primary-foreground",
              )}
            >
              {message.parts
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("")}
            </div>
          ) : (
            <AssistantMessageParts
              key={message.id}
              message={message}
              latestToolPartKeys={latestToolPartKeys}
              isRetryPending={isTurnInProgress && message.id === messages.at(-1)?.id}
              hasLaterUserMessage={messages.some(
                (laterMessage, laterIndex) =>
                  laterIndex > messageIndex && laterMessage.role === "user",
              )}
              onApprovalResponse={onApprovalResponse}
            />
          ),
        )}
        {/* The live "what's happening now" line. It reads the turn's OWN parts
            (the last message, when the agent already opened one) so it can
            stay quiet while a step chip or streaming prose is narrating, and
            speak up in the gaps between them. */}
        <TurnActivityIndicator
          key={turnKey}
          isTurnInProgress={isTurnInProgress}
          parts={liveTurnParts}
        />
        {error !== undefined && <ErrorBubble error={error} />}
      </div>
    </div>
  );
}
