import { describe, expect, it } from "vitest";
import {
  DEMO_COMMENT_CHOICES,
  DEMO_STEPS,
  DEMO_STEP_COUNT,
  FIRST_DEMO_STEP_ID,
  findDemoCommentChoice,
  findDemoStep,
  getDemoStepNumber,
  getNextDemoStepId,
  getPreviousDemoStepId,
  selectCanAdvanceDemoStep,
  selectDemoCardDock,
  selectDemoCommentPhase,
  selectIsDemoStepComplete,
  type DemoStepId,
  type DemoStepProgress,
} from "./demo-steps";
import {
  completeRunningTurn,
  createDemoRunState,
  selectIsRunFinished,
  startNextTurn,
  type DemoRunState,
} from "./demo-turns";

/**
 * The stepped flow's rules, which are the flow.
 *
 * Two claims are defended here and they are the ones that would actually hurt
 * in front of a stranger:
 *
 * 1. NOTHING ADVANCES ITSELF. This module takes no time input of any kind, so
 *    the only thing it can answer is whether the VISITOR may move on — and
 *    the gates below are wired to the REAL sequencer state rather than to a
 *    hand-made flag, so "step 1 is finished" means the same thing here as it
 *    does on the canvas.
 * 2. NO STEP SITS ON WHAT IT IS DESCRIBING. The dock is derived from the half
 *    of the canvas the step is about, so it cannot drift out of sync with it.
 */

/** Progress with everything outstanding — the state on arrival. */
const FRESH_PROGRESS: DemoStepProgress = {
  isRunFinished: false,
  undecidedRecommendationCount: 2,
  commentPhase: "choosing",
};

function progressForRun(runState: DemoRunState): DemoStepProgress {
  return { ...FRESH_PROGRESS, isRunFinished: selectIsRunFinished(runState) };
}

describe("the three steps", () => {
  it("runs watch → recommendations → comments, and starts at the top", () => {
    expect(DEMO_STEPS.map((step) => step.id)).toEqual([
      "watch",
      "recommendations",
      "comments",
    ]);
    expect(FIRST_DEMO_STEP_ID).toBe("watch");
    expect(DEMO_STEP_COUNT).toBe(3);
    expect(getPreviousDemoStepId("watch")).toBeNull();
    expect(getNextDemoStepId("comments")).toBeNull();
    expect(getDemoStepNumber("recommendations")).toBe(2);
    expect(findDemoStep("comments").id).toBe("comments");
  });

  it("never parks the card over the half of the canvas the step is about", () => {
    for (const step of DEMO_STEPS) {
      // "upper" subject must not produce an "upper-*" dock, and vice versa.
      expect(selectDemoCardDock(step).startsWith(step.subjectRegion)).toBe(false);
    }
    // Both directions of the derivation, checked against a step whose subject
    // is in the other band — every real step is a lower-band step today (see
    // selectDemoCardDock), so this is what keeps the rule from rotting into a
    // constant nobody notices is wrong.
    expect(selectDemoCardDock({ ...DEMO_STEPS[0]!, subjectRegion: "upper" })).toBe("lower-right");
    expect(selectDemoCardDock({ ...DEMO_STEPS[0]!, subjectRegion: "lower" })).toBe("upper-right");
  });
});

