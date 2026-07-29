"use client";

import { useEffect, useRef, useState } from "react";
import { isStaticToolUIPart } from "ai";
import { Loader2Icon, MessagesSquareIcon, TriangleAlertIcon, Undo2Icon } from "lucide-react";
import { parseChatErrorText, type TandemChatMessage } from "@/lib/chat-contract";
import { useEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";
import { EditorCommandChip } from "./EditorCommandChip";
import { ToolPartChip } from "./ToolPartChip";

/**
 * The scrollable transcript: user/assistant text bubbles, tool-call chips,
 * editor-command chips, and a distinct error bubble for terminal stream
 * failures. Auto-scrolls to the newest content.
 */

function ErrorBubble({ error }: { error: Error }) {
  const payload = parseChatErrorText(error.message);
  const messageText =
    payload !== undefined
      ? payload.errors.map(({ message }) => message).join(" ")
      : error.message;

  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive"
      data-chat-error
    >
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
      <p>{messageText}</p>
    </div>
  );
}

function getPartToolCallId(part: TandemChatMessage["parts"][number]): string | null {
  if (isStaticToolUIPart(part)) {
    return part.toolCallId;
  }
  if (part.type === "data-editor-command") {
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
function buildLatestToolPartKeys(messages: TandemChatMessage[]): Map<string, string> {
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
 * batchIds of successfully-applied agent ops in one assistant message,
 * counting only parts that are this toolCallId's LATEST occurrence (matching
 * the chip-rendering dedupe, so the affordance lands on the visible turn).
 */
function getAppliedBatchIds({
  message,
  latestToolPartKeys,
}: {
  message: TandemChatMessage;
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
  onApprovalResponse,
}: {
  message: TandemChatMessage;
  latestToolPartKeys: Map<string, string>;
  onApprovalResponse: (input: { approvalId: string; isApproved: boolean }) => void;
}) {
  const appliedBatchIds = getAppliedBatchIds({ message, latestToolPartKeys });
  return (
    <div className="flex flex-col gap-1.5">
      {message.parts.map((part, partIndex) => {
        const key = `${message.id}-${partIndex}`;
        const toolCallId = getPartToolCallId(part);
        if (toolCallId !== null && latestToolPartKeys.get(toolCallId) !== key) {
          return null;
        }
        if (part.type === "text") {
          if (part.text.length === 0) {
            return null;
          }
          return (
            <p key={key} className="whitespace-pre-wrap text-sm">
              {part.text}
            </p>
          );
        }
        // The registry only produces statically-typed tools; dynamic tool
        // parts do not occur on this route.
        if (isStaticToolUIPart(part)) {
          return <ToolPartChip key={key} part={part} onApprovalResponse={onApprovalResponse} />;
        }
        if (part.type === "data-editor-command") {
          return <EditorCommandChip key={key} data={part.data} />;
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
  messages: TandemChatMessage[];
  error: Error | undefined;
  isAwaitingResponse: boolean;
  onApprovalResponse: (input: { approvalId: string; isApproved: boolean }) => void;
}

export function ChatMessageList({
  messages,
  error,
  isAwaitingResponse,
  onApprovalResponse,
}: ChatMessageListProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Keep the newest content in view as text/chips stream in.
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer !== null) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }, [messages, error, isAwaitingResponse]);

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

  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
      <div className="flex flex-col gap-3 p-3">
        {messages.map((message) =>
          message.role === "user" ? (
            <div
              key={message.id}
              className={cn(
                "ml-8 self-end whitespace-pre-wrap rounded-lg bg-primary px-3 py-2",
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
              onApprovalResponse={onApprovalResponse}
            />
          ),
        )}
        {isAwaitingResponse && (
          <p className="text-xs text-muted-foreground" data-chat-pending>
            Thinking…
          </p>
        )}
        {error !== undefined && <ErrorBubble error={error} />}
      </div>
    </div>
  );
}
