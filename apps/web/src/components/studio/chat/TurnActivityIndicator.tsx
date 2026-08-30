"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { describeTurnActivity, type TurnPart } from "./turn-activity";

/*
  The live "what's happening right now" line for an in-flight turn — the small
  widget that fills the gaps no other surface covers:

  - between hitting send and the first token ("Thinking it through…"),
  - between one step landing and the next one starting ("Working out the next
    step…"), which is where a turn used to go completely silent for seconds.

  It deliberately says NOTHING while a step chip is spinning or prose is
  streaming — those already narrate themselves, and a second status line under
  them reads as noise (see describeTurnActivity). Copy and phase logic live in
  turn-activity.ts; this file is animation and layout only.
*/

/*
  How often the elapsed clock ticks — fine enough for a seconds threshold.
*/
const ELAPSED_TICK_MS = 1_000;

/*
  Milliseconds since this turn began. There is deliberately no reset path:
  the caller gives this component a per-turn `key`, so every turn gets a fresh
  clock starting at zero by construction. That keeps the effect free of the
  synchronous setState a manual reset would need — and removes the window
  where a new turn briefly inherits the previous turn's elapsed time and
  opens on the slow-wait copy.
*/
function useElapsedTurnMs(isTurnInProgress: boolean): number {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!isTurnInProgress) {
      return;
    }
    const startedAtMs = Date.now();
    const intervalId = setInterval(() => {
      setElapsedMs(Date.now() - startedAtMs);
    }, ELAPSED_TICK_MS);
    return () => {
      clearInterval(intervalId);
    };
  }, [isTurnInProgress]);

  return elapsedMs;
}

export interface TurnActivityIndicatorProps {
  /*
    True while the turn is in flight (submitted or streaming).
  */
  isTurnInProgress: boolean;
  /*
    The live turn's parts, oldest first. Empty before anything streams back.
  */
  parts: readonly TurnPart[];
}

/**
 * Mount this with a per-turn `key` (see {@link useElapsedTurnMs}) — the
 * transcript uses the turn's opening user-message id.
 */
export function TurnActivityIndicator({ isTurnInProgress, parts }: TurnActivityIndicatorProps) {
  const elapsedMs = useElapsedTurnMs(isTurnInProgress);
  const activity = describeTurnActivity({ isTurnInProgress, parts, elapsedMs });

  if (activity === null) {
    return null;
  }

  return (
    <div
      className="flex w-fit items-center gap-2 rounded-lg border bg-muted/30 px-3 py-1.5"
      data-chat-pending
      data-turn-activity={activity.phase}
      role="status"
      aria-live="polite"
    >
      <span
        className={cn(
          "size-1.5 shrink-0 animate-pulse rounded-full",
          /*
            The waiting pulse is the agent's own colour; once it is stepping
            through work the line recedes to a quiet neutral so the chips
            above it stay the loudest thing in the turn.
          */
          activity.phase === "waiting" ? "bg-primary" : "bg-muted-foreground",
        )}
      />
      <span className="text-xs text-muted-foreground">{activity.message}</span>
    </div>
  );
}
