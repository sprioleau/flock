"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useConvex, useQuery } from "convex/react";
import {
  BanIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Loader2Icon,
  PlusIcon,
} from "lucide-react";
import { type EmailDocument } from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getActiveEditorStore } from "@/lib/editor-store";
import { getOrCreateSessionId } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useGenerationTargetDocumentId } from "../chat/agent-status";
import { useCanvasDragStore } from "../dnd/drag-drop-store";
import { ReadOnlyEmailPreview } from "../history/ReadOnlyEmailPreview";
import {
  EMPTY_FRAME_MIN_HEIGHT_CLASS,
  GenerationGlowBorder,
  GenerationWorkingOverlay,
  getDraftFrameSelectionClassName,
  DraftFrameLabel,
  getIsDocEmpty,
  PREVIEW_FRAME_WIDTH_PX,
} from "./draft-frame-chrome";
import {
  calculateFitCanvasViewport,
  CanvasZoomControls,
  DEFAULT_CANVAS_ZOOM_PERCENT,
  getFocalPointPreservingScrollTarget,
  getGroupFocusScrollTarget,
  getNextZoomPercent,
} from "./canvas-zoom";
import { DraftGroupMoveDraftMenu } from "./DraftGroupMoveDraftMenu";
import { DraftGroupSection } from "./DraftGroupSection";
import {
  UNGROUPED_DRAFT_GROUP_KEY,
  buildDraftGroupLayout,
  getReorderedDraftGroupIds,
} from "./draft-group-layout";
import { computeNextDraftName } from "./draft-naming";
import { EditorDraftFrame } from "./EditorDraftFrame";
import {
  useCanvasDrafts,
  type DraftGroupListEntry,
  type DraftListEntry,
} from "./use-canvas-drafts";

/*
  Draft groups form vertical rows, while each group's drafts remain
  horizontal. One canvas scroller owns both axes and one scene-level zoom
  keeps group chrome, draft chrome, and email content spatially coherent.

  Simultaneous multi-frame editing remains bounded: the active draft and up
  to two siblings are full live editors; additional siblings become reactive
  previews and then lightweight placeholders. Activation changes styling and
  routing without remounting the active editor.
*/

/*
  Max simultaneous live editor frames (the active draft always holds a slot).
*/
const MAX_LIVE_EDITOR_FRAMES = 3;
/*
  Max sibling previews mounted with live subscriptions (demo scale ≤ 8 drafts/canvas).
*/
const MAX_LIVE_SIBLING_PREVIEWS = 8;

/*
  Canvas zoom is the actual scale applied to the natural email layout. The
  established 70% presentation remains the initial view while the complete
  frame chrome zooms with it.
*/
const CANVAS_FRAME_GAP_PX = 64;
const CANVAS_PAN_THRESHOLD_PX = 4;
const CANVAS_KEYBOARD_PAN_PX = 96;

interface CanvasPanGesture {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  startScrollTop: number;
  hasMoved: boolean;
}

function getIsInteractiveCanvasTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "button, a, input, textarea, select, [contenteditable='true'], [role='menuitem'], [data-testid='draft-frame']",
    ) !== null
  );
}

function getIsCanvasPanRegion(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-canvas-pan-region]") !== null;
}

