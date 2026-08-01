"use client";

import { useState } from "react";
import { CheckIcon, SendIcon, SparklesIcon, UnlinkIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { CommentThread } from "./comment-context";

/**
 * One comment thread, rendered identically in the canvas pin popover and the
 * review panel: placement context header (with the orphaned badge when the
 * anchor block is gone), the entries, a respond composer, and — for OPEN
 * threads — the per-comment review actions: Fix with AI (dispatch the agent),
 * Resolve (accept), Dismiss. Closed threads show their status and stay
 * respondable (a reply is conversation, not a reopen).
 */
export function CommentThreadView({
  comment,
  isOrphaned,
  isDispatchEnabled,
  dispatchDisabledReason,
  onFix,
  onResolve,
  onDismiss,
  onRespond,
}: {
  comment: CommentThread;
  /** True when the anchor block no longer exists in the active draft's doc. */
  isOrphaned: boolean;
  /** False disables "Fix with AI" (e.g. the comment's draft isn't active). */
  isDispatchEnabled: boolean;
  dispatchDisabledReason?: string;
  onFix: () => void;
  onResolve: () => void;
  onDismiss: () => void;
  onRespond: (text: string) => void;
}) {
  const [replyText, setReplyText] = useState("");
  const isOpen = comment.status === "open";

  const submitReply = (): void => {
    const text = replyText.trim();
    if (text.length === 0) {
      return;
    }
    onRespond(text);
    setReplyText("");
  };

  return (
    <div className="flex w-full flex-col gap-2" data-testid={`comment-thread-${comment.commentId}`}>
      {/* Placement context: what the comment was anchored to, frozen at creation. */}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">
          {comment.context.blockType !== undefined
            ? comment.context.blockType
            : "Email overall"}
        </span>
        {comment.context.textSnippet !== undefined && (
          <span className="truncate">“{comment.context.textSnippet}”</span>
        )}
        {comment.context.breadcrumb.length > 0 && (
          <span className="font-mono text-[10px] uppercase tracking-wide">
            {comment.context.breadcrumb}
          </span>
        )}
        {isOrphaned && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
            data-testid="comment-orphaned-badge"
          >
            <UnlinkIcon className="size-3" aria-hidden />
            Original block removed
          </span>
        )}
        {!isOpen && (
          <span
            className="ml-auto rounded-full border px-1.5 py-0.5 text-[10px] font-medium capitalize"
            data-testid="comment-status-badge"
          >
            {comment.status}
          </span>
        )}
      </div>

      {/* The conversation. */}
      <div className="flex max-h-56 flex-col gap-2 overflow-y-auto">
        {comment.thread.map((entry, index) => (
          <div key={`${entry.createdAtMs}-${index}`} className="flex flex-col gap-0.5">
            <div className="flex items-baseline gap-1.5 text-[11px]">
              <span
                className={cn(
                  "font-medium",
                  entry.authorKind === "agent" ? "text-violet-500" : "text-foreground",
                )}
              >
                {entry.authorKind === "agent" && (
                  <SparklesIcon className="mr-0.5 inline size-3 align-[-1px]" aria-hidden />
                )}
                {entry.authorName}
              </span>
              <span className="text-muted-foreground">{formatEntryTime(entry.createdAtMs)}</span>
            </div>
            <p className="text-sm whitespace-pre-wrap">{entry.text}</p>
          </div>
        ))}
      </div>

      {/* Respond (thread reply — never a status change). */}
      <div className="flex items-center gap-1.5">
        <Input
          value={replyText}
          onChange={(event) => setReplyText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitReply();
            }
          }}
          placeholder="Reply…"
          className="h-8 text-sm"
          aria-label="Reply to comment"
          data-testid="comment-reply-input"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Send reply"
          disabled={replyText.trim().length === 0}
          onClick={submitReply}
        >
          <SendIcon />
        </Button>
      </div>

      {isOpen && (
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={!isDispatchEnabled}
            title={!isDispatchEnabled ? dispatchDisabledReason : undefined}
            onClick={onFix}
            data-testid="comment-fix-button"
          >
            <SparklesIcon className="size-3.5" />
            Fix with AI
          </Button>
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="gap-1 text-muted-foreground"
              onClick={onResolve}
              data-testid="comment-resolve-button"
            >
              <CheckIcon className="size-3.5" />
              Resolve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="gap-1 text-muted-foreground"
              onClick={onDismiss}
              data-testid="comment-dismiss-button"
            >
              <XIcon className="size-3.5" />
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Compact absolute time — unambiguous across days without a relative-time engine. */
function formatEntryTime(createdAtMs: number): string {
  return new Date(createdAtMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
