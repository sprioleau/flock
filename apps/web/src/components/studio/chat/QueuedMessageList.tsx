"use client";

import { useState } from "react";
import { CheckIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { MessageQueue, QueuedMessage } from "./use-message-queue";

/*
  The pending-message strip between the thread and the composer: one compact
  muted card per queued message with a queue-position badge and edit/delete
  controls (editing happens IN PLACE so the composer stays free for the next
  message and the item keeps its FIFO slot). A one-line status header says
  why the queue is waiting — normal turn, pending approval, or error pause
  (which adds explicit "Send next" / "Clear" actions instead of silently
  draining).
*/

interface QueuedMessageCardProps {
  message: QueuedMessage;
  position: number;
  onUpdate: (input: { id: string; text: string }) => void;
  onRemove: (id: string) => void;
}

function QueuedMessageCard({ message, position, onUpdate, onRemove }: QueuedMessageCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(message.text);

  const startEditing = (): void => {
    setEditText(message.text);
    setIsEditing(true);
  };

  const saveEdit = (): void => {
    const trimmedText = editText.trim();
    if (trimmedText.length === 0) {
      return;
    }
    onUpdate({ id: message.id, text: trimmedText });
    setIsEditing(false);
  };

  return (
    <div
      className="flex items-start gap-1.5 rounded-md border border-dashed bg-muted/40 px-2 py-1.5 text-xs"
      data-queued-message={message.id}
      data-queue-position={position}
    >
      <span
        className={cn(
          "mt-px flex size-4 shrink-0 items-center justify-center rounded-full",
          "bg-muted font-mono text-[10px] text-muted-foreground",
        )}
        aria-label={`Queue position ${position}`}
      >
        {position}
      </span>
      {isEditing ? (
        <>
          <Textarea
            value={editText}
            onChange={(event) => setEditText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                saveEdit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setIsEditing(false);
              }
            }}
            autoFocus
            className="min-h-6 flex-1 rounded-sm px-1.5 py-0.5 text-xs md:text-xs"
            aria-label="Edit queued message"
          />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Save queued message"
            disabled={editText.trim().length === 0}
            onClick={saveEdit}
          >
            <CheckIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Cancel editing queued message"
            onClick={() => setIsEditing(false)}
          >
            <XIcon />
          </Button>
        </>
      ) : (
        <>
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words pt-px text-muted-foreground">
            {message.text}
          </p>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Edit queued message"
            onClick={startEditing}
          >
            <PencilIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Delete queued message"
            onClick={() => onRemove(message.id)}
          >
            <Trash2Icon />
          </Button>
        </>
      )}
    </div>
  );
}

export interface QueuedMessageListProps {
  queue: MessageQueue;
  hasPendingApproval: boolean;
  isErrorPaused: boolean;
}

export function QueuedMessageList({
  queue,
  hasPendingApproval,
  isErrorPaused,
}: QueuedMessageListProps) {
  const { queuedMessages } = queue;
  if (queuedMessages.length === 0) {
    return null;
  }

  const statusText = isErrorPaused
    ? "queue paused — the last turn failed"
    : hasPendingApproval
      ? "waiting for your approval above"
      : "sends when the agent finishes";

  return (
    <div className="shrink-0 border-t px-3 py-2" data-testid="chat-queue">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Queued · {queuedMessages.length}
        </p>
        <p
          className={cn(
            "truncate text-[10px]",
            isErrorPaused ? "text-destructive" : "text-muted-foreground",
          )}
          data-queue-status
        >
          {statusText}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        {queuedMessages.map((message, index) => (
          <QueuedMessageCard
            key={message.id}
            message={message}
            position={index + 1}
            onUpdate={queue.updateQueuedMessage}
            onRemove={queue.removeQueuedMessage}
          />
        ))}
      </div>
      {isErrorPaused && (
        <div className="mt-1.5 flex gap-1.5">
          <Button size="xs" variant="outline" onClick={queue.sendNextQueuedMessage}>
            Send next
          </Button>
          <Button size="xs" variant="ghost" onClick={queue.clearQueue}>
            Clear queue
          </Button>
        </div>
      )}
    </div>
  );
}
