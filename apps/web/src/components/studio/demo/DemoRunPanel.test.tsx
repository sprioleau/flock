import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  completeRunningTurn,
  createDemoRunState,
  startNextTurn,
  type DemoRunState,
} from "@/lib/demo/demo-turns";

/**
 * The demo bar's SHAPE, checked the way this app checks components: there is
 * no DOM here (vitest.config.ts pins `environment: "node"`), so the view is
 * called as a plain function over a run state and the element tree it returns
 * is walked.
 *
 * What this suite can prove is everything that would be a real bug in front of
 * a stranger:
 *
 * - the run is DISCLOSED as scripted at the exit — and NOT described as a mock
 *   anywhere a visitor is still watching it, which is the owner's call about
 *   placement rather than about honesty (the server logs stay blunt);
 * - the visitor is pointed at a recommendation only once one exists, and never
 *   at a turn that failed;
 * - the panel SURFACES findings and never applies them — the advisory boundary
 *   is the product's most defensible claim and the demo must say it;
 * - the run ends on a call to action into a real, unmocked session.
 */

// The container half reaches Convex, the editor store and the router; none of
// that has any bearing on the tree the view returns.
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
vi.mock("../personas/PersonaRecommendationsDialog", () => ({
  PersonaRecommendationsDialog: () => null,
}));
vi.mock("@/components/studio/replay/replay-handoff", () => ({
  openTimeTravelReplay: vi.fn(() => true),
}));

import { DemoRunPanelView } from "./DemoRunPanel";

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
  };
  visit(node);
  return found;
}

function findByTestId(node: ReactNode, testId: string): ElementWithProps | undefined {
  return collectElements(node).find((element) => element.props["data-testid"] === testId);
}

