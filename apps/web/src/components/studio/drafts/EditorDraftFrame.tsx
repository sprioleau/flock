"use client";

import { useEffect } from "react";
import { useConvex, useQuery } from "convex/react";
import { BanIcon, Loader2Icon } from "lucide-react";
import { useStore } from "zustand";
import type { EmailDocument } from "@tandem/email-sdk";
import { api } from "@convex/_generated/api";
import {
  acquireEditorStore,
  peekEditorStore,
  releaseEditorStore,
  EditorStoreProvider,
  type EditorStoreApi,
} from "@/lib/editor-store";
import { PresenceProvider } from "@/lib/presence";
import { getOrCreateSessionId } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useCanvasDragStore } from "../dnd/drag-drop-store";
import { EditorCanvas } from "../EditorCanvas";
import {
  DraftFrameLabel,
  EDITOR_FRAME_DESKTOP_WIDTH_PX,
  EDITOR_FRAME_MOBILE_WIDTH_PX,
  EMPTY_FRAME_MIN_HEIGHT_CLASS,
  GenerationGlowBorder,
  GenerationWorkingOverlay,
  getIsDocEmpty,
} from "./draft-frame-chrome";
import { DraftFrameToolbar } from "./DraftFrameToolbar";
import type { DraftListEntry } from "./use-canvas-drafts";

/**
 * Simultaneous multi-frame editing: a draft frame that is a FULL LIVE EDITOR
 * whether or not it is the active one. ONE component type for both roles —
 * activation ("last clicked wins") only flips styling props, so flipping it
 * never remounts the editor subtree: an open inline-editing session, the
 * selection, and an in-flight drag all survive the switch untouched.
 *
 * Lifecycle (the frame-scoped analogue of StudioShell's active-document
 * wiring, built on the drafts-v2 store factory):
 *
 * - STORE: hold a refcounted registry reference for the draft's document
 *   (acquire on mount, release on unmount — one effect, StrictMode-
 *   symmetric). The frame's hold keeps the store — selection, open editor
 *   session, pending-op overlay — alive when the shell releases the outgoing
 *   active document, so typing in a frame is never interrupted by activating
 *   another (or itself).
 * - FEED: non-active frames own their reactive `getDocument` subscription
 *   and feed every snapshot into their store (connect on first sight —
 *   exactly the shell's contract). The ACTIVE frame skips its own
 *   subscription: the shell's `getDocumentByKey` feed already targets the
 *   same registry instance. Per-frame subscription count matches the old
 *   read-only previews' (one `getDocument` each).
 * - SCOPE: the subtree resolves `useEditorStore` against THIS store
 *   (EditorStoreProvider) and presence against THIS document's room
 *   (PresenceProvider) — selection broadcasts, remote cursors, block
 *   indicators, and comment pins land in the right document. Presence
 *   heartbeats scale with the number of live editor frames (bounded by the
 *   frames canvas's cap) plus the shell-level room for active-doc chrome.
 * - ACTIVATION: pointer-down anywhere in a non-active frame reports up in
 *   the CAPTURE phase without consuming the event — the interaction (select,
 *   inline-editor open, drag) lands IMMEDIATELY in this frame's store and
 *   never waits on the activation round-trip; the right rail and chat
 *   re-target when the shell's snapshot lands.
 * - DROPS: palette drops go to the ACTIVE frame only; existing-block drags
 *   are scoped to their own frame (drop-target.ts). During a drag this frame
 *   shows the target ring or dims as a rejected target accordingly.
 */
