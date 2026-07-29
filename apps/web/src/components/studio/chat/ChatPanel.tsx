"use client";

import { useState } from "react";
import { MessagesSquareIcon, PanelLeftCloseIcon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ChatMessageList } from "./ChatMessageList";
import { useTandemChat } from "./use-tandem-chat";

const EXPANDED_WIDTH_PX = 360;
const COLLAPSED_WIDTH_PX = 48;

/**
 * The Phase 3 chat panel: a real AI chat whose streamed operations apply live
 * to the studio canvas. Collapsible with an animated width transition
 * (expanded by default now that the chat is real); the rail and the panel
 * body cross-fade so neither state pops in.
 */
export function ChatPanel() {
  const [isExpanded, setIsExpanded] = useState(true);
  const [draftText, setDraftText] = useState("");
  const {
    messages,
    status,
    error,
    sendUserMessage,
    respondToApproval,
    isMockEnabled,
    setIsMockEnabled,
  } = useTandemChat();

  const isBusy = status === "submitted" || status === "streaming";
  const isDevelopment = process.env.NODE_ENV === "development";

  const submitDraft = (): void => {
    if (isBusy || draftText.trim().length === 0) {
      return;
    }
    sendUserMessage(draftText);
    setDraftText("");
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

        <div className="flex shrink-0 items-end gap-2 border-t p-3">
          <Textarea
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitDraft();
              }
            }}
            disabled={isBusy}
            placeholder="Describe your email…"
            className="min-h-9 resize-none"
            aria-label="Chat message"
            tabIndex={isExpanded ? 0 : -1}
          />
          <Button
            disabled={isBusy || draftText.trim().length === 0}
            size="icon-sm"
            aria-label="Send message"
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
