"use client";

import {
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useQuery } from "convex/react";
import { BanIcon, ChevronLeftIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";
import { type EmailDocument } from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { getActiveEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";
import { useGenerationTargetDocumentId } from "../chat/agent-status";
import { useCanvasDragStore } from "../dnd/drag-drop-store";
import { ReadOnlyEmailPreview } from "../history/ReadOnlyEmailPreview";
import {
  EMPTY_FRAME_MIN_HEIGHT_CLASS,
  GenerationGlowBorder,
  GenerationWorkingOverlay,
  DraftFrameLabel,
  getIsDocEmpty,
  PREVIEW_FRAME_WIDTH_PX,
} from "./draft-frame-chrome";
import { EditorDraftFrame } from "./EditorDraftFrame";
import { useCanvasDrafts, type DraftListEntry } from "./use-canvas-drafts";

/**
 * §10.2 frames UX — the canvas drafts rendered SIDE BY SIDE, Figma-frames
 * style: top-aligned frames on a horizontally scrolling surface (no 2D
 * panning), each with a name label above it.
 *
 * Simultaneous multi-frame editing: up to {@link MAX_LIVE_EDITOR_FRAMES}
 * drafts render as FULL LIVE EDITORS (EditorDraftFrame — own store instance,
 * own presence room, dnd, selection, inline editing), the active one always
 * among them. Clicking into any editor frame lands exactly where you clicked
 * (select / edit / drag in that frame's own store, immediately) and
 * activates the frame in parallel — activation only flips styling, never
 * remounts, so the right rail and chat re-target without interrupting the
 * gesture. Drafts beyond the editor cap keep the older tiers:
 *
 * - live READ-ONLY previews (own reactive `getDocumentByKey` subscription,
 *   fit-zoom scaled, activate on click) up to
 *   {@link MAX_LIVE_SIBLING_PREVIEWS};
 * - a lightweight placeholder frame past that, still activating on click.
 *
 * Frame ROLES key off the store's connected documentId (not the URL), so
 * during the brief switch window the outgoing frame stays active-styled.
 *
 * Scale assumption (documented per the redesign spec): canvases hold a
 * handful of drafts at demo scale. The editor cap bounds the expensive tier
 * (each live editor ≈ one snapshot subscription + presence heartbeat +
 * comment/persona queries + mounted block shells; PM text editors stay lazy
 * per block); preview frames cost one subscription + one static render.
 */

/** Max simultaneous live editor frames (the active draft always holds a slot). */
const MAX_LIVE_EDITOR_FRAMES = 3;
/** Max sibling previews mounted with live subscriptions (demo scale ≤ 8 drafts/canvas). */
const MAX_LIVE_SIBLING_PREVIEWS = 8;

export function DraftFramesCanvas({
  onActivateDraft,
}: {
  onActivateDraft: (documentId: Id<"documents">) => void;
}) {
  const { drafts, activeDocumentId, activeIndex } = useCanvasDrafts();
  // The document a live AI generation streams into (drafts menu flows) —
  // only THAT frame shows the working state; clears when the turn settles.
  const generationTargetDocumentId = useGenerationTargetDocumentId();
  const frameRefsById = useRef(new Map<string, HTMLDivElement>());
  const lastScrolledDocumentIdRef = useRef<string | null>(null);

  // Clicking the frames-surface BACKGROUND (the chrome around/between the
  // frames) deselects the current block — the right rail then flips back to
  // the Blocks tab (PropertyPanelSlot's deselect rule), so adding blocks is
  // one click away. Scoped to this element only (never a document-level
  // listener): a press that starts on a frame, a panel, or a toolbar records
  // no position, and a drag released over the background moves >4px — both
  // stay inert, so drops and marquee-ish gestures never clear the selection.
  // An open inline editor commits first through its normal outside-click
  // path: the background pointerdown blurs it before this click lands.
  const backgroundPressPositionRef = useRef<{ x: number; y: number } | null>(null);
  const handleSurfacePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    backgroundPressPositionRef.current =
      event.target === event.currentTarget ? { x: event.clientX, y: event.clientY } : null;
  };
  const handleSurfaceClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const pressedAt = backgroundPressPositionRef.current;
    backgroundPressPositionRef.current = null;
    const isBackgroundClick =
      event.target === event.currentTarget &&
      pressedAt !== null &&
      Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) <= 4;
    if (!isBackgroundClick || useCanvasDragStore.getState().dragSource !== null) {
      return;
    }
    getActiveEditorStore().getState().selectBlock(null);
  };

  // Bring the newly activated frame into view. Depends on `drafts` too: on a
  // deep link the store connects BEFORE the draft-list subscription resolves,
  // so the frame element doesn't exist on the first run — the retry when the
  // list arrives positions it. The ref guards against re-scrolling (yanking a
  // manually scrolled view) on unrelated list updates like renames.
  useEffect(() => {
    if (activeDocumentId === null || activeDocumentId === lastScrolledDocumentIdRef.current) {
      return;
    }
    const frameElement = frameRefsById.current.get(activeDocumentId);
    if (frameElement === undefined) {
      return;
    }
    lastScrolledDocumentIdRef.current = activeDocumentId;
    frameElement.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }, [activeDocumentId, drafts]);

  const previousDraft = activeIndex > 0 && drafts !== undefined ? drafts[activeIndex - 1]! : null;
  const nextDraft =
    drafts !== undefined && activeIndex >= 0 && activeIndex < drafts.length - 1
      ? drafts[activeIndex + 1]!
      : null;

  // Frame tiers, precomputed in canvas order so membership stays stable as
  // you walk the row: the first MAX_LIVE_EDITOR_FRAMES drafts are live
  // editors (the active draft ALWAYS holds a slot, wherever it sits), then
  // live previews up to their cap, then placeholders.
  const liveEditorIds = new Set<string>();
  const liveSiblingPreviewIds = new Set<string>();
  if (activeDocumentId !== null) {
    liveEditorIds.add(activeDocumentId);
  }
  for (const draft of drafts ?? []) {
    if (liveEditorIds.has(draft._id)) {
      continue;
    }
    if (liveEditorIds.size < MAX_LIVE_EDITOR_FRAMES) {
      liveEditorIds.add(draft._id);
    } else if (liveSiblingPreviewIds.size < MAX_LIVE_SIBLING_PREVIEWS) {
      liveSiblingPreviewIds.add(draft._id);
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="draft-frames-canvas">
      {/* THE one scroll region (owner decision): frames grow with their
          content — no frame has an inner scroller — so this surface scrolls
          both axes: horizontally across frames, vertically through the
          tallest one. Frames stay top-aligned (items-start). */}
      {/* Chrome surface: darker-than-panels in dark mode (Figma-style canvas);
          the light value is unchanged. Email pixels inside frames come from
          document inline styles and never react to the app theme.
          data-frames-scroller: the dnd layer edge-scrolls this surface
          during palette drags (see CanvasDndContext). */}
      <div
        className="flex min-h-0 flex-1 items-start gap-20 overflow-auto bg-neutral-200/70 px-16 py-4 dark:bg-black/40"
        data-frames-scroller
        onPointerDown={handleSurfacePointerDown}
        onClick={handleSurfaceClick}
      >
        {(drafts ?? []).map((draft) => {
          const isActive = draft._id === activeDocumentId;
          const registerFrameRef = (element: HTMLDivElement | null): void => {
            if (element === null) {
              frameRefsById.current.delete(draft._id);
            } else {
              frameRefsById.current.set(draft._id, element);
            }
          };
          const isGenerationTarget = draft._id === generationTargetDocumentId;
          if (liveEditorIds.has(draft._id)) {
            return (
              <EditorDraftFrame
                key={draft._id}
                draft={draft}
                isActive={isActive}
                isGenerationTarget={isGenerationTarget}
                onActivate={() => onActivateDraft(draft._id)}
                registerFrameRef={registerFrameRef}
              />
            );
          }
          return (
            <SiblingDraftFrame
              key={draft._id}
              draft={draft}
              shouldMountLivePreview={liveSiblingPreviewIds.has(draft._id)}
              isGenerationTarget={isGenerationTarget}
              onActivate={() => onActivateDraft(draft._id)}
              registerFrameRef={registerFrameRef}
            />
          );
        })}
      </div>

      {/* Light prev/next affordances at the canvas edges (item 2 of the
          frames spec) — activate + scroll the neighbor into view. */}
      {previousDraft !== null && (
        <FrameEdgeArrow side="left" onClick={() => onActivateDraft(previousDraft._id)} />
      )}
      {nextDraft !== null && (
        <FrameEdgeArrow side="right" onClick={() => onActivateDraft(nextDraft._id)} />
      )}
    </div>
  );
}

