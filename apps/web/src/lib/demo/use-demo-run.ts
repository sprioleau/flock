"use client";

import { useEffect, useRef, useState } from "react";
import { requestPersonaSweep } from "@/lib/personas/persona-sweep";
import {
  completeRunningTurn,
  createDemoRunState,
  selectRunningTurnIndex,
  startNextTurn,
  type DemoRunState,
  type DemoTurnState,
} from "./demo-turns";

/*
  The driver: the thin, impure half of the sequencer.

  All ordering lives in demo-turns.ts. This hook does exactly two things —
  it fires the running turn's agent, and it reports back when that turn has
  finished. Nothing here measures time.

  WHAT "FINISHED" MEANS, precisely, and why it is trustworthy: the sweep's
  promise resolves when POST /api/personas has returned, and that route only
  returns after it has walked its personas through reading → thinking → idle,
  dry-run-validated their findings, and PERSISTED them to Convex. So by the
  moment this hook advances, the finding the narration is about to point at is
  already a row that every tab's reactive query can see. A wall-clock guess
  could not promise that, which is the whole argument for turn-boundary pacing.

  WHY THE RUN IS MOCKED, unembarrassedly (owner decision): a public route that
  spends real inference is a route that empties a shared free-tier day in
  minutes and takes the rest of the product down with it. The mock costs
  nothing and — this is the part worth saying out loud — only replaces the
  model call itself. The dry-run validation, the Convex persistence, the
  cross-tab reactive delivery, the presence choreography, the staleness
  snapshots and the revert path downstream of it are all the real ones.

  WHERE THAT DECISION NOW LIVES: on the DOCUMENT, not here. `/api/personas`
  reads `documents.isDemo` off the row it already fetches and forces the mock
  from it, so this hook could send nothing at all and the run would still be
  mocked (lib/demo/mock-authority.ts). The header below stays anyway, as belt
  and braces: it is free, it is honest about intent, and if the server-side
  resolution ever regressed, the failure would be a public route spending a
  shared quota per visitor — the one failure worth paying a redundant header
  to avoid.
*/

export interface DemoRunController {
  runState: DemoRunState;
}

export function useDemoRun({ documentId }: { documentId: string | null }): DemoRunController {
  const [runState, setRunState] = useState<DemoRunState>(createDemoRunState);

  /*
    The turn object this hook has already dispatched, held BY IDENTITY rather
    than by index: `startNextTurn` mints a fresh object for the turn it starts,
    so identity distinguishes "turn 1 of this run" from "turn 1 of the run
    after a restart" — an index cannot. It also makes the effect idempotent
    under StrictMode's double-invoke, where firing twice would mean two agent
    turns for one narration beat.
  */
  const dispatchedTurnRef = useRef<DemoTurnState | null>(null);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  /*
    Arrival kicks off turn one. Zero clicks to "there are other people in this
    document" is the demo's first impression, and everything after it is
    elaboration; making a stranger press Start first would spend that moment on
    a button.
  */
  const autoStartedDocumentIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (documentId === null || autoStartedDocumentIdRef.current === documentId) {
      return;
    }
    autoStartedDocumentIdRef.current = documentId;
    setRunState((current) => startNextTurn(current));
  }, [documentId]);

  /*
    Fire whichever turn is running, and chain on its completion.
  */
  useEffect(() => {
    const runningIndex = selectRunningTurnIndex(runState);
    const runningTurn = runningIndex === null ? null : runState.turns[runningIndex];
    if (runningTurn === undefined || runningTurn === null || documentId === null) {
      return;
    }
    if (dispatchedTurnRef.current === runningTurn) {
      return;
    }
    dispatchedTurnRef.current = runningTurn;
    void requestPersonaSweep({
      documentId,
      personaSlugs: [runningTurn.script.personaSlug],
      /*
        ONE persona per call, which is not how the ambient runner batches.
        That is the point: a batched call would flip both agents through their
        statuses in the same two seconds, and the demo is about being able to
        watch one agent take a turn while you type.
      */
      /*
        Redundant since the row became the authority — see the header.
      */
      isMockRun: true,
    }).then((result) => {
      if (!isMountedRef.current) {
        return;
      }
      /*
        Completion and the next start in ONE update: the turn boundary is the
        scheduler, so there is no state in which a turn has finished and
        nothing has been asked to happen next.
      */
      setRunState((current) =>
        startNextTurn(
          completeRunningTurn({
            state: current,
            outcome: result.isOk ? "completed" : "failed",
          }),
        ),
      );
    });
  }, [runState, documentId]);

  return { runState };
}
