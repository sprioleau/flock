import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  DEMO_COMMENT_CHOICES,
  findDemoCommentChoice,
  findDemoStep,
  selectDemoCardDock,
  type DemoCommentPhase,
  type DemoStepId,
  type DemoStepProgress,
} from "@/lib/demo/demo-steps";
import {
  completeRunningTurn,
  createDemoRunState,
  startNextTurn,
  type DemoRunState,
} from "@/lib/demo/demo-turns";

/**
 * The demo card's SHAPE, checked the way this app checks components: there is
 * no DOM here (vitest.config.ts pins `environment: "node"`), so each view is
 * called as a plain function over its props and the element tree it returns is
 * walked. Layout is CSS and belongs to the browser pass; what this suite can
 * prove is everything that would be a real bug in front of a stranger:
 *
 * - the flow is STEPPED and MANUAL — one step on screen, Next inert until that
 *   step's work is done, and no step advancing itself;
 * - the card docks away from the half of the canvas it is describing;
 * - step 2 POINTS at the real recommendation cards and grows no Accept button
 *   of its own (see the component's own note for why that is architectural);
 * - the comment beat is driven by the choice the visitor picked;
 * - the run is disclosed as scripted EXACTLY ONCE, on the last step, beside
 *   the hand-off into a real session — and nowhere the visitor is still
 *   watching it, which is the owner's call about placement, not about honesty
 *   (the server logs stay blunt).
 */

// The container half reaches Convex, the editor store and the router; none of
// that has any bearing on the trees these views return.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/editor-store", () => ({
  useEditorStore: (selector: (state: unknown) => unknown) => selector({ documentId: null }),
}));
vi.mock("@/lib/demo/demo-session", () => ({
  useDemoSession: () => null,
  endDemoSession: vi.fn(),
}));
vi.mock("@/lib/demo/use-demo-run", () => ({
  useDemoRun: () => ({ runState: createDemoRunState() }),
}));
vi.mock("@/lib/demo/use-demo-comment-flow", () => ({
  useDemoCommentFlow: () => ({ phase: "choosing", chosenChoiceId: null, chooseComment: vi.fn() }),
}));
vi.mock("@/components/studio/panel-preferences", () => ({ updatePanelPreferences: vi.fn() }));
vi.mock("@/components/studio/replay/replay-handoff", () => ({
  openTimeTravelReplay: vi.fn(() => true),
}));

import {
  DemoCanvasScrim,
  DemoCommentsStep,
  DemoRecommendationsStep,
  DemoRunCardView,
  DemoWatchStep,
  type DemoRecommendationRow,
} from "./DemoRunPanel";

interface ElementWithProps extends ReactElement {
  props: Record<string, unknown>;
}

function collectElements(node: ReactNode): ElementWithProps[] {
  const found: ElementWithProps[] = [];
  const visit = (current: ReactNode): void => {
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child as ReactNode);
      }
      return;
    }
    if (!isValidElement(current)) {
      return;
    }
    const element = current as ElementWithProps;
    found.push(element);
    visit(element.props.children as ReactNode);
    /* Base UI composes a trigger by taking the real control as a `render`
       PROP rather than as a child — `<TooltipTrigger render={<Button …/>} />`
       is how every tooltipped icon button in the studio is built. A walker
       that followed children alone would report those controls as absent,
       which is worse than a miss: the test would read as "this button does
       not exist" when it is on screen and working. */
    visit(element.props.render as ReactNode);
  };
  visit(node);
  return found;
}

function findByTestId(node: ReactNode, testId: string): ElementWithProps | undefined {
  return collectElements(node).find((element) => element.props["data-testid"] === testId);
}

function collectTestIds(node: ReactNode): string[] {
  return collectElements(node)
    .map((element) => element.props["data-testid"])
    .filter((testId): testId is string => typeof testId === "string");
}

function visibleText(node: ReactNode): string {
  const parts: string[] = [];
  const visit = (current: ReactNode): void => {
    /* Numbers count: the step counter interpolates one, and a walker that
       dropped it would read "Step  of 3" and still pass. */
    if (typeof current === "string" || typeof current === "number") {
      parts.push(String(current));
      return;
    }
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child as ReactNode);
      }
      return;
    }
    if (!isValidElement(current)) {
      return;
    }
    visit((current as ElementWithProps).props.children as ReactNode);
  };
  visit(node);
  /* Collapse the seams: adjacent children are joined with a space, so an
     interpolated counter would otherwise read "Step  1  of  3". */
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

const noop = (): void => {};

