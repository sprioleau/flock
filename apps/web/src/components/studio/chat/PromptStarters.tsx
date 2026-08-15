"use client";

import { selectPromptStarters } from "@/lib/prompt-starters";
import { cn } from "@/lib/utils";
import { useActiveBrandKit } from "../brand-kit/useActiveBrandKit";
import { handOffPromptToComposer } from "./composer-handoff";

/*
  The starter chips inside the empty chat thread.

  Deliberately thin: every decision about WHICH starters exist, what they say,
  and which are shown lives in lib/prompt-starters.ts, which is pure and
  node-testable (vitest pins `environment: "node"`, so there is no DOM here to
  test against). This file is the map over that result plus one hook.

  Each chip INSERTS its prompt — handOffPromptToComposer, the same INSERT-mode
  seam the persona finding card's "Ask in chat" uses. The composer expands,
  takes focus, and puts the caret at the end of the text; nothing is sent until
  the user sends it. That is not a nicety: the prompts carry specifics ("a
  product launch", the recipient address) that the user is expected to replace,
  and a chip that fired an unread prompt at the model would teach them they
  cannot trust any of the others either.

  Mounting is handled by the empty state itself — ChatMessageList renders this
  only while `messages.length === 0`, so the chips disappear the moment a
  conversation exists and there is no dismissal state to store anywhere.
*/
export function PromptStarters() {
  /*
    Reactive, and free: ThemeMenu already subscribes to this exact query for
    every studio session, so Convex dedupes it rather than opening a second
    one. It flips the brand chip out (and the test-send chip in) live, the
    moment a kit is saved or bound.
  */
  const { hasSavedKit } = useActiveBrandKit();
  const starters = selectPromptStarters({ hasSavedBrandKit: hasSavedKit });

  return (
    <div
      className="flex flex-wrap items-center justify-center gap-1.5"
      data-testid="chat-prompt-starters"
    >
      {starters.map((starter) => (
        <button
          key={starter.id}
          type="button"
          /*
            The full prompt as the tooltip: the chip's label is a summary, and
            the user deserves to see what is about to land in their composer
            before they commit a click to it.
          */
          title={starter.prompt}
          onClick={() => handOffPromptToComposer(starter.prompt)}
          className={cn(
            "inline-flex cursor-pointer items-center rounded-full border px-3 py-1.5 text-xs",
            "text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          )}
        >
          {starter.label}
        </button>
      ))}
    </div>
  );
}
