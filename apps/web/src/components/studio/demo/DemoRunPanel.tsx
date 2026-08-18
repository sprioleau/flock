"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { HistoryIcon, XIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { updatePanelPreferences } from "@/components/studio/panel-preferences";
import { openTimeTravelReplay } from "@/components/studio/replay/replay-handoff";
import { selectIsDemoDocument } from "@/lib/demo/demo-preset";
import { endDemoSession, useDemoSession } from "@/lib/demo/demo-session";
import {
  DEMO_COMMENT_CHOICES,
  DEMO_STEP_COUNT,
  FIRST_DEMO_STEP_ID,
  findDemoCommentChoice,
  findDemoStep,
  getDemoStepNumber,
  getNextDemoStepId,
  getPreviousDemoStepId,
  selectCanAdvanceDemoStep,
  selectDemoCardDock,
  selectIsDemoAwaitingVisitor,
  selectIsDemoStepComplete,
  type DemoCardDock,
  type DemoCommentPhase,
  type DemoStepId,
  type DemoStepProgress,
} from "@/lib/demo/demo-steps";
import {
  selectActiveNarration,
  selectIsRunFinished,
  type DemoRunState,
  type DemoTurnState,
} from "@/lib/demo/demo-turns";
import { useDemoCommentFlow } from "@/lib/demo/use-demo-comment-flow";
import { useDemoRun } from "@/lib/demo/use-demo-run";
import { useEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";
import { getRecommendationOutcome } from "../personas/recommendation-outcome";

/**
 * The /demo card: a PORTRAIT card docked beside the canvas that walks a
 * visitor through three steps — watch the agents work, decide what to keep,
 * then answer one back — and ends by handing them a real, unmocked session.
 *
 * WHAT THIS REPLACED, AND WHY (owner, verbatim): "way too crowded looking…
 * way too wide, and all of the information is shoved into it. Make this more
 * like a card that's more in a portrait orientation. Maybe make it more of a
 * stepped flow as well." What was here before was one landscape strip carrying
 * a badge, a status line, two persona chips, four controls and a full-width
 * call to action simultaneously — every beat of the demo on screen at once,
 * which is the same as none of them being on screen.
 *
 * THE FOUR THINGS IT STILL HAS TO DO are unchanged; they are now spread over
 * three steps instead of stacked in one strip:
 *
 * 1. SAY THAT THE RUN IS SCRIPTED — ONCE, AT THE EXIT. A scripted demo
 *    labelled as one is honest; the same demo unlabelled is a claim about live
 *    inference that this route does not make. But the label used to sit across
 *    the top of the bar and inside the recommendations themselves, which
 *    taught a stranger to discount everything on screen — including the
 *    product's actual judgement. So the disclosure lives on the LAST STEP and
 *    nowhere else, beside the hand-off into a real session, where "that was
 *    scripted, this next one is not" is the sentence that matters. Nothing
 *    about what actually RUNS changed: the mock is forced server-side off the
 *    document row, and the server logs say so.
 * 2. PACE THE TURNS VISIBLY (step 1). One agent takes its turn while the other
 *    waits, so the sequencing reads as a decision rather than as latency
 *    (lib/demo/demo-turns.ts for why the boundary is the scheduler).
 * 3. HAND OFF TO THE RECOMMENDATIONS (step 2) — see the note on
 *    `onOpenRecommendations` for why this card POINTS at the real cards rather
 *    than growing its own Accept button.
 * 4. END SOMEWHERE REAL (step 3). The last beat is a comment the visitor
 *    leaves and an agent answers — the product's actual review loop — followed
 *    by a real, unmocked session with their prior settings put back.
 *
 * MANUALLY ADVANCED, AND NO CLOCK ANYWHERE (owner decision). Nothing on this
 * card moves on its own: `stepId` changes only in `onNext`/`onBack`, both of
 * which are click handlers. The gating rules live in lib/demo/demo-steps.ts
 * and take no time input at all, which is the same discipline demo-turns.ts
 * holds for the agent turns themselves.
 *
 * Renders nothing unless the connected document IS the demo's scratch document
 * (demo-preset.ts §selectIsDemoDocument), so a stale session record can never
 * put this card over somebody's real draft.
 */
export function DemoRunPanel() {
  const router = useRouter();
  const session = useDemoSession();
  const documentId = useEditorStore((state) => state.documentId);
  const isDemoDocument = selectIsDemoDocument({ session, documentId });
  /* Passing null keeps the sequencer dormant on every other document. */
  const { runState } = useDemoRun({ documentId: isDemoDocument ? documentId : null });
  const [stepId, setStepId] = useState<DemoStepId>(FIRST_DEMO_STEP_ID);

  const commentFlow = useDemoCommentFlow({
    documentId: isDemoDocument ? documentId : null,
    isStepActive: isDemoDocument && stepId === "comments",
  });

  /*
    The recommendations, read from the SAME reactive feed the recommendations
    modal reads. Read-only here on purpose — see `onOpenRecommendations`.
  */
  const findingRows = useQuery(
    api.personaFindings.listFindingsForDocument,
    isDemoDocument && documentId !== null ? { documentId } : "skip",
  );

  /*
    Step 2's preparation, in the spirit of lib/tour/tour-intents.ts: the
    Accept/Dismiss controls this step is about live INSIDE the chat panel, and
    panel-preferences.ts defaults it collapsed to a 48px rail. A card telling a
    stranger to accept a recommendation while the recommendation is inside a
    closed rail is a card pointing at nothing. This writes through the user's
    real preference — the exact call the panel's own expand button makes.
  */
  useEffect(() => {
    if (stepId === "recommendations") {
      updatePanelPreferences({ isChatPanelExpanded: true });
    }
  }, [stepId]);

  if (!isDemoDocument) {
    return null;
  }

  /* Oldest first, so the two findings read in the order their turns ran. */
  const recommendations: DemoRecommendationRow[] = [...(findingRows ?? [])]
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .map((row) => ({
      findingId: row.findingId,
      personaName: row.personaName,
      personaColor: row.personaColor,
      title: row.title,
      status: row.status,
      isActionable: row.isActionable,
    }));

  const progress: DemoStepProgress = {
    isRunFinished: selectIsRunFinished(runState),
    /*
      `undefined` means the reactive feed has not answered yet. Counting that
      as "nothing left to decide" would open step 2's gate for the beat before
      the findings arrive, so an unanswered feed counts as one outstanding
      decision.
    */
    undecidedRecommendationCount:
      findingRows === undefined
        ? 1
        : recommendations.filter((row) => row.status === "open").length,
    commentPhase: commentFlow.phase,
  };

  return (
    <>
      <DemoCanvasScrim stepId={stepId} progress={progress} />
      <DemoRunCardView
        stepId={stepId}
        runState={runState}
        recommendations={recommendations}
        progress={progress}
        chosenChoiceId={commentFlow.chosenChoiceId}
        onBack={() => {
          const previousStepId = getPreviousDemoStepId(stepId);
          if (previousStepId !== null) {
            setStepId(previousStepId);
          }
        }}
        onNext={() => {
          const nextStepId = getNextDemoStepId(stepId);
          if (nextStepId !== null) {
            setStepId(nextStepId);
          }
        }}
        onOpenRecommendations={() => {
          updatePanelPreferences({ isChatPanelExpanded: true });
        }}
        onChooseComment={commentFlow.chooseComment}
        onRewind={() => {
          openTimeTravelReplay();
        }}
        onStartOver={() => {
          /* A restart provisions a FRESH document rather than re-running the
             turns on this one. Re-running would post the same findings the
             persistence layer already de-duplicates by patternKey, so the
             second run would visibly do nothing — and "replayable" has to mean
             the demo starts clean, not that it looks broken the second time. */
          router.push("/demo");
        }}
        onExitToRealSession={() => {
          endDemoSession();
          router.push("/studio");
        }}
      />
    </>
  );
}

/**
 * The canvas dim, on for exactly the beats the demo is waiting on the VISITOR
 * (lib/demo/demo-steps.ts §selectIsDemoAwaitingVisitor holds the rule and the
 * reason step 1 is exempt — the agents moving on the canvas is the show, so it
 * is never dimmed).
 *
 * IT DIMS; IT DOES NOT BLOCK. `pointer-events-none` is the whole design and it
 * is not an oversight to be tidied up later: /demo is a PRESET OVER THE REAL
 * PRODUCT, not a second app, and step 3 deliberately arms real comment mode so
 * a visitor who would rather place their OWN comment than pick a scripted one
 * simply can (use-demo-comment-flow.ts says exactly that). A scrim that ate
 * clicks would take the product away at the precise moment the demo is showing
 * it off — the same "demo, not hostage situation" rule the exit button on this
 * card is here for. This is a HINT about where to look, and hints do not lock
 * doors.
 *
 * WHAT IT COVERS, and what it must never cover. It is mounted inside <main>
 * beside the card (StudioShell), so the chat panel and the property panel —
 * both siblings of <main> — are outside it by construction. That matters most
 * on step 2, where the Accept/Dismiss buttons the visitor has to press live in
 * the chat panel: dimming those would point at the wrong surface. `top-12`
 * clears the toolbar's own `h-12` header for the same reason.
 *
 * Z-INDEX. The card is `z-40`; this is `z-30`, so the scrim always passes
 * UNDER the card it is pointing at — a card dimmed by its own scrim would be
 * the exact opposite of the instruction it is giving. It still clears the
 * canvas chrome underneath it (the frames surface tops out at `z-20`).
 *
 * The fade is CSS on mount and nothing else: no timer, no interval, no
 * transition driven from JS. The demo sequencer is clock-free and every
 * surface hanging off it stays that way.
 */
export function DemoCanvasScrim({
  stepId,
  progress,
}: {
  stepId: DemoStepId;
  progress: DemoStepProgress;
}) {
  if (!selectIsDemoAwaitingVisitor({ stepId, progress })) {
    return null;
  }
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 top-12 bottom-0 z-30",
        /* Half the tour's `bg-black/45`, deliberately. That one is a MODAL
           dim behind a surface that does take the screen; this one swallows
           nothing, so it only has to be enough to make the card read as the
           foreground. */
        "bg-black/20 duration-200 animate-in fade-in-0",
      )}
      data-testid="demo-canvas-scrim"
    />
  );
}