/* The run states a visitor can catch step 1 in. */
const IDLE_RUN = createDemoRunState();
const FIRST_TURN_RUNNING = startNextTurn(IDLE_RUN);
const FIRST_TURN_LANDED = completeRunningTurn({ state: FIRST_TURN_RUNNING, outcome: "completed" });
const SECOND_TURN_RUNNING = startNextTurn(FIRST_TURN_LANDED);
const RUN_FINISHED = completeRunningTurn({ state: SECOND_TURN_RUNNING, outcome: "completed" });

const UNFINISHED_PROGRESS: DemoStepProgress = {
  isRunFinished: false,
  undecidedRecommendationCount: 2,
  commentPhase: "choosing",
};
const SETTLED_PROGRESS: DemoStepProgress = {
  isRunFinished: true,
  undecidedRecommendationCount: 0,
  commentPhase: "answered",
};

const RECOMMENDATIONS: readonly DemoRecommendationRow[] = [
  {
    findingId: "finding_tone",
    personaName: "Tone Police",
    personaColor: "#e11d48",
    title: "One paragraph shouts, and the rest of the email doesn't",
    status: "open",
    isActionable: true,
  },
  {
    findingId: "finding_style",
    personaName: "Styling Recommender",
    personaColor: "#0d9488",
    title: "The two buttons have drifted apart",
    status: "applied",
    isActionable: true,
  },
];

function renderCard(overrides: Partial<Parameters<typeof DemoRunCardView>[0]> = {}) {
  return DemoRunCardView({
    stepId: "watch",
    runState: RUN_FINISHED,
    recommendations: RECOMMENDATIONS,
    progress: SETTLED_PROGRESS,
    chosenChoiceId: null,
    onBack: noop,
    onNext: noop,
    onOpenRecommendations: noop,
    onChooseComment: noop,
    onRewind: noop,
    onStartOver: noop,
    onExitToRealSession: noop,
    ...overrides,
  });
}

function renderWatchStep(runState: DemoRunState) {
  return DemoWatchStep({ runState });
}

function renderRecommendationsStep(
  recommendations: readonly DemoRecommendationRow[] = RECOMMENDATIONS,
  onOpenRecommendations: () => void = noop,
) {
  return DemoRecommendationsStep({ recommendations, onOpenRecommendations });
}

function renderCommentsStep(
  overrides: Partial<Parameters<typeof DemoCommentsStep>[0]> = {},
) {
  return DemoCommentsStep({
    phase: "choosing" as DemoCommentPhase,
    chosenChoiceId: null,
    onChooseComment: noop,
    onRewind: noop,
    onExitToRealSession: noop,
    ...overrides,
  });
}

const ALL_STEP_IDS: readonly DemoStepId[] = ["watch", "recommendations", "comments"];
const STEP_COMPONENTS = [DemoWatchStep, DemoRecommendationsStep, DemoCommentsStep];

describe("the card's shape", () => {
  it("shows ONE step at a time, and says which one", () => {
    for (const [index, stepId] of ALL_STEP_IDS.entries()) {
      const tree = renderCard({ stepId });
      expect(visibleText(findByTestId(tree, "demo-step-counter"))).toContain(
        `Step ${index + 1} of 3`,
      );
      // Exactly one step body is mounted — the whole complaint about what this
      // replaced was that every beat was on screen simultaneously.
      const mountedSteps = collectElements(tree).filter((element) =>
        STEP_COMPONENTS.some((stepComponent) => stepComponent === element.type),
      );
      expect(mountedSteps).toHaveLength(1);
    }
  });

  it("docks away from the half of the canvas the step is describing", () => {
    // The rule and its derivation live in demo-steps.ts; what matters here is
    // that the card WEARS the answer rather than hard-coding a position, so a
    // step whose subject moves moves the card with it.
    for (const stepId of ALL_STEP_IDS) {
      expect(renderCard({ stepId }).props["data-demo-dock"]).toBe(
        selectDemoCardDock(findDemoStep(stepId)),
      );
    }
  });

  it("keeps an exit and a restart reachable from every step", () => {
    for (const stepId of ALL_STEP_IDS) {
      const onExitToRealSession = vi.fn();
      const onStartOver = vi.fn();
      const tree = renderCard({ stepId, onExitToRealSession, onStartOver });
      (findByTestId(tree, "demo-exit")?.props.onClick as () => void)();
      (findByTestId(tree, "demo-start-over")?.props.onClick as () => void)();
      expect(onExitToRealSession).toHaveBeenCalled();
      expect(onStartOver).toHaveBeenCalled();
    }
  });

  it("offers no way back from the first step", () => {
    expect(findByTestId(renderCard({ stepId: "watch" }), "demo-back")).toBeUndefined();
    const onBack = vi.fn();
    const tree = renderCard({ stepId: "recommendations", onBack });
    (findByTestId(tree, "demo-back")?.props.onClick as () => void)();
    expect(onBack).toHaveBeenCalled();
  });
});