export function EditorDraftFrame({
  draft,
  isActive,
  isGenerationTarget,
  onActivate,
  registerFrameRef,
}: EditorDraftFrameProps) {
  const documentId = draft._id;

  // The frame's registry hold — paired in ONE effect so StrictMode's
  // mount→cleanup→mount cycle acquires and releases symmetrically.
  useEffect(() => {
    acquireEditorStore(documentId);
    return () => releaseEditorStore(documentId);
  }, [documentId]);

  // Snapshot feed for NON-active frames (the shell feeds the active one).
  // isActive flips only once the shell's own feed has connected + fed the
  // incoming document, so the handoff leaves no unfed gap.
  const convexClient = useConvex();
  const snapshot = useQuery(api.documents.getDocument, isActive ? "skip" : { documentId });
  useEffect(() => {
    const store = peekEditorStore(documentId);
    if (store === null || snapshot === undefined || snapshot === null) {
      return;
    }
    if (store.getState().documentId !== snapshot.documentId) {
      store.getState().connectDocument({
        convexClient,
        documentId: snapshot.documentId,
        canvasId: snapshot.canvasId,
        authorId: getOrCreateSessionId(),
      });
    }
    store.getState().applyServerSnapshot({
      doc: snapshot.doc as EmailDocument,
      headVersion: snapshot.headVersion,
    });
  }, [documentId, snapshot, convexClient]);

  // Render-time read; the re-render that first sees the instance is driven
  // by the snapshot subscription above (the active frame's instance already
  // exists at mount — the shell acquired and connected it).
  const store = peekEditorStore(documentId);
  if (store === null) {
    return (
      <FrameShell
        draft={draft}
        isActive={isActive}
        isGenerationTarget={isGenerationTarget}
        onActivate={onActivate}
        registerFrameRef={registerFrameRef}
        frameWidthPx={EDITOR_FRAME_DESKTOP_WIDTH_PX}
      >
        <FrameEditorLoading />
      </FrameShell>
    );
  }
  return (
    <ConnectedEditorDraftFrame
      draft={draft}
      isActive={isActive}
      isGenerationTarget={isGenerationTarget}
      onActivate={onActivate}
      registerFrameRef={registerFrameRef}
      store={store}
    />
  );
}

export interface EditorDraftFrameProps {
  draft: DraftListEntry;
  /** True when this frame is the shell-connected (active) document. */
  isActive: boolean;
  /** True while a live AI generation streams into this draft. */
  isGenerationTarget: boolean;
  /** Activate this draft (shallow ?doc= switch upstream). No-op when active. */
  onActivate: () => void;
  registerFrameRef: (element: HTMLDivElement | null) => void;
}

function ConnectedEditorDraftFrame({
  draft,
  isActive,
  isGenerationTarget,
  onActivate,
  registerFrameRef,
  store,
}: EditorDraftFrameProps & { store: EditorStoreApi }) {
  const isDocumentReady = useStore(store, (state) => state.isDocumentReady);
  // Per-frame viewport: each store instance carries its own toggle state.
  const viewport = useStore(store, (state) => state.viewport);
  // Empty = no root sections yet. Drives the taller blank-frame minimum and,
  // during a generation turn, the "first section landed" handover: the
  // spinner/status overlay yields to the streaming content, the glow stays.
  const isDocEmpty = useStore(store, (state) => getIsDocEmpty(state.doc));

  // Drag-gesture role: palette drops target the ACTIVE frame; existing-block
  // drags stay in their source frame. Everything else is a rejected target.
  const dragRole = useCanvasDragStore((state): "none" | "target" | "rejected" =>
    state.dragSource === null
      ? "none"
      : (
            state.dragSource.kind === "palette"
              ? isActive
              : state.dragSource.documentId === draft._id
          )
        ? "target"
        : "rejected",
  );
  const isPaletteDragActive = useCanvasDragStore(
    (state) => state.dragSource?.kind === "palette",
  );

  return (
    <FrameShell
      draft={draft}
      isActive={isActive}
      isGenerationTarget={isGenerationTarget}
      onActivate={onActivate}
      registerFrameRef={registerFrameRef}
      frameWidthPx={
        viewport === "mobile" ? EDITOR_FRAME_MOBILE_WIDTH_PX : EDITOR_FRAME_DESKTOP_WIDTH_PX
      }
    >
      {/* Height follows content (owner decision): no inner max-height or
          scroll region — the email defines the frame's height and the frames
          surface does all scrolling. `inert` while a generation streams in:
          the frame is display-only (no pointer, no focus) until the turn
          settles — every OTHER frame keeps normal interaction. */}
      <div
        inert={isGenerationTarget || undefined}
        className={cn(
          "relative flex flex-col overflow-hidden rounded-lg border bg-background ring-1 ring-black/5 dark:ring-white/10",
          isActive ? "shadow-md" : "shadow-sm",
          dragRole === "target" && "ring-2 ring-ring/50",
          dragRole === "rejected" && "opacity-50 saturate-50",
          isDocEmpty && EMPTY_FRAME_MIN_HEIGHT_CLASS,
        )}
        data-drop-rejected={dragRole === "rejected" || undefined}
      >
        {/* Palette drops go to the active draft only (owner decision §8.3) —
            surface the rule on rejected frames, matching the preview frames'
            affordance. Cross-frame block drags dim without a badge: the
            indicator line in the source frame already tells the story. */}
        {dragRole === "rejected" && isPaletteDragActive && (
          <div className="absolute inset-0 z-10 flex items-start justify-center pt-10">
            <span className="inline-flex items-center gap-1.5 rounded-full border bg-background/95 px-2.5 py-1 text-xs text-muted-foreground shadow-sm">
              <BanIcon className="size-3.5" aria-hidden />
              Drops go to the active draft
            </span>
          </div>
        )}
        {isDocumentReady ? (
          <EditorStoreProvider value={store}>
            {/* Frame-scoped presence room: this document's roster, cursors,
                and pins. For the active frame this nests inside the shell's
                provider for the SAME room — consumers resolve the nearest
                one, and the tree shape stays identical across activation
                flips (no editor remount mid-gesture). */}
            <PresenceProvider documentId={draft._id}>
              <EditorCanvas />
            </PresenceProvider>
          </EditorStoreProvider>
        ) : (
          <FrameEditorLoading />
        )}
        {isGenerationTarget && isDocEmpty && <GenerationWorkingOverlay />}
      </div>
    </FrameShell>
  );
}

