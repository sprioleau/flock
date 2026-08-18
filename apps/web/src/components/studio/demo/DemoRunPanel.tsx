"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HistoryIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openTimeTravelReplay } from "@/components/studio/replay/replay-handoff";
import { selectIsDemoDocument } from "@/lib/demo/demo-preset";
import { endDemoSession, useDemoSession } from "@/lib/demo/demo-session";
import {
  selectActiveNarration,
  selectCompletedTurns,
  selectIsRunFinished,
  type DemoRunState,
  type DemoTurnState,
} from "@/lib/demo/demo-turns";
import { useDemoRun } from "@/lib/demo/use-demo-run";
import { useEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";
import { PersonaRecommendationsDialog } from "../personas/PersonaRecommendationsDialog";

/**
 * The /demo narration bar: a card docked over the bottom of the canvas that
 * says what the two agents are doing, hands the visitor to what they produced,
 * and ends by asking them to go make a real one.
 *
 * FOUR THINGS IT HAS TO DO, and nothing else:
 *
 * 1. SAY THAT THE RUN IS SCRIPTED. The banner is permanent, not a dismissible
 *    toast. A scripted demo labelled as one is honest; the same demo unlabelled
 *    is a claim about live inference that this route does not make.
 * 2. PACE THE TURNS VISIBLY. The chips show one agent taking its turn while
 *    the other waits, so the sequencing reads as a decision rather than as
 *    latency (lib/demo/demo-turns.ts for why the boundary is the scheduler).
 * 3. POINT AT THE RECOMMENDATIONS. A finding card also appears in the chat
 *    panel on its own, but a stranger is looking at the canvas when it lands.
 *    The hand-off is the payoff, so the panel makes it a button.
 * 4. END SOMEWHERE REAL. The last beat is not "you have finished the demo",
 *    it is a real, unmocked session — with the visitor's prior settings put
 *    back on the way out.
 *
 * Renders nothing unless the connected document IS the demo's scratch document
 * (demo-preset.ts §selectIsDemoDocument), so a stale session record can never
 * put this bar over somebody's real draft.
 */
export function DemoRunPanel() {
  const router = useRouter();
  const session = useDemoSession();
  const documentId = useEditorStore((state) => state.documentId);
  const isDemoDocument = selectIsDemoDocument({ session, documentId });
  /* Passing null keeps the sequencer dormant on every other document. */
  const { runState } = useDemoRun({ documentId: isDemoDocument ? documentId : null });
  const [recommendationsSlug, setRecommendationsSlug] = useState<string | null>(null);
  const [isRecommendationsOpen, setIsRecommendationsOpen] = useState(false);

  if (!isDemoDocument) {
    return null;
  }

  return (
    <>
      <DemoRunPanelView
        runState={runState}
        onShowRecommendations={(personaSlug) => {
          setRecommendationsSlug(personaSlug);
          setIsRecommendationsOpen(true);
        }}
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
      <PersonaRecommendationsDialog
        isOpen={isRecommendationsOpen}
        onOpenChange={setIsRecommendationsOpen}
        initialPersonaSlug={recommendationsSlug}
      />
    </>
  );
}

export interface DemoRunPanelViewProps {
  runState: DemoRunState;
  /** Open the recommendations modal, filtered to one persona or (null) to all. */
  onShowRecommendations: (personaSlug: string | null) => void;
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

/**
 * The panel as a pure function of the run state — every decision this surface
 * makes is testable without a DOM (vitest pins `environment: "node"`).
 */
export function DemoRunPanelView({
  runState,
  onShowRecommendations,
  onRewind,
  onStartOver,
  onExitToRealSession,
}: DemoRunPanelViewProps) {
  const completedTurns = selectCompletedTurns(runState);
  const latestCompletedTurn = completedTurns[completedTurns.length - 1];
  const isFinished = selectIsRunFinished(runState);
  const narration = selectActiveNarration(runState);

  return (
    <div
      className="absolute inset-x-4 bottom-4 z-40 mx-auto flex w-full max-w-2xl flex-col gap-2 rounded-xl border bg-background/95 p-3 shadow-lg backdrop-blur"
      data-testid="demo-run-panel"
    >
      <div className="flex items-center gap-2">
        <span
          className="flex shrink-0 items-center gap-1 rounded-full bg-foreground px-2 py-0.5 text-[10px] font-medium text-background"
          data-testid="demo-mock-badge"
        >
          <SparklesIcon className="size-3" />
          Scripted demo
        </span>
        {/* The disclosure is deliberately specific about WHERE the script
            stops: a vague "this is a demo" would leave a visitor unsure
            whether any of it was real, and almost all of it is. */}
        <p className="min-w-0 flex-1 text-[11px] text-muted-foreground" data-testid="demo-mock-disclosure">
          Both agent turns below are mocked — no model is called. Everything after the
          model call is the real product: real validation, real database rows, real
          presence, real undo.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0 text-muted-foreground"
          onClick={onExitToRealSession}
          data-testid="demo-exit"
        >
          Exit
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {runState.turns.map((turn, index) => (
          <span
            key={turn.script.personaSlug}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
              turn.status === "running" && "border-foreground/30 font-medium",
              turn.status === "pending" && "text-muted-foreground opacity-70",
            )}
            data-testid={`demo-turn-${index + 1}`}
            data-turn-status={turn.status}
          >
            <span
              className={cn("size-2 shrink-0 rounded-full", turn.status === "running" && "animate-pulse")}
              style={{ backgroundColor: turn.script.personaColor }}
              aria-hidden
            />
            {turn.script.personaName}
            <span className="text-muted-foreground">· {TURN_STATUS_LABELS[turn.status]}</span>
          </span>
        ))}
      </div>

      {narration !== null && (
        <p className="text-xs" data-testid="demo-narration">
          {narration}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* The hand-off. Named after the agent that just posted while the run
            is still going, because a stranger needs to connect the card to the
            avatar that was moving; collapsed to "both" at the end. */}
        {latestCompletedTurn !== undefined && (
          <Button
            type="button"
            size="xs"
            onClick={() =>
              onShowRecommendations(isFinished ? null : latestCompletedTurn.script.personaSlug)
            }
            data-testid="demo-show-recommendations"
          >
            {isFinished
              ? "See both recommendations"
              : `See what ${latestCompletedTurn.script.personaName} found`}
          </Button>
        )}
        {isFinished && (
          <>
            {/* Not a simulation of a rewind: the op log stores an exact
                inverse and provenance for every change, so replay reconstructs
                the document the visitor just edited, authored by name. */}
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={onRewind}
              data-testid="demo-rewind"
            >
              <HistoryIcon className="size-3" />
              Rewind what just happened
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={onStartOver}
              data-testid="demo-start-over"
            >
              Start over
            </Button>
          </>
        )}
        <span className="min-w-0 flex-1" />
        {/* The advisory boundary, stated as a feature rather than a caveat —
            it is the most defensible claim the product makes. */}
        <p className="text-[11px] text-muted-foreground" data-testid="demo-advisory-note">
          Agents recommend. Only you apply.
        </p>
      </div>

      {isFinished && (
        <Button
          type="button"
          size="sm"
          className="w-full"
          onClick={onExitToRealSession}
          data-testid="demo-real-session-cta"
        >
          You&apos;ve seen the scripted version — now start a real one
        </Button>
      )}
    </div>
  );
}