describe("advancing", () => {
  it("keeps Next inert and quiet until the step's work is done", () => {
    const waiting = findByTestId(
      renderCard({ stepId: "watch", progress: UNFINISHED_PROGRESS }),
      "demo-next",
    );
    expect(waiting?.props.disabled).toBe(true);
    expect(waiting?.props.variant).toBe("outline");
  });

  it("makes Next prominent the moment the step's work IS done", () => {
    const onNext = vi.fn();
    const ready = findByTestId(
      renderCard({ stepId: "watch", progress: SETTLED_PROGRESS, onNext }),
      "demo-next",
    );
    expect(ready?.props.disabled).toBe(false);
    expect(ready?.props.variant).toBe("default");
    // And it still takes a press: nothing on this card moves on its own.
    (ready?.props.onClick as () => void)();
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("offers no Next on the last step — it ends in an exit, not another step", () => {
    expect(
      findByTestId(renderCard({ stepId: "comments", progress: SETTLED_PROGRESS }), "demo-next"),
    ).toBeUndefined();
  });
});

describe("step 1 — watching the agents work", () => {
  it("shows one agent taking its turn while the other waits", () => {
    const tree = renderWatchStep(FIRST_TURN_RUNNING);
    expect(findByTestId(tree, "demo-turn-1")?.props["data-turn-status"]).toBe("running");
    expect(findByTestId(tree, "demo-turn-2")?.props["data-turn-status"]).toBe("pending");
  });

  it("narrates the turn that is actually in flight", () => {
    expect(
      visibleText(findByTestId(renderWatchStep(SECOND_TURN_RUNNING), "demo-narration")),
    ).toContain("Styling Recommender");
  });
});

describe("step 2 — the recommendations", () => {
  it("lists every finding with what happened to it", () => {
    const tree = renderRecommendationsStep();
    const rows = collectElements(tree).filter(
      (element) => element.props["data-testid"] === "demo-recommendation",
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.props["data-finding-status"])).toEqual(["open", "applied"]);
    expect(visibleText(tree)).toContain("The two buttons have drifted apart");
  });

  it("POINTS at the real cards instead of growing an Accept button of its own", () => {
    /*
      Applying a finding means calling usePersonaAdvisors().applySuggestion,
      and that hook must mount exactly once — it hosts the persona presence
      heartbeat and the batched runner. A second Accept here would mean a
      second mount. So the only action this step offers is "show me where the
      real ones are", and the advisory boundary is stated in the visitor's own
      words rather than left implicit.
    */
    const onOpenRecommendations = vi.fn();
    const tree = renderRecommendationsStep(RECOMMENDATIONS, onOpenRecommendations);
    for (const testId of collectTestIds(tree)) {
      expect(testId).not.toMatch(/apply|accept|dismiss/i);
    }
    expect(visibleText(findByTestId(tree, "demo-advisory-note"))).toContain("Only you apply");
    (findByTestId(tree, "demo-open-recommendations")?.props.onClick as () => void)();
    expect(onOpenRecommendations).toHaveBeenCalled();
  });

  it("says so plainly when the agents posted nothing", () => {
    // Sending a visitor to an empty list without a word reads as the agents
    // having failed rather than as having found nothing.
    expect(
      findByTestId(renderRecommendationsStep([]), "demo-recommendations-empty"),
    ).toBeDefined();
  });
});

describe("step 3 — the comment round trip", () => {
  it("offers the choices, and dispatches the one the visitor picked", () => {
    const onChooseComment = vi.fn();
    const tree = renderCommentsStep({ onChooseComment });
    const [firstChoice] = DEMO_COMMENT_CHOICES;
    const choiceElement = findByTestId(tree, `demo-comment-choice-${firstChoice!.id}`);
    expect(visibleText(choiceElement)).toContain(firstChoice!.label);
    (choiceElement?.props.onClick as () => void)();
    expect(onChooseComment).toHaveBeenCalledWith(firstChoice!.id);
  });

  it("replaces the choices with the comment that was actually left", () => {
    const chosenChoiceId = DEMO_COMMENT_CHOICES[1]!.id;
    const tree = renderCommentsStep({ phase: "awaiting-agent", chosenChoiceId });
    expect(findByTestId(tree, "demo-comment-choices")).toBeUndefined();
    expect(visibleText(findByTestId(tree, "demo-comment-posted"))).toContain(
      findDemoCommentChoice(chosenChoiceId)!.commentText,
    );
  });

  it("does not claim an answer before the agent has given one", () => {
    const waiting = renderCommentsStep({
      phase: "awaiting-agent",
      chosenChoiceId: DEMO_COMMENT_CHOICES[0]!.id,
    });
    expect(visibleText(findByTestId(waiting, "demo-comment-status"))).not.toContain("answered");
    // The rewind is about "what just happened", so it waits for something to
    // have happened.
    expect(findByTestId(waiting, "demo-rewind")).toBeUndefined();

    const answered = renderCommentsStep({
      phase: "answered",
      chosenChoiceId: DEMO_COMMENT_CHOICES[0]!.id,
    });
    expect(visibleText(findByTestId(answered, "demo-comment-status"))).toContain("answered");
    expect(findByTestId(answered, "demo-rewind")).toBeDefined();
  });

  it("ends on a call to action into a real, unmocked session", () => {
    const onExitToRealSession = vi.fn();
    const cta = findByTestId(renderCommentsStep({ onExitToRealSession }), "demo-real-session-cta");
    expect(visibleText(cta)).toContain("real one");
    (cta?.props.onClick as () => void)();
    expect(onExitToRealSession).toHaveBeenCalled();
  });
});

describe("the canvas dim", () => {
  it("dims without ever taking the canvas away", () => {
    /*
      WHICH beats dim is demo-steps.ts's rule and is tested there. What can
      only be checked here is the property that makes the dim safe at all:
      /demo is a preset over the REAL product, and step 3 arms real comment
      mode on purpose, so a visitor who would rather place their own comment
      than pick a scripted one has to be able to reach the canvas THROUGH the
      scrim. Losing `pointer-events-none` would look like a tidy-up and would
      silently turn a hint into a wall.
    */
    const scrim = findByTestId(
      DemoCanvasScrim({ stepId: "recommendations", progress: UNFINISHED_PROGRESS }),
      "demo-canvas-scrim",
    );
    const scrimClassName = String(scrim?.props.className ?? "");
    expect(scrimClassName).toContain("pointer-events-none");
    /* And it passes UNDER the card it is pointing at: a card dimmed by its own
       scrim would say the opposite of what it is asking for. */
    expect(scrimClassName).toContain("z-30");
    expect(String(renderCard({ stepId: "recommendations" }).props.className)).toContain("z-40");
    /* Nothing at all on step 1 — the agents on the canvas are the show. */
    expect(DemoCanvasScrim({ stepId: "watch", progress: UNFINISHED_PROGRESS })).toBeNull();
  });
});

describe("disclosing the script", () => {
  it("discloses the scripted run once, on the last step, beside the hand-off", () => {
    const disclosure = findByTestId(renderCommentsStep(), "demo-mock-disclosure");
    expect(visibleText(disclosure)).toContain("scripted");
    expect(visibleText(disclosure)).toContain("prepared in advance");
    /* And it does not disown the half that was real, which is most of it. */
    expect(visibleText(disclosure)).toContain("real undo");
    /* Exactly once: not on the steps the visitor is still watching. */
    expect(findByTestId(renderWatchStep(RUN_FINISHED), "demo-mock-disclosure")).toBeUndefined();
    expect(
      findByTestId(renderRecommendationsStep(), "demo-mock-disclosure"),
    ).toBeUndefined();
    expect(
      collectTestIds(renderCommentsStep()).filter((testId) => testId === "demo-mock-disclosure"),
    ).toHaveLength(1);
  });

  it("never calls anything a mock on a surface a stranger is judging", () => {
    /* Owner decision 2026-08-17: the word belongs in the logs, not stamped
       across a product surface. A visitor taught to read every recommendation
       as fake learns nothing about what the agents actually say. */
    const everything = [
      ...ALL_STEP_IDS.map((stepId) => visibleText(renderCard({ stepId }))),
      visibleText(renderWatchStep(FIRST_TURN_RUNNING)),
      visibleText(renderRecommendationsStep()),
      visibleText(renderCommentsStep()),
      visibleText(renderCommentsStep({ phase: "answered", chosenChoiceId: "shorter" })),
    ].join(" ");
    expect(everything.toLowerCase()).not.toContain("mock");
  });
});
