/*
  The /demo run script and its turn sequencer — pure state, and deliberately
  NO CLOCK.

  WHY A SEQUENCER AT ALL, when the persona runner is already reactive.
  The product's real trigger is a settled human edit (use-persona-advisors.ts),
  and that stays exactly as it is. What /demo needs on top is a REASON for the
  agents to run in front of a visitor who has not typed anything yet, and an
  order to run them in. So the demo drives its agents one turn at a time and
  narrates each turn as it lands.

  WHY SEQUENTIAL AND NOT A FAN-OUT (owner decision, 2026-08-17). Firing both
  personas at once is one batched call and about four seconds of everything
  happening simultaneously — which reads as a loading spinner with avatars on
  it. Running them one after another means there is always a NEXT thing about
  to happen, and the gap between turns is the window in which a solo visitor
  can be editing the same document WHILE an agent turn lands. That overlap is
  the entire headline claim ("humans and agents in one document"), and it only
  exists if the turns are spread out.

  WHY THE TURN BOUNDARY IS THE SCHEDULER, AND NOT A TIMER. Every state
  transition below is caused by a turn REPORTING that it finished. There is no
  `nowMs` parameter, no interval, no `setTimeout` anywhere in this module or in
  the hook that drives it (use-demo-run.ts) — `startNextTurn` is a no-op while
  any turn is running, so the only way to reach turn N+1 is for turn N to
  complete. A timer-driven demo drifts the moment the network is slow, and it
  drifts in front of exactly the audience it was built for: the narration would
  claim an agent had posted a recommendation while the request was still in
  flight. The existing DemoQueueButton reached the same conclusion for chat
  turns ("each agent turn fully completes before the next prompt sends") — this
  is the same rule applied to persona turns.

  Everything here is a pure function over a plain object so the ordering rules
  are unit-tested directly, rather than through a component this app's
  node-only vitest environment could not render anyway.
*/

/*
  One scripted turn: one persona, run alone, narrated on its own.
*/
export interface DemoTurnScript {
  /*
    Registry slug — personas are pure data, so this is the only binding.
  */
  personaSlug: string;
  personaName: string;
  /*
    Presence/finding color, mirrored from the registry row for the chip dot.
  */
  personaColor: string;
  /*
    What the visitor is told while this turn is in flight.
  */
  runningNarration: string;
  /*
    What the visitor is told once it has landed.
  */
  completedNarration: string;
}

/*
  The two agents the owner named. Both are advisory-only and both carry a 45s
  cooldown with a slug-hashed stagger, so in normal ambient use they already
  never come due together — the demo simply makes that separation explicit and
  legible instead of leaving it to a hash.
*/
export const DEMO_TURN_SCRIPT: readonly DemoTurnScript[] = [
  {
    personaSlug: "builtin/tone-police",
    personaName: "Tone Police",
    personaColor: "#e11d48",
    runningNarration:
      "Tone Police is reading your email — watch its cursor move to the block it is judging.",
    completedNarration:
      "Tone Police posted a recommendation. It cannot change your email; only you can.",
  },
  {
    personaSlug: "builtin/styling-recommender",
    personaName: "Styling Recommender",
    personaColor: "#0d9488",
    runningNarration:
      "Now the Styling Recommender takes its turn. Keep typing while it works — you are both in this document.",
    completedNarration:
      "Both agents have had a turn. Their recommendations are waiting for you to accept or ignore.",
  },
];

/*
  The personas the demo enables — derived, never a second hardcoded list.
*/
export const DEMO_PERSONA_SLUGS: readonly string[] = DEMO_TURN_SCRIPT.map(
  (turn) => turn.personaSlug,
);

/*
  "failed" is kept distinct from "completed" rather than collapsed into one
  terminal state: a turn whose request failed still has to let the chain move
  on (a stalled demo is worse than an incomplete one), but the narration must
  not claim a recommendation landed when none did.
*/
export type DemoTurnStatus = "pending" | "running" | "completed" | "failed";

export type DemoTurnOutcome = "completed" | "failed";

export interface DemoTurnState {
  script: DemoTurnScript;
  status: DemoTurnStatus;
}

