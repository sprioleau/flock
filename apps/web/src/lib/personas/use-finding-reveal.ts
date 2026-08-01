"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { getFindingCardRevealAtMs } from "./finding-presentation";

/**
 * Which findings have passed their card-reveal instant (the dwell-gate that
 * makes a recommendation "post" only after its persona's dwell + select beat
 * — see finding-presentation.ts). A tiny external clock store in the
 * useIsPresentationWindowOpen idiom: the snapshot is a STABLE string of the
 * revealed ids (it only changes when a reveal instant actually crosses), and
 * the subscription arms one timeout for the next upcoming reveal — no
 * ticking, no render-time clock reads outside the snapshot.
 *
 * Findings that arrive already old (a tab that loaded later, or an open row
 * re-read after reload) are revealed from the first render, so the gate only
 * ever delays a FRESH finding's debut.
 */

export interface RevealableFindingRef {
  findingId: string;
  createdAtMs: number;
}

/** Small cushion so the timer never fires a hair before the clock crosses. */
const REVEAL_TIMER_CUSHION_MS = 15;

function parseFindingSignature(signature: string): RevealableFindingRef[] {
  if (signature === "") {
    return [];
  }
  return signature.split("\n").map((part) => {
    const separatorIndex = part.lastIndexOf(":");
    return {
      findingId: part.slice(0, separatorIndex),
      createdAtMs: Number(part.slice(separatorIndex + 1)),
    };
  });
}

export function useRevealedFindingIds({
  findings,
}: {
  findings: readonly RevealableFindingRef[];
}): ReadonlySet<string> {
  // Value signature (not array identity) so a re-render with an equal list
  // never re-subscribes. Convex ids contain no colons or newlines.
  const signature = findings
    .map((finding) => `${finding.findingId}:${finding.createdAtMs}`)
    .join("\n");

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const revealAtMsValues = parseFindingSignature(signature).map((finding) =>
        getFindingCardRevealAtMs({ findingCreatedAtMs: finding.createdAtMs }),
      );
      let timerId: number | null = null;
      const armNextRevealTimer = (): void => {
        const nowMs = Date.now();
        const futureRevealAtMsValues = revealAtMsValues.filter((atMs) => atMs > nowMs);
        if (futureRevealAtMsValues.length === 0) {
          return; // everything visible already — nothing left to wait for
        }
        const nextRevealAtMs = Math.min(...futureRevealAtMsValues);
        timerId = window.setTimeout(() => {
          onStoreChange();
          armNextRevealTimer();
        }, Math.max(0, nextRevealAtMs - Date.now()) + REVEAL_TIMER_CUSHION_MS);
      };
      armNextRevealTimer();
      return () => {
        if (timerId !== null) {
          window.clearTimeout(timerId);
        }
      };
    },
    [signature],
  );

  const getRevealedIdsSnapshot = useCallback(() => {
    const nowMs = Date.now();
    return parseFindingSignature(signature)
      .filter(
        (finding) =>
          getFindingCardRevealAtMs({ findingCreatedAtMs: finding.createdAtMs }) <= nowMs,
      )
      .map((finding) => finding.findingId)
      .join("\n");
  }, [signature]);

  const revealedIdsJoined = useSyncExternalStore(
    subscribe,
    getRevealedIdsSnapshot,
    () => "",
  );

  return useMemo(
    () => new Set(revealedIdsJoined === "" ? [] : revealedIdsJoined.split("\n")),
    [revealedIdsJoined],
  );
}
