"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CornerDownLeftIcon, CrosshairIcon, MicIcon } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { sendPromptThroughComposer } from "../chat/composer-handoff";
import { useSpeechInput } from "../chat/use-speech-input";
import {
  computeQuickPromptPlacement,
  QUICK_PROMPT_CARD_MAX_HEIGHT_PX,
  QUICK_PROMPT_CARD_WIDTH_PX,
  type QuickPromptAnchor,
} from "./use-quick-prompt-anchor";

/*
  The slash-summon quick prompt (the Resend-style UX): "/" anywhere outside a
  text field opens this floating input; submitting sends the text AS A NORMAL
  CHAT MESSAGE through the composer-handoff seam — the chat panel expands so
  the user watches their prompt land in the main thread (and it queues exactly
  like a composer submit when the agent is busy). No second chat pipeline:
  this component owns only an input and a dismissal.

  With an `anchor` (the pointer was over a block when "/" fired) the card
  opens AT THE CURSOR and names the block it is bound to; the block is already
  selected, so the turn carries it with no extra plumbing. Without one it
  opens centered and unbound, exactly as before.

  The card mounts fresh per open (state lives inside it), so the text always
  starts empty and `autoFocus` lands the caret without effects.
*/
export function QuickPromptOverlay({
  isOpen,
  anchor,
  onClose,
}: {
  isOpen: boolean;
  anchor: QuickPromptAnchor | null;
  onClose: () => void;
}) {
  if (!isOpen) {
    return null;
  }
  return createPortal(<QuickPromptCard anchor={anchor} onClose={onClose} />, document.body);
}

/*
  Growth cap: past this the prompt scrolls instead of growing. Placement has
  already reserved room for a card at its full height, so reaching the cap can
  never push the card off-screen.
*/
const MAX_TEXTAREA_HEIGHT_PX = 156;

