"use client";

import { useState } from "react";
import { CheckIcon, MessageCircleQuestionIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { sendPromptThroughComposer } from "../composer-handoff";

/**
 * The clarification widget (generative UI): one short question plus 2-4
 * clickable answers, rendered from the askForClarification tool call. The
 * tool has NO server execute — the turn ended on the call — so a click sends
 * the chosen answer as a NORMAL user message through the composer-handoff
 * send seam (queueing behind a busy agent exactly like a composer submit).
 *
 * Locking: after a click (instant local state) or once ANY later user
 * message exists in the transcript (`hasBeenAnswered` — the user may answer
 * by typing instead), the options stop being live controls. A question from
 * three turns ago must never silently steer the current conversation.
 */
export function ClarificationWidget({
  question,
  options,
  hasBeenAnswered,
}: {
  question: string;
  options: string[];
  hasBeenAnswered: boolean;
}) {
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const isLocked = hasBeenAnswered || selectedOption !== null;

  const handleSelect = (option: string): void => {
    if (isLocked) {
      return;
    }
    if (sendPromptThroughComposer(option)) {
      setSelectedOption(option);
    }
  };

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border bg-muted/30 px-3 py-2"
      data-widget="clarification"
    >
      <div className="flex items-start gap-2">
        <MessageCircleQuestionIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-sm">{question}</p>
      </div>
      <div className="flex flex-wrap gap-1.5 pl-5.5">
        {options.map((option) => {
          const isSelectedOption = selectedOption === option;
          return (
            <button
              key={option}
              type="button"
              disabled={isLocked && !isSelectedOption}
              onClick={() => handleSelect(option)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs",
                isSelectedOption
                  ? "border-primary text-primary"
                  : "text-muted-foreground",
                !isLocked && "cursor-pointer hover:bg-muted hover:text-foreground",
                isLocked && !isSelectedOption && "opacity-50",
              )}
              data-clarification-option={option}
            >
              {isSelectedOption && <CheckIcon className="size-3" />}
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}
