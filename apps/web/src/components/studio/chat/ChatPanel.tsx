"use client";

import { useState } from "react";
import { MessagesSquareIcon, PanelLeftCloseIcon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ChatMessageList } from "./ChatMessageList";
import { QueuedMessageList } from "./QueuedMessageList";
import { useMessageQueue } from "./use-message-queue";
import { usePromptHistory } from "./use-prompt-history";
import { useTandemChat } from "./use-tandem-chat";

const EXPANDED_WIDTH_PX = 360;
const COLLAPSED_WIDTH_PX = 48;

/**
 * The Phase 3 chat panel: a real AI chat whose streamed operations apply live
 * to the studio canvas. Collapsible with an animated width transition
 * (expanded by default now that the chat is real); the rail and the panel
 * body cross-fade so neither state pops in.
 *
 * Chat-UX layer (this file wires, the hooks decide):
 * - Submitting while the agent is busy QUEUES the message (FIFO, editable
 *   until sent — see use-message-queue.ts); the composer is never disabled.
 * - ArrowUp/ArrowDown recall prompt history (see use-prompt-history.ts).
 * - "Busy" includes a pending sendTestEmail approval — queued messages hold
 *   until the user approves/denies, and hold again if a turn errors.
 */
export function ChatPanel() {
  const [isExpanded, setIsExpanded] = useState(true);
  const [draftText, setDraftText] = useState("");
  const {
    messages,
    status,
    error,
    sendUserMessage: sendChatMessage,
    respondToApproval,
    hasPendingApproval,
    getIsAgentIdle,
    isMockEnabled,
    setIsMockEnabled,
  } = useTandemChat();
  const promptHistory = usePromptHistory();

  // Every send funnels through here — direct sends AND queue auto-dispatches
  // record prompt history with the FINAL text (queued edits included).
  const sendUserMessage = (text: string): void => {
    promptHistory.recordPrompt(text);
    promptHistory.resetNavigation();
    sendChatMessage(text);
  };

  const isAgentBusy = status === "submitted" || status === "streaming" || hasPendingApproval;
  const isErrorPaused = status === "error";
  const queue = useMessageQueue({
    isAgentIdle: status === "ready" && !hasPendingApproval,
    isErrorPaused,
    getIsAgentIdle,
    sendUserMessage,
  });
  const hasQueuedMessages = queue.queuedMessages.length > 0;

  const isDevelopment = process.env.NODE_ENV === "development";

  const submitDraft = (): void => {
    const trimmedText = draftText.trim();
    if (trimmedText.length === 0) {
      return;
    }
    // Queue behind existing items even when momentarily idle (FIFO fairness);
    // an error pause with an EMPTY queue sends directly (send clears the
    // error), matching how native chats let you just try again.
    if (isAgentBusy || hasQueuedMessages) {
      queue.enqueueMessage(trimmedText);
    } else {
      sendUserMessage(trimmedText);
    }
    setDraftText("");
  };

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitDraft();
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }
    const textarea = event.currentTarget;
    const recalledText = promptHistory.navigate({
      direction: event.key === "ArrowUp" ? "older" : "newer",
      draftText,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    });
    if (recalledText === null) {
      return; // fall through: normal caret movement inside the draft
    }
    event.preventDefault();
    setDraftText(recalledText);
    // Caret to the end of the recalled text after React commits the value.
    requestAnimationFrame(() => {
      textarea.setSelectionRange(recalledText.length, recalledText.length);
    });
  };

  return (
    <aside
      className="relative shrink-0 overflow-hidden border-r bg-background transition-[width] duration-300 ease-in-out"
      style={{ width: isExpanded ? EXPANDED_WIDTH_PX : COLLAPSED_WIDTH_PX }}
    >
      {/* Collapsed rail */}
      <div
        className={cn(
          "absolute inset-y-0 left-0 flex w-12 flex-col items-center py-3 transition-opacity duration-200",
          isExpanded ? "pointer-events-none opacity-0" : "opacity-100 delay-100",
        )}
        aria-hidden={isExpanded}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Expand chat panel"
          title="Chat"
          tabIndex={isExpanded ? -1 : 0}
          onClick={() => setIsExpanded(true)}
        >
          <MessagesSquareIcon />
        </Button>
      </div>

      {/* Expanded panel body (fixed inner width so text never reflows mid-animation) */}
      <div
        className={cn(
          "flex h-full flex-col transition-opacity duration-200",
          isExpanded ? "opacity-100 delay-100" : "pointer-events-none opacity-0",
        )}
        style={{ width: EXPANDED_WIDTH_PX }}
        aria-hidden={!isExpanded}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
          <h1 className="font-heading text-sm font-semibold">Tandem</h1>
          <div className="flex items-center gap-2">
            {isDevelopment && (
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={isMockEnabled}
                  onChange={(event) => setIsMockEnabled(event.target.checked)}
                  data-testid="chat-mock-toggle"
                />
                mock
              </label>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Collapse chat panel"
              tabIndex={isExpanded ? 0 : -1}
              onClick={() => setIsExpanded(false)}
            >
              <PanelLeftCloseIcon />
            </Button>
          </div>
        </div>

        <ChatMessageList
          messages={messages}
          error={error}
          isAwaitingResponse={status === "submitted"}
          onApprovalResponse={respondToApproval}
        />

        <QueuedMessageList
          queue={queue}
          hasPendingApproval={hasPendingApproval}
          isErrorPaused={isErrorPaused}
        />

        {/* Composer: textarea and send button share a 36px (size-9) height
            when single-line — py-1.75 + one text-sm line + 1px borders is
            exactly the min-h-9 floor — and stay bottom-aligned (items-end)
            as the textarea grows. */}
        <div className="flex shrink-0 items-end gap-2 border-t p-3">
          <Textarea
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder={
              isAgentBusy || hasQueuedMessages ? "Queue a message…" : "Describe your email…"
            }
            className="min-h-9 resize-none py-1.75"
            aria-label="Chat message"
            tabIndex={isExpanded ? 0 : -1}
          />
          <Button
            disabled={draftText.trim().length === 0}
            size="icon-lg"
            aria-label={isAgentBusy || hasQueuedMessages ? "Queue message" : "Send message"}
            tabIndex={isExpanded ? 0 : -1}
            onClick={submitDraft}
          >
            <SendIcon />
          </Button>
        </div>
      </div>
    </aside>
  );
}
