"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { CornerDownLeftIcon } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { sendPromptThroughComposer } from "../chat/composer-handoff";

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
      onClose();
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
        <input
          // A summoned prompt exists to be typed into — focus is the point.
          autoFocus
          type="text"
          value={promptText}
          onChange={(event) => setPromptText(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Tandem to change your email…"
          aria-label="Quick prompt"
          className="w-full bg-transparent px-4 py-3.5 text-base text-foreground outline-none placeholder:text-muted-foreground"
          data-testid="quick-prompt-input"
        />
        <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
          <span>Sends to the chat</span>
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