/** One recommendation, reduced to what this card shows about it. */
export interface DemoRecommendationRow {
  findingId: string;
  personaName: string;
  personaColor: string;
  title: string;
  status: "open" | "applied" | "dismissed";
  isActionable: boolean;
}

export interface DemoRunCardViewProps {
  stepId: DemoStepId;
  runState: DemoRunState;
  recommendations: readonly DemoRecommendationRow[];
  progress: DemoStepProgress;
  chosenChoiceId: string | null;
  onBack: () => void;
  onNext: () => void;
  /** Reveal the chat panel, where the real Accept/Dismiss controls live. */
  onOpenRecommendations: () => void;
  onChooseComment: (choiceId: string) => void;
  onRewind: () => void;
  onStartOver: () => void;
  onExitToRealSession: () => void;
}

/** Status wording, in the visitor's terms rather than the state machine's. */
const TURN_STATUS_LABELS: Record<DemoTurnState["status"], string> = {
  pending: "waiting its turn",
  running: "reviewing now",
  completed: "posted",
  failed: "didn't land",
};

/*
  WHERE THE CARD SITS, per step.

  The rule and its rationale are in demo-steps.ts (`selectDemoCardDock`): the
  card takes the half of the canvas its own step is NOT talking about, because
  a card sitting on the block it is describing is worse than no card at all.
  `upper-right` clears the 48px toolbar; both keep to the right, because the
  chat panel — and the recommendation cards inside it — are on the left.

  Positioned inside <main> rather than the viewport (StudioShell mounts it
  there deliberately): a viewport-fixed card would cover either the chat panel
  or the property panel, neither of which it is ever describing.
*/
const DOCK_CLASS_NAMES: Record<DemoCardDock, string> = {
  "upper-right": "top-16 right-4",
  "lower-right": "bottom-4 right-4",
};