/**
 * The frame chrome shared by the loading and connected states: outer sizing
 * div (with the activation pointer-down capture), the name label, the sticky
 * per-frame toolbar (active frame only), and the generation glow wrapper.
 */
function FrameShell({
  draft,
  isActive,
  isGenerationTarget,
  onActivate,
  registerFrameRef,
  frameWidthPx,
  children,
}: EditorDraftFrameProps & { frameWidthPx: number; children: React.ReactNode }) {
  return (
    <div
      ref={registerFrameRef}
      className="relative flex shrink-0 flex-col transition-[width] duration-200"
      style={{ width: frameWidthPx }}
      // Capture phase: activation is reported BEFORE the interaction's own
      // handlers run and the event is never consumed — the pointer-down still
      // lands exactly where it hit (block select, inline editor, drag handle).
      onPointerDownCapture={isActive ? undefined : onActivate}
      data-testid="draft-frame"
      data-active={isActive}
      data-frame-editor="true"
      data-document-id={draft._id}
      data-generation-target={isGenerationTarget || undefined}
    >
      <DraftFrameLabel
        draft={draft}
        isActive={isActive}
        onActivate={isActive ? undefined : onActivate}
      />
      {/* Positioning wrapper so the generation glow can ring the content box
          (it sits OUTSIDE the box's overflow-hidden clip) without including
          the label row above. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {isGenerationTarget && <GenerationGlowBorder />}
        {children}
        {/* Floating per-frame toolbar (viewport toggle + HTML export), active
            frame only, OUTSIDE the frame (owner decision): a full-height rail
            absolutely positioned in the inter-frame gutter at the frame's
            right edge (`left-full` tracks the width flip of the mobile
            viewport toggle), top-aligned to the content box. The pill inside
            is STICKY against the frames surface (the one scroller) so it
            stays reachable while scrolling a tall email. The rail itself is
            pointer-transparent so gutter clicks still reach the surface's
            background-deselect handler; only the pill takes pointer events —
            and, sitting outside the frame, it can never cover email content
            or the in-frame right-edge column-split drop zones. */}
        {isActive && (
          <div className="pointer-events-none absolute inset-y-0 left-full z-10 ml-3">
            <div className="pointer-events-auto sticky top-2 w-max">
              <DraftFrameToolbar />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Loading placeholder inside the frame box (pre-snapshot). */
function FrameEditorLoading() {
  return (
    <div className="flex h-40 items-center justify-center bg-background">
      <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
    </div>
  );
}
