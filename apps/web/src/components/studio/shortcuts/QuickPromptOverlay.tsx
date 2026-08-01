"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { CornerDownLeftIcon, MicIcon } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { sendPromptThroughComposer } from "../chat/composer-handoff";
import { useSpeechInput } from "../chat/use-speech-input";

/**
 * The slash-summon quick prompt (the Resend-style UX): "/" anywhere outside a
 * text field opens this floating centered input; submitting sends the text AS
 * A NORMAL CHAT MESSAGE through the composer-handoff seam — the chat panel
 * expands so the user watches their prompt land in the main thread (and it
 * queues exactly like a composer submit when the agent is busy). No second
 * chat pipeline: this component owns only an input and a dismissal.
 *
 * The card mounts fresh per open (state lives inside it), so the text always
 * starts empty and `autoFocus` lands the caret without effects.
 */
export function QuickPromptOverlay({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  if (!isOpen) {
    return null;
  }
  return createPortal(<QuickPromptCard onClose={onClose} />, document.body);
}

function QuickPromptCard({ onClose }: { onClose: () => void }) {
  const [promptText, setPromptText] = useState("");

  // Voice input (Web Speech API, feature-detected): dictation streams into
  // the prompt text, appended and editable — submitting stays a deliberate
  // Enter press, never automatic. The card unmounting (close/submit) aborts
  // any in-flight recording via the hook's cleanup.
  const { isSpeechSupported, isListening, speechErrorMessage, stopListening, toggleListening } =
    useSpeechInput({ onTranscriptChange: setPromptText });

  const submitPrompt = (): void => {
    const trimmedText = promptText.trim();
    if (trimmedText.length === 0) {
      return;
    }
    sendPromptThroughComposer(trimmedText);
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitPrompt();
    } else if (event.key === "Escape") {
      event.preventDefault();
      // First Escape ends the recording (keeping the text); the next one
      // dismisses the card, matching "Escape stops listening" everywhere.
      if (isListening) {
        stopListening();
      } else {
        onClose();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center bg-background/60 backdrop-blur-[2px]"
      onPointerDown={(event) => {
        // Only a direct backdrop hit dismisses — card clicks stop below.
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      data-testid="quick-prompt-overlay"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Quick prompt"
        onPointerDown={(event) => event.stopPropagation()}
        className={cn(
          "mt-[28vh] w-[560px] max-w-[calc(100vw-2rem)] rounded-xl border bg-popover shadow-2xl",
          "animate-in fade-in-0 zoom-in-95 duration-100",
        )}
      >
        <div className="flex items-center">
          <input
            // A summoned prompt exists to be typed into — focus is the point.
            autoFocus
            type="text"
            value={promptText}
            onChange={(event) => setPromptText(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isListening ? "Listening…" : "Ask Flock to change your email…"}
            aria-label="Quick prompt"
            className="w-full min-w-0 flex-1 bg-transparent px-4 py-3.5 text-base text-foreground outline-none placeholder:text-muted-foreground"
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
                "mr-2 cursor-pointer rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground",
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
              <Kbd>esc</Kbd>
              dismiss
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