/**
 * The card as a pure function of where the visitor is — every decision this
 * surface makes is testable without a DOM (vitest pins `environment: "node"`).
 */
export function DemoRunCardView({
  stepId,
  runState,
  recommendations,
  progress,
  chosenChoiceId,
  onBack,
  onNext,
  onOpenRecommendations,
  onChooseComment,
  onRewind,
  onStartOver,
  onExitToRealSession,
}: DemoRunCardViewProps) {
  const step = findDemoStep(stepId);
  const stepNumber = getDemoStepNumber(stepId);
  const hasPreviousStep = getPreviousDemoStepId(stepId) !== null;
  const hasNextStep = getNextDemoStepId(stepId) !== null;
  const isStepComplete = selectIsDemoStepComplete({ stepId, progress });
  const canAdvance = selectCanAdvanceDemoStep({ stepId, progress });

  return (
    <div
      className={cn(
        "absolute z-40 flex w-[22rem] max-w-[calc(100%-2rem)] flex-col gap-3",
        "max-h-[calc(100%-5.5rem)] rounded-xl border bg-background/95 p-4 shadow-lg backdrop-blur",
        DOCK_CLASS_NAMES[selectDemoCardDock(step)],
      )}
      data-testid="demo-run-panel"
      data-demo-step={stepId}
      data-demo-dock={selectDemoCardDock(step)}
    >
      <div className="flex shrink-0 items-center justify-end">
        {/* Reachable from every step — the difference between a demo and a
            hostage situation (the tour's §3.3 rule, same reasoning).

            An icon needs an accessible name and a visible one, so it carries
            both: `aria-label` for assistive tech and the hit test, a tooltip
            for the sighted visitor who wants to know before pressing. Both
            say "Exit the demo" rather than "Close", because the top-right ×
            of a card normally just dismisses the card — this one ends the run
            and hands the visitor to a real studio, and a control that does
            more than its glyph implies has to say so. */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground"
                  aria-label="Exit the demo"
                  onClick={onExitToRealSession}
                  data-testid="demo-exit"
                >
                  <XIcon />
                </Button>
              }
            />
            <TooltipContent>Exit the demo</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* The body scrolls, never the card: the footer must stay put, because
          it is the only way forward. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <div className="flex flex-col gap-1.5">
          <p className="font-heading text-sm font-semibold" data-testid="demo-step-title">
            {step.title}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">{step.body}</p>
        </div>

        {stepId === "watch" && <DemoWatchStep runState={runState} />}
        {stepId === "recommendations" && (
          <DemoRecommendationsStep
            recommendations={recommendations}
            onOpenRecommendations={onOpenRecommendations}
          />
        )}
        {stepId === "comments" && (
          <DemoCommentsStep
            phase={progress.commentPhase}
            chosenChoiceId={chosenChoiceId}
            onChooseComment={onChooseComment}
            onRewind={onRewind}
            onExitToRealSession={onExitToRealSession}
          />
        )}
      </div>

      {/*
        The footer, in two groups either side of a real gap — the shape that
        fixed exactly this bug on the tour card (StudioTour.tsx), applied here
        before it could happen again:

        - WORST CASE is step 2, the only step carrying all four controls:
          "Step 2 of 3" + Start over on the left, Back + Next on the right.
          Inside a 22rem card's 320px content box those measure roughly 145px
          and 120px, so the 16px inter-group gap has real slack rather than a
          squeeze.
        - The counter is `whitespace-nowrap` and `shrink-0`, so it cannot wrap
          however narrow things get; `tabular-nums` keeps it from twitching as
          the number changes. Buttons already carry `whitespace-nowrap` and
          `shrink-0` from the base variant, so nothing in this row can reflow.
        - The grouping is by ROLE, not by convenience: where am I / let me out
          on the left, where am I going on the right. The gap BETWEEN the
          groups is wider than the gap within them, which is what stops "Start
          over" from reading as part of the navigation cluster it is not.
      */}
      <div className="mt-0.5 flex shrink-0 items-center justify-between gap-4 border-t border-foreground/10 pt-3">
        <div className="flex shrink-0 items-center gap-2">
          <span
            className="shrink-0 text-[11px] whitespace-nowrap tabular-nums text-muted-foreground"
            data-testid="demo-step-counter"
          >
            Step {stepNumber} of {DEMO_STEP_COUNT}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={onStartOver}
            data-testid="demo-start-over"
          >
            Start over
          </Button>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {hasPreviousStep && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onBack}
              data-testid="demo-back"
            >
              Back
            </Button>
          )}
          {hasNextStep && (
            /* Prominent the moment the step's work is done, and inert before
               it: the next step would otherwise open on an empty list, which
               reads as the agents having failed rather than as "not yet". */
            <Button
              type="button"
              size="sm"
              variant={isStepComplete ? "default" : "outline"}
              disabled={!canAdvance}
              onClick={onNext}
              data-testid="demo-next"
            >
              Next
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Step 1: the two agents, one taking its turn while the other waits. */
export function DemoWatchStep({ runState }: { runState: DemoRunState }) {
  const narration = selectActiveNarration(runState);
  return (
    <>
      <div className="flex flex-col gap-1.5" data-testid="demo-turn-list">
        {runState.turns.map((turn, index) => (
          <span
            key={turn.script.personaSlug}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px]",
              turn.status === "running" && "border-foreground/30 font-medium",
              turn.status === "pending" && "text-muted-foreground opacity-70",
            )}
            data-testid={`demo-turn-${index + 1}`}
            data-turn-status={turn.status}
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                turn.status === "running" && "animate-pulse",
              )}
              style={{ backgroundColor: turn.script.personaColor }}
              aria-hidden
            />
            <span className="min-w-0 truncate">{turn.script.personaName}</span>
            <span className="ml-auto shrink-0 whitespace-nowrap text-muted-foreground">
              {TURN_STATUS_LABELS[turn.status]}
            </span>
          </span>
        ))}
      </div>
      {narration !== null && (
        <p className="text-xs" data-testid="demo-narration">
          {narration}
        </p>
      )}
    </>
  );
}