function QuickPromptCard({
  anchor,
  onClose,
}: {
  anchor: QuickPromptAnchor | null;
  onClose: () => void;
}) {
  const [promptText, setPromptText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  /*
    Voice input (Web Speech API, feature-detected): dictation streams into the
    prompt text, appended and editable — submitting stays a deliberate Enter
    press, never automatic. The card unmounting (close/submit) aborts any
    in-flight recording via the hook's cleanup.
  */
  const { isSpeechSupported, isListening, speechErrorMessage, stopListening, toggleListening } =
    useSpeechInput({ onTranscriptChange: setPromptText });

  /*
    Grow with the text, measured rather than guessed: resetting to `auto`
    first is what makes `scrollHeight` report the CONTENT height instead of
    the box it is already in, so the card shrinks again on delete.
  */
  useLayoutEffect(() => {
    const textareaElement = textareaRef.current;
    if (textareaElement === null) {
      return;
    }
    textareaElement.style.height = "auto";
    textareaElement.style.height = `${Math.min(textareaElement.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [promptText]);

  /*
    Computed once per open from the anchor frozen at "/" — the card does not
    chase the pointer or re-place itself as the textarea grows. Null placement
    means "no block under the cursor", which renders the centered card.
  */
  const placement = computeQuickPromptPlacement({
    anchor,
    cardWidth: QUICK_PROMPT_CARD_WIDTH_PX,
    cardHeight: QUICK_PROMPT_CARD_MAX_HEIGHT_PX,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });

  const submitPrompt = (): void => {
    const trimmedText = promptText.trim();
    if (trimmedText.length === 0) {
      return;
    }
    sendPromptThroughComposer(trimmedText);
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      /*
        Enter sends; Shift+Enter is the newline, so the textarea keeps it.
      */
      event.preventDefault();
      submitPrompt();
    } else if (event.key === "Escape") {
      event.preventDefault();
      /*
        First Escape ends the recording (keeping the text); the next one
        dismisses the card, matching "Escape stops listening" everywhere.
      */
      if (isListening) {
        stopListening();
      } else {
        onClose();
      }
    }
  };

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex flex-col items-center",
        /*
          Only the centered card veils the app behind it. An anchored card
          must never dim the block it is bound to — the whole point is that
          the user can look at what "this" refers to while describing it.
        */
        placement === null && "bg-background/60 backdrop-blur-[2px]",
      )}
      onPointerDown={(event) => {
        /*
          Only a direct backdrop hit dismisses — card clicks stop below.
        */
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      data-testid="quick-prompt-overlay"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={
          anchor === null ? "Quick prompt" : `Quick prompt about ${anchor.breadcrumb}`
        }
        onPointerDown={(event) => event.stopPropagation()}
        className={cn(
          "rounded-xl border bg-popover shadow-2xl",
          "animate-in fade-in-0 zoom-in-95 duration-100",
          placement === null ? "mt-[28vh] w-[560px] max-w-[calc(100vw-2rem)]" : "fixed",
        )}
        style={
          placement === null
            ? undefined
            : {
                left: placement.left,
                top: placement.top,
                width: QUICK_PROMPT_CARD_WIDTH_PX,
                /*
                  Below ~466px the clamp has already pinned the card to the
                  left margin and the fixed width would run off the right
                  edge; shrinking is the only way left to stay on screen.
                */
                maxWidth: "calc(100vw - 1rem)",
              }
        }
        data-testid="quick-prompt-card"
      >
        {anchor !== null && (
          /*
            The resolved target, shown BEFORE the user types: an unseen binding
            that silently picked the wrong block would be worse than none.
          */
          <div className="flex items-center gap-1.5 border-b px-4 py-2 text-[11px] text-muted-foreground">
            <CrosshairIcon className="size-3.5 shrink-0" aria-hidden />
            <span className="shrink-0 font-medium" data-testid="quick-prompt-target-breadcrumb">
              {anchor.breadcrumb}
            </span>
            {anchor.textSnippet !== undefined && (
              <span className="truncate italic">“{anchor.textSnippet}”</span>
            )}
          </div>
        )}
        <div className="flex items-end">
          <textarea
            ref={textareaRef}
            /*
              A summoned prompt exists to be typed into — focus is the point.
            */
            autoFocus
            rows={1}
            value={promptText}
            onChange={(event) => setPromptText(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isListening
                ? "Listening…"
                : anchor?.blockType !== undefined
                  ? `Ask Flock to change this ${anchor.blockType.toLowerCase()}…`
                  : "Ask Flock to change your email…"
            }
            aria-label="Quick prompt"
            className="w-full min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-4 py-3.5 text-base text-foreground outline-none placeholder:text-muted-foreground"
            data-testid="quick-prompt-input"
          />
          {isSpeechSupported && (
            <button
              type="button"
              aria-label={isListening ? "Stop voice input" : "Start voice input"}
              aria-pressed={isListening}
              data-testid="quick-prompt-mic-button"
              onClick={() => toggleListening(promptText)}
              className={cn(
                "mr-2 mb-2 cursor-pointer rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground",
                isListening && "text-destructive hover:text-destructive",
              )}
            >
              <MicIcon className={cn("size-4", isListening && "animate-pulse")} />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
          {speechErrorMessage !== null ? (
            <span className="text-destructive" data-testid="quick-prompt-speech-error">
              {speechErrorMessage}
            </span>
          ) : isListening ? (
            <span
              className="inline-flex items-center gap-1 font-medium text-destructive"
              data-testid="quick-prompt-listening-indicator"
              role="status"
            >
              <span className="size-1.5 animate-pulse rounded-full bg-destructive" />
              Listening…
            </span>
          ) : (
            <span>Sends to the chat</span>
          )}
          <span className="flex items-center gap-2">
            <span className="flex items-center gap-1">
              <Kbd>
                <CornerDownLeftIcon className="size-3" aria-hidden />
              </Kbd>
              send
            </span>
            <span className="flex items-center gap-1">
              <Kbd>⇧</Kbd>
              <Kbd>
                <CornerDownLeftIcon className="size-3" aria-hidden />
              </Kbd>
              newline
            </span>
            <span className="flex items-center gap-1">
              <Kbd>esc</Kbd>
              dismiss
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