export function DraftFramesCanvas({
  onActivateDraft,
}: {
  onActivateDraft: (documentId: Id<"documents">) => void;
}) {
  const convexClient = useConvex();
  const { drafts, draftGroups, activeDocumentId, activeIndex, canvasId } = useCanvasDrafts();
  /*
    The document a live AI generation streams into (drafts menu flows) —
    only THAT frame shows the working state; clears when the turn settles.
  */
  const generationTargetDocumentId = useGenerationTargetDocumentId();
  const frameRefsById = useRef(new Map<string, HTMLDivElement>());
  const groupRefsByKey = useRef(new Map<string, HTMLElement>());
  const framesScrollerRef = useRef<HTMLDivElement>(null);
  const canvasSceneRef = useRef<HTMLDivElement>(null);
  const lastScrolledDocumentIdRef = useRef<string | null>(null);
  const pendingFocusedGroupKeyRef = useRef<string | null>(null);
  const panGestureRef = useRef<CanvasPanGesture | null>(null);
  const isSpacePressedRef = useRef(false);
  const shouldIgnoreNextCanvasClickRef = useRef(false);
  const [zoomPercent, setZoomPercent] = useState(DEFAULT_CANVAS_ZOOM_PERCENT);
  const [focusedGroupKey, setFocusedGroupKey] = useState<string | null>(null);
  const [groupPendingDelete, setGroupPendingDelete] = useState<DraftGroupListEntry | null>(null);
  const [isDeletePending, setIsDeletePending] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const groupRows = buildDraftGroupLayout({
    groups: draftGroups ?? [],
    drafts: drafts ?? [],
  });
  const activeDraft =
    activeDocumentId === null ? undefined : drafts?.find((draft) => draft._id === activeDocumentId);
  const activeGroupKey = activeDraft?.groupId ?? UNGROUPED_DRAFT_GROUP_KEY;
  const visibleFocusedGroupKey = focusedGroupKey ?? activeGroupKey;

  function setCanvasZoomAroundPoint({
    nextZoomPercent,
    focalPointPx,
  }: {
    nextZoomPercent: number;
    focalPointPx?: { xPx: number; yPx: number };
  }): void {
    if (nextZoomPercent === zoomPercent) {
      return;
    }
    const scroller = framesScrollerRef.current;
    if (scroller === null) {
      setZoomPercent(nextZoomPercent);
      return;
    }
    const focalPoint = focalPointPx ?? {
      xPx: scroller.clientWidth / 2,
      yPx: scroller.clientHeight / 2,
    };
    const target = getFocalPointPreservingScrollTarget({
      focalPointPx: focalPoint,
      previousZoomPercent: zoomPercent,
      nextZoomPercent,
      scrollLeftPx: scroller.scrollLeft,
      scrollTopPx: scroller.scrollTop,
    });
    setZoomPercent(nextZoomPercent);
    requestAnimationFrame(() => {
      scroller.scrollLeft = target.scrollLeftPx;
      scroller.scrollTop = target.scrollTopPx;
    });
  }

  function applyCanvasZoom(direction: "in" | "out"): void {
    setCanvasZoomAroundPoint({ nextZoomPercent: getNextZoomPercent(zoomPercent, direction) });
  }

  function fitDraftsToView(): void {
    const scroller = framesScrollerRef.current;
    const scene = canvasSceneRef.current;
    if (scroller === null || scene === null) {
      return;
    }
    const currentZoomFactor = zoomPercent / 100;
    const sceneRect = scene.getBoundingClientRect();
    const naturalWidthPx = sceneRect.width / currentZoomFactor;
    const naturalHeightPx = sceneRect.height / currentZoomFactor;
    const fitLayout = calculateFitCanvasViewport({
      viewportWidthPx: scroller.clientWidth,
      viewportHeightPx: scroller.clientHeight,
      contentBounds: {
        leftPx: 0,
        topPx: 0,
        rightPx: naturalWidthPx,
        bottomPx: naturalHeightPx,
      },
      paddingPx: 0,
    });
    setZoomPercent(fitLayout.zoomPercent);
    requestAnimationFrame(() => {
      scroller.scrollLeft = 0;
      scroller.scrollTop = 0;
    });
  }

  function resetCanvasZoom(): void {
    setCanvasZoomAroundPoint({ nextZoomPercent: DEFAULT_CANVAS_ZOOM_PERCENT });
  }

  function focusDraftGroup(groupKey: string): void {
    const scroller = framesScrollerRef.current;
    const groupElement = groupRefsByKey.current.get(groupKey);
    if (scroller === null || groupElement === undefined) {
      pendingFocusedGroupKeyRef.current = groupKey;
      setFocusedGroupKey(groupKey);
      return;
    }
    pendingFocusedGroupKeyRef.current = null;
    setFocusedGroupKey(groupKey);
    const groupBounds = {
      leftPx: groupElement.offsetLeft,
      topPx: groupElement.offsetTop,
      rightPx: groupElement.offsetLeft + groupElement.offsetWidth,
      bottomPx: groupElement.offsetTop + groupElement.offsetHeight,
    };
    const fitLayout = calculateFitCanvasViewport({
      viewportWidthPx: scroller.clientWidth,
      viewportHeightPx: scroller.clientHeight,
      contentBounds: groupBounds,
      paddingPx: CANVAS_FRAME_GAP_PX,
    });
    setZoomPercent(fitLayout.zoomPercent);
    requestAnimationFrame(() => {
      const target = getGroupFocusScrollTarget({
        groupBounds,
        viewportWidthPx: scroller.clientWidth,
        viewportHeightPx: scroller.clientHeight,
        zoomPercent: fitLayout.zoomPercent,
      });
      scroller.scrollLeft = target.scrollLeftPx;
      scroller.scrollTop = target.scrollTopPx;
    });
  }

  useEffect(() => {
    const pendingGroupKey = pendingFocusedGroupKeyRef.current;
    if (pendingGroupKey !== null && groupRefsByKey.current.has(pendingGroupKey)) {
      focusDraftGroup(pendingGroupKey);
    }
  }, [draftGroups]);

  function createDraftGroup(): void {
    if (canvasId === null) {
      return;
    }
    const name = `Group ${(draftGroups?.length ?? 0) + 1}`;
    void convexClient
      .mutation(api.draftGroups.create, { canvasId, name })
      .then((groupId) => {
        pendingFocusedGroupKeyRef.current = groupId;
        setFocusedGroupKey(groupId);
      })
      .catch((error: unknown) => {
        console.error("create draft group failed", error);
        getActiveEditorStore().getState().showNotice("Couldn't create the group.");
      });
  }

  function createDraftInGroup(groupKey: string): void {
    if (canvasId === null || drafts === undefined) {
      return;
    }
    void convexClient
      .mutation(api.documents.createDocument, {
        sessionId: getOrCreateSessionId(),
        canvasId,
        name: computeNextDraftName({ existingNames: drafts.map((draft) => draft.name) }),
        ...(groupKey === UNGROUPED_DRAFT_GROUP_KEY
          ? {}
          : { groupId: groupKey as Id<"draftGroups"> }),
      })
      .then(({ documentId }) => onActivateDraft(documentId))
      .catch((error: unknown) => {
        console.error("create grouped draft failed", error);
        getActiveEditorStore().getState().showNotice("Couldn't create the draft.");
      });
  }

  function updateDraftGroup(
    groupKey: string,
    value: { name: string; description?: string },
  ): void {
    void convexClient
      .mutation(api.draftGroups.update, {
        groupId: groupKey as Id<"draftGroups">,
        name: value.name,
        description: value.description ?? null,
      })
      .catch((error: unknown) => {
        console.error("update draft group failed", error);
        getActiveEditorStore().getState().showNotice("Couldn't update the group.");
      });
  }

  function moveDraftGroup(groupKey: string, direction: "up" | "down"): void {
    if (canvasId === null || draftGroups === undefined) {
      return;
    }
    const groupIds = getReorderedDraftGroupIds({
      groupIds: draftGroups.map((group) => group._id),
      groupId: groupKey,
      direction,
    }) as Id<"draftGroups">[];
    void convexClient.mutation(api.draftGroups.reorderGroups, { canvasId, groupIds }).catch(
      (error: unknown) => {
        console.error("reorder draft groups failed", error);
        getActiveEditorStore().getState().showNotice("Couldn't reorder the groups.");
      },
    );
  }

  function moveDraftToGroup({ draftId, toGroupId }: { draftId: string; toGroupId: string }): void {
    void convexClient
      .mutation(api.draftGroups.moveDraft, {
        documentId: draftId as Id<"documents">,
        groupId:
          toGroupId === UNGROUPED_DRAFT_GROUP_KEY
            ? null
            : (toGroupId as Id<"draftGroups">),
      })
      .catch((error: unknown) => {
        console.error("move draft to group failed", error);
        getActiveEditorStore().getState().showNotice("Couldn't move the draft.");
      });
  }

  function confirmDeleteDraftGroup(): void {
    if (groupPendingDelete === null || isDeletePending) {
      return;
    }
    setIsDeletePending(true);
    void convexClient
      .mutation(api.draftGroups.deleteGroup, { groupId: groupPendingDelete._id })
      .then(() => {
        setFocusedGroupKey(UNGROUPED_DRAFT_GROUP_KEY);
        getActiveEditorStore()
          .getState()
          .showNotice("Group removed. Its drafts are now in Ungrouped.");
      })
      .catch((error: unknown) => {
        console.error("delete draft group failed", error);
        getActiveEditorStore().getState().showNotice("Couldn't delete the group.");
      })
      .finally(() => {
        setIsDeletePending(false);
        setGroupPendingDelete(null);
      });
  }

  function handleCanvasWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    const scrollerRect = event.currentTarget.getBoundingClientRect();
    setCanvasZoomAroundPoint({
      nextZoomPercent: getNextZoomPercent(zoomPercent, event.deltaY < 0 ? "in" : "out"),
      focalPointPx: {
        xPx: event.clientX - scrollerRect.left,
        yPx: event.clientY - scrollerRect.top,
      },
    });
  }

  /*
    Clicking the frames-surface BACKGROUND (the chrome around/between the
    frames) deselects the current block — the right rail then flips back to
    the Blocks tab (PropertyPanelSlot's deselect rule), so adding blocks is
    one click away. Scoped to this element only (never a document-level
    listener): a press that starts on a frame, a panel, or a toolbar records
    no position, and a drag released over the background moves >4px — both
    stay inert, so drops and marquee-ish gestures never clear the selection.
    An open inline editor commits first through its normal outside-click
    path: the background pointerdown blurs it before this click lands.
  */
  const backgroundPressPositionRef = useRef<{ x: number; y: number } | null>(null);
  function handleSurfacePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const isBackground =
      getIsCanvasPanRegion(event.target) && !getIsInteractiveCanvasTarget(event.target);
    backgroundPressPositionRef.current =
      event.button === 0 && isBackground ? { x: event.clientX, y: event.clientY } : null;
    const shouldStartPan =
      event.pointerType !== "touch" &&
      useCanvasDragStore.getState().dragSource === null &&
      !getIsInteractiveCanvasTarget(event.target) &&
      (event.button === 1 || (event.button === 0 && (isSpacePressedRef.current || isBackground)));
    if (!shouldStartPan) {
      return;
    }
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    panGestureRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScrollLeft: event.currentTarget.scrollLeft,
      startScrollTop: event.currentTarget.scrollTop,
      hasMoved: false,
    };
  }

  function handleSurfacePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const gesture = panGestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - gesture.startClientX;
    const deltaY = event.clientY - gesture.startClientY;
    if (!gesture.hasMoved && Math.hypot(deltaX, deltaY) <= CANVAS_PAN_THRESHOLD_PX) {
      return;
    }
    gesture.hasMoved = true;
    event.preventDefault();
    setIsPanning(true);
    event.currentTarget.scrollLeft = gesture.startScrollLeft - deltaX;
    event.currentTarget.scrollTop = gesture.startScrollTop - deltaY;
  }

  function endCanvasPan(event: ReactPointerEvent<HTMLDivElement>): void {
    const gesture = panGestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) {
      return;
    }
    shouldIgnoreNextCanvasClickRef.current = gesture.hasMoved;
    panGestureRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function cancelCanvasPan(scroller: HTMLDivElement): void {
    const gesture = panGestureRef.current;
    if (gesture !== null && scroller.hasPointerCapture(gesture.pointerId)) {
      scroller.releasePointerCapture(gesture.pointerId);
    }
    panGestureRef.current = null;
    backgroundPressPositionRef.current = null;
    shouldIgnoreNextCanvasClickRef.current = false;
    isSpacePressedRef.current = false;
    setIsPanning(false);
  }

  function handleSurfaceClick(event: ReactMouseEvent<HTMLDivElement>): void {
    if (shouldIgnoreNextCanvasClickRef.current) {
      shouldIgnoreNextCanvasClickRef.current = false;
      backgroundPressPositionRef.current = null;
      return;
    }
    const pressedAt = backgroundPressPositionRef.current;
    backgroundPressPositionRef.current = null;
    const isBackgroundClick =
      getIsCanvasPanRegion(event.target) &&
      !getIsInteractiveCanvasTarget(event.target) &&
      pressedAt !== null &&
      Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) <=
        CANVAS_PAN_THRESHOLD_PX;
    if (!isBackgroundClick || useCanvasDragStore.getState().dragSource !== null) {
      return;
    }
    getActiveEditorStore().getState().selectBlock(null);
  }

  function handleCanvasKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      isSpacePressedRef.current = true;
      return;
    }
    if (event.key === "Escape") {
      cancelCanvasPan(event.currentTarget);
      return;
    }
    const delta = event.shiftKey ? CANVAS_KEYBOARD_PAN_PX * 2 : CANVAS_KEYBOARD_PAN_PX;
    const scrollTargetByKey: Record<string, { left: number; top: number }> = {
      ArrowLeft: { left: -delta, top: 0 },
      ArrowRight: { left: delta, top: 0 },
      ArrowUp: { left: 0, top: -delta },
      ArrowDown: { left: 0, top: delta },
    };
    const target = scrollTargetByKey[event.key];
    if (target === undefined) {
      return;
    }
    event.preventDefault();
    event.currentTarget.scrollBy({ ...target, behavior: "smooth" });
  }

  function handleCanvasKeyUp(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === " ") {
      isSpacePressedRef.current = false;
    }
  }

  /*
    Bring the newly activated frame into view. Depends on `drafts` too: on a
    deep link the store connects BEFORE the draft-list subscription resolves,
    so the frame element doesn't exist on the first run — the retry when the
    list arrives positions it. The ref guards against re-scrolling (yanking a
    manually scrolled view) on unrelated list updates like renames.
  */
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

  /*
    Frame tiers, precomputed in canvas order so membership stays stable as
    you walk the row: the first MAX_LIVE_EDITOR_FRAMES drafts are live
    editors (the active draft ALWAYS holds a slot, wherever it sits), then
    live previews up to their cap, then placeholders.
  */
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

  const moveDestinations = [
    { groupId: UNGROUPED_DRAFT_GROUP_KEY, name: "Ungrouped" },
    ...(draftGroups ?? []).map((group) => ({ groupId: group._id, name: group.name })),
  ];

  function renderDraftFrame(draft: DraftListEntry, groupKey: string) {
    const isActive = draft._id === activeDocumentId;
    const isGenerationTarget = draft._id === generationTargetDocumentId;
    function registerFrameRef(element: HTMLDivElement | null): void {
      if (element === null) {
        frameRefsById.current.delete(draft._id);
      } else {
        frameRefsById.current.set(draft._id, element);
      }
    }
    const frameActions = (
      <DraftGroupMoveDraftMenu
        draftId={draft._id}
        draftName={draft.name}
        currentGroupId={groupKey}
        groups={moveDestinations}
        onMoveDraft={moveDraftToGroup}
      />
    );
    if (liveEditorIds.has(draft._id)) {
      return (
        <div key={draft._id} className="shrink-0" role="listitem">
          <EditorDraftFrame
            draft={draft}
            isActive={isActive}
            isGenerationTarget={isGenerationTarget}
            zoomPercent={100}
            frameActions={frameActions}
            onActivate={() => onActivateDraft(draft._id)}
            registerFrameRef={registerFrameRef}
          />
        </div>
      );
    }
    return (
      <div key={draft._id} className="shrink-0" role="listitem">
        <SiblingDraftFrame
          draft={draft}
          shouldMountLivePreview={liveSiblingPreviewIds.has(draft._id)}
          isGenerationTarget={isGenerationTarget}
          zoomPercent={100}
          frameActions={frameActions}
          onActivate={() => onActivateDraft(draft._id)}
          registerFrameRef={registerFrameRef}
        />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="draft-frames-canvas">
      {/*
        THE one scroll region (owner decision): frames grow with their
        content — no frame has an inner scroller — so this surface scrolls
        both axes: horizontally across frames, vertically through the
        tallest one. Frames stay top-aligned (items-start).
      */}
      {/*
        Chrome surface: darker-than-panels in dark mode (Figma-style canvas);
        the light value is unchanged. Email pixels inside frames come from
        document inline styles and never react to the app theme.
        data-frames-scroller: the dnd layer edge-scrolls this surface
        during palette drags (see CanvasDndContext).
      */}
      <div
        ref={framesScrollerRef}
        className={cn(
          "relative min-h-0 flex-1 overflow-auto bg-neutral-200/70 outline-none dark:bg-black/40",
          isPanning ? "cursor-grabbing select-none" : "cursor-grab",
        )}
        tabIndex={0}
        role="region"
        aria-label="Draft groups canvas. Drag blank space or use arrow keys to pan."
        data-frames-scroller
        data-canvas-pan-region
        onPointerDown={handleSurfacePointerDown}
        onPointerMove={handleSurfacePointerMove}
        onPointerUp={endCanvasPan}
        onPointerCancel={endCanvasPan}
        onClick={handleSurfaceClick}
        onWheel={handleCanvasWheel}
        onKeyDown={handleCanvasKeyDown}
        onKeyUp={handleCanvasKeyUp}
        onBlur={(event) => cancelCanvasPan(event.currentTarget)}
      >
        <div
          ref={canvasSceneRef}
          className="inline-flex w-max min-w-max flex-col gap-16 p-16"
          style={{ zoom: zoomPercent / 100 }}
          data-canvas-scene
          data-canvas-pan-region
        >
          {groupRows.map((row, rowIndex) => {
            const groupIndex =
              row.group === null
                ? -1
                : (draftGroups ?? []).findIndex((group) => group._id === row.group?._id);
            return (
              <div
                key={row.key}
                ref={(element) => {
                  if (element === null) {
                    groupRefsByKey.current.delete(row.key);
                  } else {
                    groupRefsByKey.current.set(row.key, element);
                  }
                }}
                className="w-max shrink-0"
                data-canvas-pan-region
                data-draft-group-row={row.key}
              >
                <DraftGroupSection
                  groupId={row.key}
                  name={row.group?.name ?? "Ungrouped"}
                  description={row.group?.description}
                  draftCount={row.drafts.length}
                  isFocused={visibleFocusedGroupKey === row.key}
                  onFocusGroup={focusDraftGroup}
                  onRenameGroup={row.group === null ? undefined : updateDraftGroup}
                  onCreateDraft={createDraftInGroup}
                  onDeleteGroup={
                    row.group === null
                      ? undefined
                      : () => {
                          setGroupPendingDelete(row.group);
                        }
                  }
                  onMoveGroup={row.group === null ? undefined : moveDraftGroup}
                  isMoveUpDisabled={groupIndex <= 0}
                  isMoveDownDisabled={
                    groupIndex < 0 || groupIndex >= (draftGroups?.length ?? 0) - 1
                  }
                  data-canvas-pan-region
                  data-group-row-index={rowIndex}
                >
                  {row.drafts.map((draft) => renderDraftFrame(draft, row.key))}
                </DraftGroupSection>
              </div>
            );
          })}
        </div>
      </div>

      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="absolute top-4 left-4 z-30 shadow-lg"
        onClick={createDraftGroup}
        disabled={canvasId === null}
        data-testid="create-draft-group"
      >
        <PlusIcon /> New group
      </Button>

      {/*
        Light prev/next affordances at the canvas edges (item 2 of the
        frames spec) — activate + scroll the neighbor into view.
      */}
      {previousDraft !== null && (
        <FrameEdgeArrow side="left" onClick={() => onActivateDraft(previousDraft._id)} />
      )}
      {nextDraft !== null && (
        <FrameEdgeArrow side="right" onClick={() => onActivateDraft(nextDraft._id)} />
      )}
      <CanvasZoomControls
        zoomPercent={zoomPercent}
        onZoomChange={applyCanvasZoom}
        onFitToView={fitDraftsToView}
        onResetZoom={resetCanvasZoom}
      />

      <Dialog
        open={groupPendingDelete !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen && !isDeletePending) {
            setGroupPendingDelete(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{groupPendingDelete?.name}”?</DialogTitle>
            <DialogDescription>
              The group will be removed, but its drafts will be kept and moved to Ungrouped.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={isDeletePending} />}>
              Cancel
            </DialogClose>
            <Button
              variant="destructive"
              disabled={isDeletePending}
              onClick={confirmDeleteDraftGroup}
            >
              {isDeletePending ? <Loader2Icon className="animate-spin" /> : null}
              Delete group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/*
  A sibling frame past the editor cap: label + live read-only preview (or a placeholder).
*/
function SiblingDraftFrame({
  draft,
  shouldMountLivePreview,
  isGenerationTarget,
  zoomPercent,
  frameActions,
  onActivate,
  registerFrameRef,
}: {
  draft: DraftListEntry;
  shouldMountLivePreview: boolean;
  isGenerationTarget: boolean;
  zoomPercent: number;
  frameActions?: React.ReactNode;
  onActivate: () => void;
  registerFrameRef: (element: HTMLDivElement | null) => void;
}) {
  /*
    Reject-with-affordance (owner decision §8.3 — never activate-on-hover):
    while a drag is live, preview frames dim/desaturate and show a static
    hint badge (previews are never a drop target for ANY drag source).
    Static, not hover-driven: pointer capture during a dnd gesture means
    :hover never updates on other elements.
  */
  const isDragActive = useCanvasDragStore((state) => state.dragSource !== null);
  return (
    <div
      ref={registerFrameRef}
      className="flex shrink-0 flex-col"
      style={{ width: PREVIEW_FRAME_WIDTH_PX, zoom: zoomPercent / 100 }}
      data-testid="draft-frame"
      data-active="false"
      data-document-id={draft._id}
      data-generation-target={isGenerationTarget || undefined}
    >
      <DraftFrameLabel
        draft={draft}
        isActive={false}
        onActivate={onActivate}
        actions={frameActions}
      />
      {/*
        Positioning wrapper for the generation glow (switch-away-mid-
        generation: ops keep landing in the target draft even as a sibling,
        so the glow follows the frame; activation stays enabled — the frame
        is read-only here anyway).
      */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {isGenerationTarget && <GenerationGlowBorder />}
        {/*
          div-with-button-semantics: the preview markup contains links/buttons
          (inert via pointer-events-none), which must not nest inside a real
          <button> (invalid interactive-content nesting → React dev warning).
        */}
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
            /*
              Full scaled content, no inner scroller — consistent with the
              editor frames' height-follows-content behavior.
            */
            "relative overflow-hidden rounded-lg border text-left transition-[box-shadow,opacity,filter]",
            getDraftFrameSelectionClassName(false),
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

/*
  Reactive read-only preview: collaborators' edits to the sibling appear live.
*/
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

/*
  Subtle floating prev/next chevron at a canvas edge.
*/
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
