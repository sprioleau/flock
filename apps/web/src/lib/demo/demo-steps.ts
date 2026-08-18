/*
  The /demo card's STEP MODEL: what the three steps are, in what order they
  run, what has to be true before the visitor may leave one, where the card is
  allowed to sit while each is on screen, and the comment script step 3 offers.

  WHY THIS IS A MODULE AND NOT COMPONENT STATE. vitest.config.ts pins
  `environment: "node"` for all of src/**, so a component that decides its own
  ordering decides it somewhere no test can reach. lib/tour/tour-stops.ts made
  the same split for the same reason and it is the only reason that feature is
  testable at all: the DATA of a stepped flow — which steps exist, what they
  say, what gates each one, where each one docks — is pure, and the component
  is a render over it.

  THE FLOW IS MANUALLY ADVANCED (owner decision). Nothing here moves on its
  own. There is no clock in this module, no elapsed-time input to any function
  below, and no "after N seconds" anywhere: `selectCanAdvanceDemoStep` answers
  whether the visitor MAY press Next, never whether something should happen
  next. That is the same rule demo-turns.ts holds for the agent turns — the
  turn boundary is the scheduler, never a timer — extended to the narration
  around them. A demo that advances itself is a video, and a video is a thing
  the visitor cannot be in the middle of.

  WHAT GATES A STEP, and why gating is safe rather than a trap. Steps 1 and 2
  both hard-gate Next on their own work being finished, because there is
  literally nothing to look at on the next step until it is: step 2 without
  posted findings is an empty list, and it would read as the agents having
  failed. Neither gate can strand anybody — a turn that FAILS still reports in
  (demo-turns.ts keeps "failed" distinct from "completed" precisely so the
  chain moves on), and a recommendation can always be dismissed, which counts
  as decided. The last step gates nothing: it ends in an exit.
*/

/* Stable ids as a union rather than `string`, so the ordering helpers, the
   gating switch and the component's per-step rendering are all compiler-
   checked — the same discipline tour-stops.ts uses for TourStopId. */
export type DemoStepId = "watch" | "recommendations" | "comments";

/*
  Which half of the CANVAS a step is about.

  This exists for one requirement and it is not cosmetic: a card that sits on
  top of the block it is describing is worse than no card, because the visitor
  reads a sentence about a heading they cannot see. The seed email
  (packages/email-sdk demo-document.ts) puts the two planted problems in its
  lower half — the shouted paragraph `txt_push` and the drifted CTA `btn_scnd`
  — and the hero CTA `btn_prim` in its upper half, so "which half" is a real
  property of each step rather than a guess.
*/
export type DemoCanvasRegion = "upper" | "lower";

/*
  A step's region is where its ARTEFACT lands on screen, not where its block
  sits in the document's source order. The distinction is not academic: step
  3's comment is anchored to the hero CTA, which reads as "near the top" and
  renders two thirds of the way down a first screen — and the thing the
  visitor is actually meant to read, the comment thread's popover, hangs BELOW
  that pin again. Classifying it by document order docked the card straight
  underneath the popover, which then painted over half the card including its
  call to action (observed in the browser, 2026-08-18).
*/

/* Where the card docks. Always on the right: the chat panel is on the LEFT of
   the studio row and the recommendation cards land inside it, so a
   left-docked card would sit beside (and, on a narrow window, over) the very
   surface step 2 points at. */
export type DemoCardDock = "upper-right" | "lower-right";

export interface DemoStep {
  id: DemoStepId;
  /* The card's heading — what the visitor is about to watch, in their terms. */
  title: string;
  /* Two sentences at most: what is happening, and why it is worth a look. */
  body: string;
  /* See DemoCanvasRegion. The dock is derived from this, never set by hand. */
  subjectRegion: DemoCanvasRegion;
}