/** A sibling frame past the editor cap: label + live read-only preview (or a placeholder). */
function SiblingDraftFrame({
  draft,
  shouldMountLivePreview,
  isGenerationTarget,
  onActivate,
  registerFrameRef,
}: {
  draft: DraftListEntry;
  shouldMountLivePreview: boolean;
  isGenerationTarget: boolean;
  onActivate: () => void;
  registerFrameRef: (element: HTMLDivElement | null) => void;
}) {
  // Reject-with-affordance (owner decision §8.3 — never activate-on-hover):
  // while a drag is live, preview frames dim/desaturate and show a static
  // hint badge (previews are never a drop target for ANY drag source).
  // Static, not hover-driven: pointer capture during a dnd gesture means
  // :hover never updates on other elements.
  const isDragActive = useCanvasDragStore((state) => state.dragSource !== null);
  return (
    <div
      ref={registerFrameRef}
      className="flex shrink-0 flex-col"
      style={{ width: PREVIEW_FRAME_WIDTH_PX }}
      data-testid="draft-frame"
      data-active="false"
      data-document-id={draft._id}
      data-generation-target={isGenerationTarget || undefined}
    >
      <DraftFrameLabel draft={draft} isActive={false} onActivate={onActivate} />
      {/* Positioning wrapper for the generation glow (switch-away-mid-
          generation: ops keep landing in the target draft even as a sibling,
          so the glow follows the frame; activation stays enabled — the frame
          is read-only here anyway). */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      {isGenerationTarget && <GenerationGlowBorder />}
      {/* div-with-button-semantics: the preview markup contains links/buttons
          (inert via pointer-events-none), which must not nest inside a real
          <button> (invalid interactive-content nesting → React dev warning). */}
      <div
        role="button"
        tabIndex={0}
        onClick={onActivate}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onActivate();
          }
        }}
        aria-label={`Activate draft ${draft.name}`}
        className={cn(
          // Full scaled content, no inner scroller — consistent with the
          // editor frames' height-follows-content behavior.
          "relative overflow-hidden rounded-lg text-left",
          "ring-1 ring-black/5 transition-[box-shadow,opacity,filter] dark:ring-white/10",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          isDragActive
            ? "cursor-not-allowed opacity-50 saturate-50"
            : "cursor-pointer hover:ring-2 hover:ring-ring/60",
        )}
        data-testid="draft-frame-preview"
        data-drop-rejected={isDragActive || undefined}
      >
        {isDragActive && (
          <div className="absolute inset-0 z-10 flex items-start justify-center pt-10">
            <span className="inline-flex items-center gap-1.5 rounded-full border bg-background/95 px-2.5 py-1 text-xs text-muted-foreground shadow-sm">
              <BanIcon className="size-3.5" aria-hidden />
              Drops go to the active draft
            </span>
          </div>
        )}
        {shouldMountLivePreview ? (
          <LiveSiblingPreview documentId={draft._id} isGenerationTarget={isGenerationTarget} />
        ) : (
          <div className="flex h-40 items-center justify-center rounded-lg border bg-background text-xs text-muted-foreground">
            Click to open this draft
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

/** Reactive read-only preview: collaborators' edits to the sibling appear live. */
function LiveSiblingPreview({
  documentId,
  isGenerationTarget,
}: {
  documentId: Id<"documents">;
  isGenerationTarget: boolean;
}) {
  const snapshot = useQuery(api.documents.getDocument, { documentId });
  if (snapshot === undefined || snapshot === null) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border bg-background">
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const isDocEmpty = getIsDocEmpty(snapshot.doc as EmailDocument);
  return (
    <div className={cn("relative flex flex-col", isDocEmpty && EMPTY_FRAME_MIN_HEIGHT_CLASS)}>
      <ReadOnlyEmailPreview doc={snapshot.doc as EmailDocument} />
      {isGenerationTarget && isDocEmpty && <GenerationWorkingOverlay />}
    </div>
  );
}

/** Subtle floating prev/next chevron at a canvas edge. */
function FrameEdgeArrow({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="icon-sm"
      onClick={onClick}
      aria-label={side === "left" ? "Previous draft" : "Next draft"}
      className={cn(
        "absolute top-1/2 z-20 -translate-y-1/2 rounded-full bg-background/85 shadow-sm backdrop-blur",
        "opacity-60 hover:opacity-100",
        side === "left" ? "left-3" : "right-3",
      )}
      data-testid={side === "left" ? "frames-arrow-prev" : "frames-arrow-next"}
    >
      {side === "left" ? <ChevronLeftIcon /> : <ChevronRightIcon />}
    </Button>
  );
}
