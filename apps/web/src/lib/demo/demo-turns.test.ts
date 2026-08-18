import { describe, expect, it } from "vitest";
import {
  DEMO_PERSONA_SLUGS,
  DEMO_TURN_SCRIPT,
  completeRunningTurn,
  createDemoRunState,
  restartDemoRunState,
  selectActiveNarration,
  selectCompletedTurns,
  selectIsRunFinished,
  selectNextPendingTurnIndex,
  selectRunningTurnIndex,
  startNextTurn,
  type DemoRunState,
} from "./demo-turns";

/**
 * The demo's ordering rules, which are the demo.
 *
 * The claim these tests exist to defend is that the sequencer advances on TURN
 * COMPLETION and on nothing else — no elapsed time, no wall clock, no
 * scheduled catch-up. That is enforceable here precisely because the module
 * takes no time input at all: the only way to move it is to tell it a turn
 * reported in, and the tests below check that every other route is closed.
 */

function startedRun(): DemoRunState {
  return startNextTurn(createDemoRunState());
}

describe("the scripted run", () => {
  it("runs one agent per turn, in the order the narration names them", () => {
    expect(DEMO_TURN_SCRIPT.map((turn) => turn.personaSlug)).toEqual([
      "builtin/tone-police",
      "builtin/styling-recommender",
    ]);
    // The enablement list is DERIVED from the script — a second hardcoded
    // roster would let the demo enable an agent it never narrates.
    expect(DEMO_PERSONA_SLUGS).toEqual(DEMO_TURN_SCRIPT.map((turn) => turn.personaSlug));
  });

  it("starts with nothing running, so arrival is not mid-turn", () => {
    const state = createDemoRunState();
    expect(selectRunningTurnIndex(state)).toBeNull();
    expect(state.turns.every((turn) => turn.status === "pending")).toBe(true);
  });
});

describe("advancing", () => {
  it("REFUSES to start the next turn while one is running — the turn boundary is the only scheduler", () => {
    const running = startedRun();
    expect(selectRunningTurnIndex(running)).toBe(0);
    expect(selectNextPendingTurnIndex(running)).toBeNull();
    // Same reference back: a re-render, a double click, or any number of
    // repeated calls can never overlap two agent turns.
    expect(startNextTurn(running)).toBe(running);
    expect(startNextTurn(startNextTurn(running))).toBe(running);
  });

  it("advances only once the running turn reports in", () => {
    const afterFirstTurn = completeRunningTurn({ state: startedRun(), outcome: "completed" });
    expect(afterFirstTurn.turns[0]!.status).toBe("completed");
    expect(selectRunningTurnIndex(afterFirstTurn)).toBeNull();

    const secondRunning = startNextTurn(afterFirstTurn);
    expect(selectRunningTurnIndex(secondRunning)).toBe(1);
    // The first turn stays landed — the chain never rewinds what it has shown.
    expect(secondRunning.turns[0]!.status).toBe("completed");
  });

  it("finishes when the last turn reports in, and stays finished", () => {
    const finished = completeRunningTurn({
      state: startNextTurn(completeRunningTurn({ state: startedRun(), outcome: "completed" })),
      outcome: "completed",
    });
    expect(selectIsRunFinished(finished)).toBe(true);
    expect(startNextTurn(finished)).toBe(finished);
  });

  it("does not stall the chain when a turn fails, but never claims it landed", () => {
    const afterFailure = completeRunningTurn({ state: startedRun(), outcome: "failed" });
    expect(selectNextPendingTurnIndex(afterFailure)).toBe(1);
    // A failed turn is excluded from what the panel points the visitor at, so
    // nobody is sent looking for a recommendation that was never posted.
    expect(selectCompletedTurns(afterFailure)).toEqual([]);
    expect(selectActiveNarration(afterFailure)).toBeNull();
  });

  it("completing with nothing running changes nothing", () => {
    const idle = createDemoRunState();
    expect(completeRunningTurn({ state: idle, outcome: "completed" })).toBe(idle);
  });
});

describe("restarting", () => {
  it("returns a run that is clean from the top, mid-run or finished", () => {
    const midRun = startNextTurn(completeRunningTurn({ state: startedRun(), outcome: "completed" }));
    const restarted = restartDemoRunState();
    expect(restarted.status).toBe("idle");
    expect(restarted.turns.every((turn) => turn.status === "pending")).toBe(true);
    // Nothing is shared with the run it replaced — a carried-over turn object
    // would let the driver think it had already dispatched turn one.
    expect(restarted.turns[0]).not.toBe(midRun.turns[0]);
  });
});

describe("narration", () => {
  it("speaks for the running turn, then for the last one that landed", () => {
    const running = startedRun();
    expect(selectActiveNarration(running)).toBe(DEMO_TURN_SCRIPT[0]!.runningNarration);
    const landed = completeRunningTurn({ state: running, outcome: "completed" });
    expect(selectActiveNarration(landed)).toBe(DEMO_TURN_SCRIPT[0]!.completedNarration);
  });
});