/**
 * Step 2: what the agents found, and what happened to each.
 *
 * THIS CARD POINTS; IT DOES NOT HOST. The Accept/Dismiss controls stay on the
 * existing suggestion cards in the chat panel, and this step lists the
 * findings with their live status beside them. Three reasons, in the order
 * they decided it:
 *
 * 1. Applying a finding means calling `usePersonaAdvisors().applySuggestion`,
 *    and that hook must MOUNT EXACTLY ONCE — it hosts the persona presence
 *    heartbeat and the batched runner (ChatPanel owns it for precisely this
 *    reason). A second mount inside the demo card would double the heartbeat
 *    and give the demo its own runner. That is not a styling preference, it is
 *    the reason a second Accept button cannot exist.
 * 2. The real cards already carry everything the demo would have to rebuild:
 *    one-press apply of pre-validated ops, `persona:<slug>` op-log provenance,
 *    the post-apply "Applied — Revert" state, and cross-tab convergence.
 * 3. A visitor who accepts a recommendation ON THE PRODUCT'S OWN SURFACE has
 *    used the product. A visitor who accepts it on a demo widget has used the
 *    demo. The whole route exists to make the first thing happen.
 *
 * The statuses below come from the same reactive feed the recommendations
 * modal reads, so accepting or dismissing anywhere updates this list live.
 */
