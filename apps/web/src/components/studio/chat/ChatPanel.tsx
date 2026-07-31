"use client";

import { useState } from "react";
import {
  MessagesSquareIcon,
  MousePointerClickIcon,
  PanelLeftCloseIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useEditorStore } from "@/lib/editor-store";
import { usePersonaAdvisors } from "@/lib/personas/use-persona-advisors";
import { useSuggestions } from "@/lib/suggestions/use-suggestions";
import { cn } from "@/lib/utils";
import { DemoQueueButton } from "../demo/DemoQueueButton";
import { SettingsFab } from "../demo/SettingsFab";
import { ActiveDraftIndicator } from "../drafts/ActiveDraftIndicator";
import { ChatMessageList } from "./ChatMessageList";
import { QueuedMessageList } from "./QueuedMessageList";
import { SuggestionCard } from "./SuggestionCard";
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
  // Suggestion controllers live HERE (not in SuggestionCard): the collapsed
  // rail's notification badge needs the pending count, and each hook must
  // mount exactly once (usePersonaAdvisors hosts the persona presence
  // heartbeat + the batched runner). ChatPanel always mounts, collapsed or
  // not, so hosting here preserves the always-on behavior.
  const suggestions = useSuggestions();
  const personaAdvisors = usePersonaAdvisors();
  const pendingRecommendationCount =
    personaAdvisors.cards.filter((card) => card.appliedState === null).length +
    (suggestions.visibleSuggestion !== null ? 1 : 0);
  const {
    messages,
    status,
    error,
    sendUserMessage: sendChatMessage,
    respondToApproval,
    hasPendingApproval,
    getIsAgentIdle,
  } = useTandemChat();
  const promptHistory = usePromptHistory();

  // The composer's selection-context chip: the selected block's TYPE (ids are
  // never user-facing). The selection itself already rides along as request
  // context — the transport reads selectedBlockId from the store at send time
  // and the system prompt targets it for "this"/"the selected block" edits;
  // the chip makes that context visible and dismissable.
  const selectedBlockType = useEditorStore((state) =>
    state.selectedBlockId !== null ? state.doc[state.selectedBlockId]?.type : undefined,
  );
  const selectBlock = useEditorStore((state) => state.selectBlock);

  // Every send funnels through here — direct sends AND queue auto-dispatches
  // record prompt history with the FINAL text (queued edits included).
  const sendUserMessage = (text: string): void => {
    promptHistory.recordPrompt(text);
    promptHistory.resetNavigation();
    sendChatMessage(text);
  };

  const isAgentBusy = status === "submitted" || status === "streaming" || hasPendingApproval;
  const isErrorPaused = status === "error";
  // Queues are scoped per document: the panel survives drafts-bar switches,
  // so an unscoped queue would fire into whichever draft is active when the
  // agent goes idle (see use-message-queue.ts).
  const documentId = useEditorStore((state) => state.documentId);
  const queue = useMessageQueue({
    documentId,
    getActiveDocumentId: () => useEditorStore.getState().documentId,
    isAgentIdle: status === "ready" && !hasPendingApproval,
    isErrorPaused,
    getIsAgentIdle,
    sendUserMessage,
  });
  const hasQueuedMessages = queue.queuedMessages.length > 0;

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
          aria-label={
            pendingRecommendationCount > 0
              ? `Expand chat panel (${pendingRecommendationCount} suggestions pending)`
              : "Expand chat panel"
          }
          title="Chat"
          tabIndex={isExpanded ? -1 : 0}
          onClick={() => setIsExpanded(true)}
          className="relative"
        >
          <MessagesSquareIcon />
          {/* Pending-recommendation badge: suggestion cards live inside the
              panel, so while collapsed this is their only signal. Reactive by
              construction (the count derives from the live controllers);
              renders nothing at zero. */}
          {pendingRecommendationCount > 0 && (
            <span
              className={cn(
                "absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center",
                "rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground",
              )}
              data-testid="chat-rail-recommendation-badge"
              aria-hidden
            >
              {pendingRecommendationCount > 9 ? "9+" : pendingRecommendationCount}
            </span>
          )}
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

        <ChatMessageList
          messages={messages}
          error={error}
          isAwaitingResponse={status === "submitted"}
          isTurnInProgress={status === "submitted" || status === "streaming"}
          onApprovalResponse={respondToApproval}
        />

        <QueuedMessageList
          queue={queue}
          hasPendingApproval={hasPendingApproval}
          isErrorPaused={isErrorPaused}
        />

        {/* Demo mode (settings FAB toggle): one click sends the first of six
            doc-derived prompts and queues the rest — real chat turns, drained
            one per completed turn by the queue. Renders null when demo mode
            is off. */}
        <DemoQueueButton
          isAgentBusy={isAgentBusy}
          hasQueuedMessages={hasQueuedMessages}
          sendUserMessage={sendUserMessage}
          enqueueMessage={queue.enqueueMessage}
          isPanelExpanded={isExpanded}
        />

        {/* Phase 7.3 proactive suggestions: quiet, dismissible cards above
            the composer (controllers owned above — see the hooks note);
            renders null when nothing is suggested. */}
        <SuggestionCard
          isPanelExpanded={isExpanded}
          suggestions={suggestions}
          personaAdvisors={personaAdvisors}
        />

        {/* §10.2 frames UX: which draft the agent will edit — activation IS
            retargeting (ops go to the store-connected document); this makes
            it visible right above the composer. */}
        <ActiveDraftIndicator />

        {/* Composer: a single bordered box holding the selection-context chip
            (when a block is selected) above a borderless textarea; the send
            button sits beside it, bottom-aligned. Without a chip the box is
            exactly 36px (size-9) single-line — py-1.75 + one text-sm line +
            1px borders — matching the size-9 send button. */}
        <div className="flex shrink-0 items-end gap-2 border-t p-3">
          <div
            className={cn(
              "flex min-w-0 flex-1 flex-col rounded-lg border border-input transition-colors",
              "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
            )}
          >
            {selectedBlockType !== undefined && (
              <div className="flex px-1.5 pt-1.5">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5",
                    "text-[10px] font-medium text-muted-foreground",
                  )}
                  data-testid="composer-selection-chip"
                >
                  <MousePointerClickIcon className="size-3" />
                  <span className="capitalize">{selectedBlockType}</span>
                  <button
                    type="button"
                    aria-label="Clear selected block context"
                    tabIndex={isExpanded ? 0 : -1}
                    onClick={() => selectBlock(null)}
                    className="cursor-pointer rounded-sm hover:text-foreground"
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              </div>
            )}
            <Textarea
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={
                isAgentBusy || hasQueuedMessages
                  ? "Queue a message…"
                  : selectedBlockType !== undefined
                    ? `Describe a change to this ${selectedBlockType}…`
                    : "Describe your email…"
              }
              className={cn(
                "min-h-9 resize-none border-0 bg-transparent py-1.75",
                "focus-visible:ring-0 dark:bg-transparent",
              )}
              aria-label="Chat message"
              tabIndex={isExpanded ? 0 : -1}
            />
          </div>
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

      {/* App-wide settings FAB (fixed to the viewport, so its position is
          independent of this panel's width animation). */}
      <SettingsFab />
    </aside>
  );
}
