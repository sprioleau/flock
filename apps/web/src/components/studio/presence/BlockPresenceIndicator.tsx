"use client";

import { useEffect, useRef, useState } from "react";
import { SparklesIcon } from "lucide-react";
import { FINDING_DWELL_MS } from "@/lib/personas/finding-presentation";
import { useOptionalPresenceRoster, type PresenceRosterEntry } from "@/lib/presence";
import { cn } from "@/lib/utils";
import { extractPersonaSlugFromPresenceUserId } from "./persona-cursor-helpers";

/*
  Phase 6.2a block-level "someone is here" chrome (merge-notify part 1), two
  strengths per remote ONLINE room member:

   - EDITING (`data.editingBlockId` = this block): solid 2px border in their
     color + a name tag riding the block's top edge; the agent's pulses.
   - SELECTED (`data.selectedBlockId` = this block, any block type): the
     LIGHTER sibling treatment — same border/tag family at reduced opacity,
     never pulsing. A user who both selected AND is editing this block gets
     only the stronger editing treatment (no double chrome).

  PERSONA SELECTIONS ARE DELAYED (owner feedback 2026-07-31 — the legible
  wander → dwell → select → post flow): when a persona's presence
  `selectedBlockId` lands on this block (the runner points it at its top
  finding's target), the selected treatment appears only after
  FINDING_DWELL_MS of local receipt time — while the persona's cursor is
  visibly dwell-hovering the block — so the SELECT beat lands as its own
  moment, just before the recommendation card posts. Still 100% the
  presence-level selection mechanism (same data, same chrome, same room);
  only the reveal timing is gated, and the human's local selection state is
  never touched. Human selections stay instant.

  MERGE-NOTIFY: pure indication — it never blocks interaction
  (pointer-events-none) and stays visually SECONDARY to local selection: it
  sits below BlockShell's z-10 selection ring, and while the block is locally
  selected only the name tags render (the border yields to the ring).
*/

/*
  Which persona selections on this block have finished their dwell delay.
  Local-receipt timing (~createdAtMs + mutation latency ≈ the cursor's
  server-stamped dwell clock — cosmetically consistent across tabs): one
  timeout per newly-seen persona selection; a selection that moves away and
  comes back dwells again.
*/
function useRevealedPersonaSelections({
  personaUserIds,
}: {
  personaUserIds: readonly string[];
}): ReadonlySet<string> {
  const signature = personaUserIds.join("\n");
  const [revealState, setRevealState] = useState<{
    signature: string;
    revealedUserIds: ReadonlySet<string>;
  }>({ signature, revealedUserIds: new Set() });
  /*
    Render-time state adjustment (the codebase's document-switch pattern): a
    selection that ended is forgotten immediately, so a later re-selection
    of this block dwells again.
  */
  if (revealState.signature !== signature) {
    const currentUserIds = new Set(signature === "" ? [] : signature.split("\n"));
    setRevealState({
      signature,
      revealedUserIds: new Set(
        [...revealState.revealedUserIds].filter((userId) => currentUserIds.has(userId)),
      ),
    });
  }
  const timersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const currentUserIds = new Set(signature === "" ? [] : signature.split("\n"));
    const timers = timersRef.current;
    /*
      A selection that ended cancels its pending reveal timer.
    */
    for (const [userId, timerId] of [...timers]) {
      if (!currentUserIds.has(userId)) {
        window.clearTimeout(timerId);
        timers.delete(userId);
      }
    }
    /*
      One dwell timer per newly-seen persona selection. (An already-revealed
      id may re-arm a timer after roster churn — its fire is a no-op.)
    */
    for (const userId of currentUserIds) {
      if (timers.has(userId)) {
        continue;
      }
      const timerId = window.setTimeout(() => {
        timers.delete(userId);
        setRevealState((previous) =>
          previous.revealedUserIds.has(userId)
            ? previous
            : {
                ...previous,
                revealedUserIds: new Set([...previous.revealedUserIds, userId]),
              },
        );
      }, FINDING_DWELL_MS);
      timers.set(userId, timerId);
    }
  }, [signature]);

  /*
    Unmount: drop every pending reveal timer.
  */
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timerId of timers.values()) {
        window.clearTimeout(timerId);
      }
      timers.clear();
    };
  }, []);

  return revealState.revealedUserIds;
}

export function BlockPresenceIndicator({
  blockId,
  isLocallySelected,
}: {
  blockId: string;
  isLocallySelected: boolean;
}) {
  const roster = useOptionalPresenceRoster();

  /*
    Persona selections pointed at THIS block (candidates for the delayed
    reveal). Computed before any early return so hook order stays stable.
  */
  const pendingPersonaUserIds = (roster ?? []).flatMap((entry) => {
    const isPersonaSelectionHere =
      extractPersonaSlugFromPresenceUserId(entry.userId) !== null &&
      entry.isOnline &&
      entry.data.selectedBlockId === blockId &&
      entry.data.editingBlockId !== blockId;
    return isPersonaSelectionHere ? [entry.userId] : [];
  });
  const revealedPersonaUserIds = useRevealedPersonaSelections({
    personaUserIds: pendingPersonaUserIds,
  });

  if (roster === null) {
    return null;
  }
  const visitors: Array<{ entry: PresenceRosterEntry; isEditingHere: boolean }> = [];
  for (const entry of roster) {
    if (entry.isSelf || !entry.isOnline) {
      continue;
    }
    if (entry.data.editingBlockId === blockId) {
      visitors.push({ entry, isEditingHere: true });
    } else if (entry.data.selectedBlockId === blockId) {
      const isPersonaEntry = extractPersonaSlugFromPresenceUserId(entry.userId) !== null;
      if (isPersonaEntry && !revealedPersonaUserIds.has(entry.userId)) {
        continue; /* persona selection still inside its dwell beat */
      }
      visitors.push({ entry, isEditingHere: false });
    }
  }
  if (visitors.length === 0) {
    return null;
  }
  /*
    Editing outranks selecting for the (single) border.
  */
  const primary = visitors.find((visitor) => visitor.isEditingHere) ?? visitors[0];
  return (
    <div
      className="pointer-events-none absolute -inset-px z-[5]"
      aria-hidden
      data-testid="block-presence-indicator"
    >
      {!isLocallySelected && (
        <div
          className={cn(
            "absolute inset-0 rounded-[3px] border-2",
            !primary.isEditingHere && "opacity-40",
            primary.isEditingHere && primary.entry.data.isAgent === true && "animate-pulse",
          )}
          style={{ borderColor: primary.entry.data.color }}
          data-presence-strength={primary.isEditingHere ? "editing" : "selected"}
        />
      )}
      <div className="absolute -top-2 right-1 flex max-w-full gap-1">
        {visitors.map(({ entry, isEditingHere }) => (
          <span
            key={entry.userId}
            className={cn(
              "flex items-center gap-0.5 truncate rounded-sm px-1 py-px text-[9px] font-medium leading-3 text-white",
              !isEditingHere && "opacity-70",
            )}
            style={{ backgroundColor: entry.data.color }}
            data-testid="block-presence-label"
            data-presence-strength={isEditingHere ? "editing" : "selected"}
          >
            {entry.data.isAgent === true && <SparklesIcon className="size-2.5 shrink-0" />}
            {entry.data.isAgent === true && isEditingHere
              ? `${entry.data.name} is editing…`
              : entry.data.name}
          </span>
        ))}
      </div>
    </div>
  );
}