export function DemoRecommendationsStep({
  recommendations,
  onOpenRecommendations,
}: {
  recommendations: readonly DemoRecommendationRow[];
  onOpenRecommendations: () => void;
}) {
  return (
    <>
      {recommendations.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="demo-recommendations-empty">
          Nothing posted for this email yet.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5" data-testid="demo-recommendation-list">
          {recommendations.map((row) => {
            const outcome = getRecommendationOutcome(row);
            return (
              <div
                key={row.findingId}
                className="flex items-start gap-2 rounded-lg border px-2.5 py-1.5"
                data-testid="demo-recommendation"
                data-finding-status={row.status}
              >
                <span
                  className="mt-1 size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: row.personaColor }}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium">{row.title}</p>
                  <p className="text-[10px] text-muted-foreground">{row.personaName}</p>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-1.5 py-px text-[10px] whitespace-nowrap",
                    outcome.className,
                  )}
                  data-testid="demo-recommendation-status"
                >
                  {outcome.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {/* The advisory boundary, stated as a feature rather than a caveat — it
          is the most defensible claim the product makes. */}
      <p className="text-[11px] text-muted-foreground" data-testid="demo-advisory-note">
        Agents recommend. Only you apply.
      </p>
      {/* The panel is expanded on arrival at this step; this rescues the
          visitor who collapsed it again. */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onOpenRecommendations}
        data-testid="demo-open-recommendations"
      >
        Show the agents&apos; cards
      </Button>
    </>
  );
}

/**
 * Step 3: the comment round trip, staged.
 *
 * The visitor picks a sentence; everything after that is the real thing (see
 * lib/demo/use-demo-comment-flow.ts). This card only shows what they picked
 * and where the round trip has got to.
 */
export function DemoCommentsStep({
  phase,
  chosenChoiceId,
  onChooseComment,
  onRewind,
  onExitToRealSession,
}: {
  phase: DemoCommentPhase;
  chosenChoiceId: string | null;
  onChooseComment: (choiceId: string) => void;
  onRewind: () => void;
  onExitToRealSession: () => void;
}) {
  const chosenChoice = findDemoCommentChoice(chosenChoiceId);
  return (
    <>
      {phase === "choosing" ? (
        <div className="flex flex-col gap-1.5" data-testid="demo-comment-choices">
          {DEMO_COMMENT_CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              onClick={() => onChooseComment(choice.id)}
              className="cursor-pointer rounded-lg border px-2.5 py-2 text-left hover:bg-muted"
              data-testid={`demo-comment-choice-${choice.id}`}
            >
              <span className="block text-[11px] font-medium">{choice.label}</span>
              <span className="mt-0.5 block text-[10px] leading-relaxed text-muted-foreground">
                &ldquo;{choice.commentText}&rdquo;
              </span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="rounded-lg border px-2.5 py-2" data-testid="demo-comment-posted">
            <p className="text-[10px] text-muted-foreground">Your comment, on the hero button</p>
            <p className="mt-0.5 text-[11px] leading-relaxed">
              &ldquo;{chosenChoice?.commentText}&rdquo;
            </p>
          </div>
          <p className="text-xs" data-testid="demo-comment-status">
            {phase === "answered"
              ? "The agent answered in the thread and changed the button. Open the pin on the canvas to read the reply."
              : "The agent is on it — watch the chat panel, then the button on the canvas."}
          </p>
        </>
      )}

      {phase === "answered" && (
        /* Not a simulation of a rewind: the op log stores an exact inverse and
           provenance for every change, so replay reconstructs the document the
           visitor just edited, authored by name. */
        <Button type="button" variant="outline" size="sm" onClick={onRewind} data-testid="demo-rewind">
          <HistoryIcon className="size-3" />
          Rewind what just happened
        </Button>
      )}

      {/*
        THE DISCLOSURE LIVES HERE AND NOWHERE ELSE (owner decision,
        2026-08-17). It used to be stamped across the top of this surface and
        inside the findings themselves, which taught a stranger to read every
        recommendation as fake — including the ones that are the product's
        actual judgement. Honesty is not negotiable, but its PLACEMENT is: it
        belongs at the moment the visitor is handed into a real, unmocked
        session, where "that was scripted, this next one is not" is the
        sentence that matters. Server-side logs and telemetry stay blunt about
        the mock regardless; this is about what the visitor is told, never
        about what actually ran.
      */}
      <p className="text-[11px] text-muted-foreground" data-testid="demo-mock-disclosure">
        That run was scripted: both reviews were prepared in advance rather than generated
        just now. Everything around them was the real product — real validation, real
        database rows, real presence, real undo. The next one won&apos;t be scripted.
      </p>
      {/* The contrast this hand-off exists to draw — that one was scripted,
          this next one is not — lives in the disclosure above, NOT in the
          label. A button carrying the whole sentence was wider than a 22rem
          card and had to wrap to two lines to avoid being clipped; prose is
          better at prose. What is left here is the press itself, short enough
          to read as one. */}
      <Button
        type="button"
        size="sm"
        className="w-full"
        onClick={onExitToRealSession}
        data-testid="demo-real-session-cta"
      >
        Start a real one
      </Button>
    </>
  );
}