/*
  The three steps, in the order they run.

  ORDERING RATIONALE. The demo is one argument in three moves: the agents act
  on their own (watch), you decide what to keep (recommendations), and then you
  answer back and they act again (comments). Step 3 last is the only order that
  works, because it is the only step that is a ROUND TRIP — it needs something
  on the canvas already worth talking about, and it needs the visitor to have
  already seen an agent post something before they are asked to reply to one.
*/
export const DEMO_STEPS: readonly DemoStep[] = [
  {
    id: "watch",
    title: "Two agents are reading your email",
    body: "They take turns instead of talking over each other. Watch each one move on the canvas, then post what it found.",
    /* Both personas dwell on the blocks they are judging, and both of those
       are in the lower half of the seed email. */
    subjectRegion: "lower",
  },
  {
    id: "recommendations",
    title: "What they found",
    body: "Each recommendation carries the exact edit it would make. Accept it and it applies in one press — dismiss it and nothing happens.",
    subjectRegion: "lower",
  },
  {
    id: "comments",
    title: "Now answer one back",
    body: "Pick something to say about the hero button. It becomes a real comment on the canvas, and the agent replies in the thread.",
    /* The pin goes on the hero CTA, and its thread popover opens below it —
       so the band to keep clear is the lower one, same as the other two. */
    subjectRegion: "lower",
  },
];

export const DEMO_STEP_COUNT = DEMO_STEPS.length;

/** The step a fresh visit opens on. */
export const FIRST_DEMO_STEP_ID: DemoStepId = "watch";

/**
 * The step for an id. Total rather than partial: DemoStepId is a closed union
 * over DEMO_STEPS, so a miss is impossible — and returning the first step
 * rather than `undefined` keeps every caller free of a branch that can never
 * be taken.
 */
export function findDemoStep(stepId: DemoStepId): DemoStep {
  return DEMO_STEPS.find((step) => step.id === stepId) ?? DEMO_STEPS[0]!;
}

/** 1-based position, for the "Step 2 of 3" counter. */
export function getDemoStepNumber(stepId: DemoStepId): number {
  return DEMO_STEPS.findIndex((step) => step.id === stepId) + 1;
}

/** The step after this one, or null when this is the last. */
export function getNextDemoStepId(stepId: DemoStepId): DemoStepId | null {
  return DEMO_STEPS[getDemoStepNumber(stepId)]?.id ?? null;
}

/** The step before this one, or null when this is the first. */
export function getPreviousDemoStepId(stepId: DemoStepId): DemoStepId | null {
  return DEMO_STEPS[getDemoStepNumber(stepId) - 2]?.id ?? null;
}

/**
 * Where the card sits while this step is on screen: the half of the canvas the
 * step is NOT talking about.
 *
 * Derived rather than declared, so a step whose subject moves cannot keep a
 * dock that now covers it — the one failure this rule exists to prevent.
 *
 * ALL THREE STEPS RESOLVE TO `upper-right` TODAY, and that is a fact about the
 * seed email rather than a sign the rule is idle: everything worth watching in
 * it — the shouted paragraph, the drifted second CTA, and the comment thread
 * hanging under the hero button's pin — is in the lower band of a first
 * screen, so there is exactly one place a card can stand without being in the
 * way. The derivation earns its keep the moment a step is added whose subject
 * is not (the brand kit, the footer, a header block), which is precisely when
 * a hand-set dock would quietly start covering it.
 */
export function selectDemoCardDock(step: DemoStep): DemoCardDock {
  return step.subjectRegion === "upper" ? "lower-right" : "upper-right";
}

/* ------------------------------------------------------------------ */
/* Step 3: the comment script                                          */
/* ------------------------------------------------------------------ */

/*
  WHY A MULTIPLE CHOICE AT ALL (owner ask). Comments mode is a round trip —
  a human says what is wrong, the agent edits and answers in the thread — and a
  stranger cannot demonstrate a round trip to themselves, because the first
  half of it is "think of a useful thing to say about a coffee email you have
  never seen before". The choices remove exactly that step and nothing else:
  the text below is written to a REAL comments row, dispatched through the REAL
  comment-fix path, and answered by a REAL chat turn. Scripted content, real
  pipeline — the standard the rest of /demo already holds to.
*/

/**
 * The block the demo's comment is anchored to: the hero CTA of the seed email
 * (packages/email-sdk demo-document.ts).
 *
 * A BUTTON, deliberately, and this is load-bearing rather than aesthetic. A
 * comment-fix turn resolves to `updateBlockProperties` against the block the
 * canvas has SELECTED, and the edit it makes is a label — which only a button
 * has. Anchoring the demo's comment to a paragraph would dispatch a real turn
 * that proposed an invalid edit and degraded to a failure chip in front of a
 * visitor. The hero CTA is also the one button the visitor has certainly
 * already looked at, and it is in the half of the email the card does not
 * cover on this step.
 */