function visibleText(node: ReactNode): string {
  const parts: string[] = [];
  const visit = (current: ReactNode): void => {
    if (typeof current === "string") {
      parts.push(current);
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
  return parts.join(" ");
}

const noop = (): void => {};

function renderView(runState: DemoRunState, overrides: Record<string, unknown> = {}) {
  return DemoRunPanelView({
    runState,
    onShowRecommendations: noop,
    onRewind: noop,
    onStartOver: noop,
    onExitToRealSession: noop,
    ...overrides,
  });
}

/* The three states a visitor can catch the bar in. */
const IDLE_RUN = createDemoRunState();
const FIRST_TURN_RUNNING = startNextTurn(IDLE_RUN);
const FIRST_TURN_LANDED = completeRunningTurn({ state: FIRST_TURN_RUNNING, outcome: "completed" });
const SECOND_TURN_RUNNING = startNextTurn(FIRST_TURN_LANDED);
const RUN_FINISHED = completeRunningTurn({ state: SECOND_TURN_RUNNING, outcome: "completed" });

describe("disclosing the script", () => {
  it("discloses the scripted run at the exit, where the visitor is handed a real one", () => {
    const tree = renderView(RUN_FINISHED);
    const disclosure = findByTestId(tree, "demo-mock-disclosure");
    expect(visibleText(disclosure)).toContain("scripted");
    expect(visibleText(disclosure)).toContain("prepared in advance");
    /* And it does not disown the half that was real, which is most of it. */
    expect(visibleText(disclosure)).toContain("real undo");
  });

  it("never calls anything a mock while the visitor is still watching the run", () => {
    /* Owner decision 2026-08-17: the word belongs in the logs and at the exit,
       not stamped across a product surface a stranger is judging. A visitor
       taught to read every recommendation as fake learns nothing about what
       the agents actually say. */
    for (const runState of [IDLE_RUN, FIRST_TURN_RUNNING, FIRST_TURN_LANDED]) {
      expect(visibleText(renderView(runState)).toLowerCase()).not.toContain("mock");
    }
  });

  it("keeps the demo identifiable as a demo throughout", () => {
    for (const runState of [IDLE_RUN, FIRST_TURN_RUNNING, FIRST_TURN_LANDED, RUN_FINISHED]) {
      expect(findByTestId(renderView(runState), "demo-mock-badge")).toBeDefined();
    }
  });
});

describe("pacing the turns", () => {
  it("shows one agent taking its turn while the other waits", () => {
    const tree = renderView(FIRST_TURN_RUNNING);
    expect(findByTestId(tree, "demo-turn-1")?.props["data-turn-status"]).toBe("running");
    expect(findByTestId(tree, "demo-turn-2")?.props["data-turn-status"]).toBe("pending");
  });

  it("narrates the turn that is actually in flight", () => {
    expect(visibleText(findByTestId(renderView(SECOND_TURN_RUNNING), "demo-narration"))).toContain(
      "Styling Recommender",
    );
  });
});

describe("pointing at the recommendations", () => {
  it("offers nothing to look at before anything has been posted", () => {
    // Sending a visitor to an empty recommendations list is worse than saying
    // nothing: it reads as the agents having failed.
    expect(findByTestId(renderView(FIRST_TURN_RUNNING), "demo-show-recommendations")).toBeUndefined();
  });

  it("names the agent that just posted, and opens the modal filtered to it", () => {
    const onShowRecommendations = vi.fn();
    const tree = renderView(FIRST_TURN_LANDED, { onShowRecommendations });
    const handoff = findByTestId(tree, "demo-show-recommendations");
    expect(visibleText(handoff)).toContain("Tone Police");
    (handoff?.props.onClick as () => void)();
    expect(onShowRecommendations).toHaveBeenCalledWith("builtin/tone-police");
  });

  it("collapses to both agents once the run is done", () => {
    const onShowRecommendations = vi.fn();
    const tree = renderView(RUN_FINISHED, { onShowRecommendations });
    const handoff = findByTestId(tree, "demo-show-recommendations");
    expect(visibleText(handoff)).toContain("both");
    (handoff?.props.onClick as () => void)();
    expect(onShowRecommendations).toHaveBeenCalledWith(null);
  });

  it("points at nothing when the only turn to report in failed", () => {
    const failedRun = completeRunningTurn({ state: FIRST_TURN_RUNNING, outcome: "failed" });
    expect(findByTestId(renderView(failedRun), "demo-show-recommendations")).toBeUndefined();
  });

  it("surfaces recommendations rather than applying them, and says so", () => {
    const tree = renderView(RUN_FINISHED);
    // Nothing in this bar dispatches an operation — the only action it offers
    // for a finding is to go and LOOK at it. The advisory boundary is stated
    // in the visitor's words rather than left implicit.
    expect(visibleText(findByTestId(tree, "demo-advisory-note"))).toContain("Only you apply");
  });
});

describe("ending the run", () => {
  it("keeps an exit available at all times, and asks for a real session at the end", () => {
    const onExitToRealSession = vi.fn();
    expect(findByTestId(renderView(FIRST_TURN_RUNNING), "demo-exit")).toBeDefined();
    expect(findByTestId(renderView(FIRST_TURN_RUNNING), "demo-real-session-cta")).toBeUndefined();

    const finishedTree = renderView(RUN_FINISHED, { onExitToRealSession });
    const cta = findByTestId(finishedTree, "demo-real-session-cta");
    expect(visibleText(cta)).toContain("real one");
    (cta?.props.onClick as () => void)();
    expect(onExitToRealSession).toHaveBeenCalled();
  });

  it("offers the rewind and the restart only once there is something to replay", () => {
    expect(findByTestId(renderView(FIRST_TURN_RUNNING), "demo-rewind")).toBeUndefined();
    expect(findByTestId(renderView(RUN_FINISHED), "demo-rewind")).toBeDefined();

    const onStartOver = vi.fn();
    const tree = renderView(RUN_FINISHED, { onStartOver });
    (findByTestId(tree, "demo-start-over")?.props.onClick as () => void)();
    expect(onStartOver).toHaveBeenCalled();
  });
});