describe("advancing", () => {
  it("moves only when the visitor moves it — the module holds no cursor at all", () => {
    /*
      There is no current step in here to advance, and no input that could
      make one advance: every function takes the step it is asked about. So
      the ONLY way to reach step 2 is for a caller to ask for the next id and
      store it, which is a click handler in DemoRunPanel and nothing else.
    */
    const finished: DemoStepProgress = {
      isRunFinished: true,
      undecidedRecommendationCount: 0,
      commentPhase: "answered",
    };
    expect(selectCanAdvanceDemoStep({ stepId: "watch", progress: finished })).toBe(true);
    // Asked again, and again: still step 1's permission. Permission is not motion.
    expect(selectCanAdvanceDemoStep({ stepId: "watch", progress: finished })).toBe(true);
    expect(getNextDemoStepId("watch")).toBe("recommendations");
  });

  it("will not leave step 1 until BOTH turns have reported in", () => {
    // Driven through the real sequencer, so this gate cannot disagree with
    // what the visitor is watching on the canvas.
    let run = createDemoRunState();
    expect(selectCanAdvanceDemoStep({ stepId: "watch", progress: progressForRun(run) })).toBe(
      false,
    );

    run = startNextTurn(run);
    expect(selectCanAdvanceDemoStep({ stepId: "watch", progress: progressForRun(run) })).toBe(
      false,
    );

    run = completeRunningTurn({ state: run, outcome: "completed" });
    // One agent has posted; the other has not taken its turn yet.
    expect(selectCanAdvanceDemoStep({ stepId: "watch", progress: progressForRun(run) })).toBe(
      false,
    );

    run = completeRunningTurn({ state: startNextTurn(run), outcome: "completed" });
    expect(selectCanAdvanceDemoStep({ stepId: "watch", progress: progressForRun(run) })).toBe(
      true,
    );
  });

  it("does not strand the visitor on a turn that failed", () => {
    // A failed turn still reported in. Refusing to move on would leave a
    // stranger on a step whose work can never finish.
    let run = startNextTurn(createDemoRunState());
    run = completeRunningTurn({ state: run, outcome: "failed" });
    run = completeRunningTurn({ state: startNextTurn(run), outcome: "failed" });
    expect(selectCanAdvanceDemoStep({ stepId: "watch", progress: progressForRun(run) })).toBe(
      true,
    );
  });

  it("holds step 2 while a recommendation is still undecided", () => {
    expect(
      selectIsDemoStepComplete({
        stepId: "recommendations",
        progress: { ...FRESH_PROGRESS, isRunFinished: true, undecidedRecommendationCount: 1 },
      }),
    ).toBe(false);
  });

  it("counts a DISMISSED recommendation as decided", () => {
    /*
      The step the visitor just read says they hold the decision. A gate that
      only opened on Accept would contradict it — and would be the one moment
      in the demo where the product takes the choice back.
    */
    expect(
      selectIsDemoStepComplete({
        stepId: "recommendations",
        progress: { ...FRESH_PROGRESS, isRunFinished: true, undecidedRecommendationCount: 0 },
      }),
    ).toBe(true);
  });

  it("offers nowhere to advance from the last step", () => {
    for (const commentPhase of ["choosing", "awaiting-agent", "answered"] as const) {
      expect(
        selectCanAdvanceDemoStep({
          stepId: "comments",
          progress: { ...FRESH_PROGRESS, commentPhase },
        }),
      ).toBe(false);
    }
  });
});

describe("the comment script", () => {
  it("offers several distinct things to say, each with its own real comment text", () => {
    expect(DEMO_COMMENT_CHOICES.length).toBeGreaterThanOrEqual(3);
    // Distinct ASKS, not three phrasings of one ask: the beat's whole claim is
    // that the agent answered the thing the visitor picked.
    expect(new Set(DEMO_COMMENT_CHOICES.map((choice) => choice.id)).size).toBe(
      DEMO_COMMENT_CHOICES.length,
    );
    expect(new Set(DEMO_COMMENT_CHOICES.map((choice) => choice.commentText)).size).toBe(
      DEMO_COMMENT_CHOICES.length,
    );
    for (const choice of DEMO_COMMENT_CHOICES) {
      expect(findDemoCommentChoice(choice.id)).toBe(choice);
    }
    expect(findDemoCommentChoice(null)).toBeUndefined();
  });

  it("waits for the AGENT's entry, not for its own dispatch", () => {
    expect(
      selectDemoCommentPhase({ chosenChoiceId: null, threadAuthorKinds: null }),
    ).toBe("choosing");
    // The row exists and carries only the visitor's own comment: still waiting.
    expect(
      selectDemoCommentPhase({ chosenChoiceId: "shorter", threadAuthorKinds: ["user"] }),
    ).toBe("awaiting-agent");
    // The reply is written by the fix dispatch's settlement callback, and an
    // errored turn never settles — so this is the one honest signal that the
    // round trip actually completed.
    expect(
      selectDemoCommentPhase({ chosenChoiceId: "shorter", threadAuthorKinds: ["user", "agent"] }),
    ).toBe("answered");
  });

  it("finishes step 3 only once the agent has answered", () => {
    const stepId: DemoStepId = "comments";
    expect(
      selectIsDemoStepComplete({
        stepId,
        progress: { ...FRESH_PROGRESS, commentPhase: "awaiting-agent" },
      }),
    ).toBe(false);
    expect(
      selectIsDemoStepComplete({
        stepId,
        progress: { ...FRESH_PROGRESS, commentPhase: "answered" },
      }),
    ).toBe(true);
  });
});