export const DEMO_COMMENT_TARGET_BLOCK_ID = "btn_prim";

export interface DemoCommentChoice {
  id: string;
  /* What the visitor presses. */
  label: string;
  /*
    What is actually written to the comments row — the reviewer's words, in
    full. This is the text the dispatch prompt quotes back to the model, so it
    is the only thing that decides what the agent does; the label above is a
    handle for it and nothing more.
  */
  commentText: string;
}

/*
  Three asks a person genuinely makes of a call-to-action, each aimed at a
  DIFFERENT edit so the visitor can tell the reply apart from a canned one.
  The whole point of the beat is "the agent answered what I said" — three
  choices that produced the same change would demonstrate the opposite.
*/
export const DEMO_COMMENT_CHOICES: readonly DemoCommentChoice[] = [
  {
    id: "shorter",
    label: "It's too long for a phone",
    commentText:
      "This button label is too long on a phone — can you make it shorter without losing the ask?",
  },
  {
    id: "warmer",
    label: "It reads a bit pushy",
    commentText:
      "This reads a bit pushy next to the rest of the letter. Can you make it warmer and less urgent?",
  },
  {
    id: "specific",
    label: "Say what I'm reserving",
    commentText:
      "Be more specific about what I'm reserving here — it should say it's a bag from the spring lot.",
  },
];

/** The chosen option, or undefined before one is picked. */
export function findDemoCommentChoice(choiceId: string | null): DemoCommentChoice | undefined {
  return DEMO_COMMENT_CHOICES.find((choice) => choice.id === choiceId);
}

/*
  Where the round trip has got to.

  "answered" is derived from the THREAD ITSELF — an agent-authored entry
  exists — rather than from a local flag set when the dispatch was fired. That
  entry is written by use-comment-fix-dispatch.ts only after the chat turn
  actually settles, and an errored turn never settles, so a demo that lost its
  turn says it is still waiting instead of claiming an answer that never came.
*/
export type DemoCommentPhase = "choosing" | "awaiting-agent" | "answered";

export function selectDemoCommentPhase({
  chosenChoiceId,
  threadAuthorKinds,
}: {
  chosenChoiceId: string | null;
  /* The real thread's authors, oldest first; null while the row is loading. */
  threadAuthorKinds: readonly ("user" | "agent")[] | null;
}): DemoCommentPhase {
  if (chosenChoiceId === null) {
    return "choosing";
  }
  if (threadAuthorKinds !== null && threadAuthorKinds.includes("agent")) {
    return "answered";
  }
  return "awaiting-agent";
}

/* ------------------------------------------------------------------ */
/* Gating                                                              */
/* ------------------------------------------------------------------ */

/** Everything the gates read, gathered from the live surfaces by the panel. */
export interface DemoStepProgress {
  /* Both agent turns have reported in (completed OR failed — demo-turns.ts). */
  isRunFinished: boolean;
  /* Recommendations still waiting for the visitor to accept or dismiss. */
  undecidedRecommendationCount: number;
  commentPhase: DemoCommentPhase;
}

/**
 * Has this step's work been done? Drives how prominent Next is — and, for
 * every step that has one, whether Next may be pressed at all.
 */
export function selectIsDemoStepComplete({
  stepId,
  progress,
}: {
  stepId: DemoStepId;
  progress: DemoStepProgress;
}): boolean {
  switch (stepId) {
    case "watch":
      return progress.isRunFinished;
    case "recommendations":
      /*
        DISMISSING COUNTS. The visitor is being shown that they hold the
        decision, so a demo that only let them forward after ACCEPTING would
        contradict the sentence it just made them read. Zero undecided
        recommendations is the gate; how they got to zero is theirs.
      */
      return progress.undecidedRecommendationCount === 0;
    case "comments":
      return progress.commentPhase === "answered";
  }
}

/**
 * May the visitor leave this step right now?
 *
 * False on the last step for the obvious reason (there is nowhere to go), and
 * false on an unfinished step for the one in the module header: the next step
 * would have nothing on it yet.
 */
export function selectCanAdvanceDemoStep({
  stepId,
  progress,
}: {
  stepId: DemoStepId;
  progress: DemoStepProgress;
}): boolean {
  return (
    getNextDemoStepId(stepId) !== null && selectIsDemoStepComplete({ stepId, progress })
  );
}