export interface DemoRunState {
  /*
    "idle" is before the visitor presses start, "finished" is after the last
    turn reported in. Both mean "no turn is running", but only one of them
    means "there is more to see", which is what the panel's copy turns on.
  */
  status: "idle" | "running" | "finished";
  turns: readonly DemoTurnState[];
}

/*
  A fresh, unstarted run of the script above.
*/
export function createDemoRunState(): DemoRunState {
  return {
    status: "idle",
    turns: DEMO_TURN_SCRIPT.map((script) => ({ script, status: "pending" as const })),
  };
}

/*
  Restart is deliberately the SAME construction as a first run rather than a
  reset that tries to preserve anything. The owner asked for a replayable demo;
  the honest floor for that is "starts from the top, cleanly, every time", and
  a restart that carried a scrap of the previous run's state forward would be
  the one path nobody tests.
*/
export function restartDemoRunState(): DemoRunState {
  return createDemoRunState();
}

/*
  Index of the turn currently in flight, or null when none is.
*/
export function selectRunningTurnIndex(state: DemoRunState): number | null {
  const index = state.turns.findIndex((turn) => turn.status === "running");
  return index === -1 ? null : index;
}

/*
  THE RULE, in one function: while a turn is running there is no next turn.

  Not "the next turn is scheduled for later" — there is no schedule. The
  sequencer is blind to time and can only be moved by completeRunningTurn.
*/
export function selectNextPendingTurnIndex(state: DemoRunState): number | null {
  if (selectRunningTurnIndex(state) !== null) {
    return null;
  }
  const index = state.turns.findIndex((turn) => turn.status === "pending");
  return index === -1 ? null : index;
}

/*
  Begin the next pending turn. Returns the state UNCHANGED (same reference)
  when a turn is already running or nothing is left — so a stray call from a
  double-click or a re-render can never double-fire an agent turn.
*/
export function startNextTurn(state: DemoRunState): DemoRunState {
  const nextIndex = selectNextPendingTurnIndex(state);
  if (nextIndex === null) {
    return state;
  }
  return {
    status: "running",
    turns: state.turns.map((turn, index) =>
      index === nextIndex ? { ...turn, status: "running" as const } : turn,
    ),
  };
}

/*
  Record that the running turn reported in. This is the ONLY transition that
  frees the sequencer to move, which is what makes turn completion — rather
  than elapsed time — the scheduler.
*/
export function completeRunningTurn({
  state,
  outcome,
}: {
  state: DemoRunState;
  outcome: DemoTurnOutcome;
}): DemoRunState {
  const runningIndex = selectRunningTurnIndex(state);
  if (runningIndex === null) {
    return state;
  }
  const turns = state.turns.map((turn, index) =>
    index === runningIndex ? { ...turn, status: outcome } : turn,
  );
  /*
    A failed turn still counts as "had its turn": the chain moves on, and the
    panel reads the per-turn status to decide whether it may claim a
    recommendation landed.
  */
  const hasPendingTurns = turns.some((turn) => turn.status === "pending");
  return { status: hasPendingTurns ? "running" : "finished", turns };
}

/*
  True once every turn has reported in — the panel's call-to-action state.
*/
export function selectIsRunFinished(state: DemoRunState): boolean {
  return state.status === "finished";
}

/*
  The personas that have actually posted this run, oldest first. This is what
  the panel points the visitor at — a persona whose turn failed is not in it,
  so the demo never sends anyone looking for a recommendation that never
  arrived.
*/
export function selectCompletedTurns(state: DemoRunState): readonly DemoTurnState[] {
  return state.turns.filter((turn) => turn.status === "completed");
}

/*
  The one line of narration on screen right now: the running turn's, else the
  last landed turn's, else null before the run starts.
*/
export function selectActiveNarration(state: DemoRunState): string | null {
  const runningIndex = selectRunningTurnIndex(state);
  if (runningIndex !== null) {
    return state.turns[runningIndex]!.script.runningNarration;
  }
  const completedTurns = selectCompletedTurns(state);
  const lastCompleted = completedTurns[completedTurns.length - 1];
  return lastCompleted?.script.completedNarration ?? null;
}
