"use client";

import { SparklesIcon } from "lucide-react";
import { useOptionalPresenceRoster, type PresenceRosterEntry } from "@/lib/presence";
import { cn } from "@/lib/utils";

/**
 * Phase 6.2a block-level "someone is here" chrome (merge-notify part 1), two
 * strengths per remote ONLINE room member:
 *
 *  - EDITING (`data.editingBlockId` = this block): solid 2px border in their
 *    color + a name tag riding the block's top edge; the agent's pulses.
 *  - SELECTED (`data.selectedBlockId` = this block, any block type): the
 *    LIGHTER sibling treatment — same border/tag family at reduced opacity,
 *    never pulsing. A user who both selected AND is editing this block gets
 *    only the stronger editing treatment (no double chrome).
 *
 * MERGE-NOTIFY: pure indication — it never blocks interaction
 * (pointer-events-none) and stays visually SECONDARY to local selection: it
 * sits below BlockShell's z-10 selection ring, and while the block is locally
 * selected only the name tags render (the border yields to the ring).
 */
export function BlockPresenceIndicator({
  blockId,
  isLocallySelected,
}: {
  blockId: string;
  isLocallySelected: boolean;
}) {
  const roster = useOptionalPresenceRoster();
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
      visitors.push({ entry, isEditingHere: false });
    }
  }
  if (visitors.length === 0) {
    return null;
  }
  // Editing outranks selecting for the (single) border.
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
