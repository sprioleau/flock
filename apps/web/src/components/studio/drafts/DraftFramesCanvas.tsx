"use client";

import { useEffect, useRef, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import { BanIcon, ChevronLeftIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";
import type { EmailDocument } from "@tandem/email-sdk";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { useEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";
import { useCanvasDragStore } from "../dnd/drag-drop-store";
import { EditorCanvas } from "../EditorCanvas";
import { ReadOnlyEmailPreview } from "../history/ReadOnlyEmailPreview";
import { DraftFrameToolbar } from "./DraftFrameToolbar";
import { useCanvasDrafts, type DraftListEntry } from "./use-canvas-drafts";

/**
 * §10.2 frames UX — the canvas drafts rendered SIDE BY SIDE, Figma-frames
 * style: top-aligned frames on a horizontally scrolling surface (no 2D
 * panning), each with a name label above it.
 *
 * - The ACTIVE frame (the store-connected draft — "last frame clicked") is
 *   the full live editor, exactly the pre-frames EditorCanvas: store binding,
 *   dnd, selection, inline editing, presence overlay. The floating side
 *   toolbar (viewport toggle + HTML export) rides alongside it.
 * - SIBLING frames are live READ-ONLY previews: each holds its own reactive
 *   `getDocumentByKey` subscription, so collaborators' edits appear live;
 *   `ReadOnlyEmailPreview`'s measured fit-zoom scales them down. Clicking a
 *   sibling activates it (shallow ?doc= switch upstream); the frame swaps
 *   from preview to editor when the store connects — content is always the
 *   right draft's, never a mid-switch flash of the old doc in the new frame.
 * - Frame ROLES key off the store's connected documentId (not the URL), so
 *   during the brief switch window the outgoing frame stays the editor.
 *
 * Scale assumption (documented per the redesign spec): canvases hold a
 * handful of drafts at demo scale, so up to {@link MAX_LIVE_SIBLING_PREVIEWS}
 * sibling previews stay mounted simultaneously (each is one Convex
 * subscription + one zoomed static render — cheap). Drafts beyond the cap
 * render a lightweight placeholder frame that still activates on click.
 */

/** Live editor frame width (the email's natural desktop layout width). */
const ACTIVE_FRAME_DESKTOP_WIDTH_PX = 680;
/** Live editor frame width under the mobile viewport toggle. */
const ACTIVE_FRAME_MOBILE_WIDTH_PX = 375;
/** Read-only sibling preview frame width (fit-zoom scales the 640px layout down). */
const PREVIEW_FRAME_WIDTH_PX = 384;
/** Max sibling previews mounted with live subscriptions (demo scale ≤ 8 drafts/canvas). */
const MAX_LIVE_SIBLING_PREVIEWS = 8;

export function DraftFramesCanvas({
  onActivateDraft,
}: {
  onActivateDraft: (documentId: Id<"documents">) => void;
}) {
  const { drafts, activeDocumentId, activeIndex } = useCanvasDrafts();
  const viewport = useEditorStore((state) => state.viewport);
  const frameRefsById = useRef(new Map<string, HTMLDivElement>());
  const lastScrolledDocumentIdRef = useRef<string | null>(null);

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

  // Sibling previews beyond the cap degrade to placeholders. The mounted set
  // is precomputed in canvas order so it stays stable as you walk the row.
  const liveSiblingPreviewIds = new Set<string>();
  for (const draft of drafts ?? []) {
    if (draft._id === activeDocumentId) {
      continue;
    }
    if (liveSiblingPreviewIds.size < MAX_LIVE_SIBLING_PREVIEWS) {
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
          if (isActive) {
            return (
              <ActiveDraftFrame
                key={draft._id}
                draft={draft}
                frameWidthPx={
                  viewport === "mobile"
                    ? ACTIVE_FRAME_MOBILE_WIDTH_PX
                    : ACTIVE_FRAME_DESKTOP_WIDTH_PX
                }
                registerFrameRef={registerFrameRef}
              />
            );
          }
          return (
            <SiblingDraftFrame
              key={draft._id}
              draft={draft}
              shouldMountLivePreview={liveSiblingPreviewIds.has(draft._id)}
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

/** The live editable frame: label + the full EditorCanvas + the floating side toolbar. */
function ActiveDraftFrame({
  draft,
  frameWidthPx,
  registerFrameRef,
}: {
  draft: DraftListEntry;
  frameWidthPx: number;
  registerFrameRef: (element: HTMLDivElement | null) => void;
}) {
  // Drops only land here: while a drag is live the active frame gets a
  // subtle ring (and siblings dim) so the legal target reads at a glance.
  const isDragActive = useCanvasDragStore((state) => state.dragSource !== null);
  return (
    <div
      ref={registerFrameRef}
      className="relative flex shrink-0 flex-col transition-[width] duration-200"
      style={{ width: frameWidthPx }}
      data-testid="draft-frame"
      data-active="true"
      data-document-id={draft._id}
    >
      <DraftFrameLabel draft={draft} isActive />
      {/* Floating per-frame toolbar: STICKY against the frames surface (the
          one scroller) so it stays reachable while scrolling a tall email;
          zero-height wrapper so it never shifts the canvas below. */}
      <div className="sticky top-2 z-10 h-0 self-end overflow-visible pr-2">
        <DraftFrameToolbar />
      </div>
      {/* Height follows content (owner decision): no inner max-height or
          scroll region — the email defines the frame's height and the frames
          surface does all scrolling. */}
      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-lg border bg-background shadow-md ring-1 ring-black/5 dark:ring-white/10",
          isDragActive && "ring-2 ring-ring/50",
        )}
      >
        <EditorCanvas />
      </div>
    </div>
  );
}

/** A sibling frame: label + live read-only preview (or a placeholder past the cap). */
function SiblingDraftFrame({
  draft,
  shouldMountLivePreview,
  onActivate,
  registerFrameRef,
}: {
  draft: DraftListEntry;
  shouldMountLivePreview: boolean;
  onActivate: () => void;
  registerFrameRef: (element: HTMLDivElement | null) => void;
}) {
  // Reject-with-affordance (owner decision §8.3 — never activate-on-hover):
  // while a drag is live, siblings dim/desaturate and show a static hint
  // badge. Static, not hover-driven: pointer capture during a dnd gesture
  // means :hover never updates on other elements.
  const isDragActive = useCanvasDragStore((state) => state.dragSource !== null);
  return (
    <div
      ref={registerFrameRef}
      className="flex shrink-0 flex-col"
      style={{ width: PREVIEW_FRAME_WIDTH_PX }}
      data-testid="draft-frame"
      data-active="false"
      data-document-id={draft._id}
    >
      <DraftFrameLabel draft={draft} isActive={false} onActivate={onActivate} />
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
          // active frame's height-follows-content behavior.
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
          <LiveSiblingPreview documentId={draft._id} />
        ) : (
          <div className="flex h-40 items-center justify-center rounded-lg border bg-background text-xs text-muted-foreground">
            Click to open this draft
          </div>
        )}
      </div>
    </div>
  );
}

/** Reactive read-only preview: collaborators' edits to the sibling appear live. */
function LiveSiblingPreview({ documentId }: { documentId: Id<"documents"> }) {
  const snapshot = useQuery(api.documents.getDocument, { documentId });
  if (snapshot === undefined || snapshot === null) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border bg-background">
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <ReadOnlyEmailPreview doc={snapshot.doc as EmailDocument} />;
}

/**
 * The Figma-frame-style name label above a frame. Active label is visually
 * distinct and renames inline on double-click (writes `documents.name` —
 * user-facing half of the §10.2 dual naming; `agentName` stays read-only in
 * the selector menu). Inactive labels activate their frame on click.
 */
function DraftFrameLabel({
  draft,
  isActive,
  onActivate,
}: {
  draft: DraftListEntry;
  isActive: boolean;
  onActivate?: () => void;
}) {
  const convexClient = useConvex();
  const [isRenaming, setIsRenaming] = useState(false);
  const [nameInput, setNameInput] = useState("");

  const commitRename = (): void => {
    setIsRenaming(false);
    const name = nameInput.trim();
    if (name.length === 0 || name === draft.name) {
      return;
    }
    convexClient
      .mutation(api.documents.renameDocument, { documentId: draft._id, name })
      .catch((error: unknown) => {
        console.error("renameDocument failed", error);
      });
  };

  if (isRenaming) {
    return (
      <div className="flex h-6 shrink-0 items-center pb-1">
        <input
          value={nameInput}
          onChange={(event) => setNameInput(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commitRename();
            } else if (event.key === "Escape") {
              setIsRenaming(false);
            }
          }}
          autoFocus
          onFocus={(event) => event.target.select()}
          maxLength={80}
          className="h-5 rounded-sm bg-background px-1.5 text-xs outline-none ring-1 ring-ring"
          style={{ width: `${Math.max(nameInput.length + 2, 8)}ch` }}
          aria-label={`Rename ${draft.name}`}
          data-testid="draft-frame-rename"
        />
      </div>
    );
  }

  return (
    <div className="flex h-6 shrink-0 items-center pb-1">
      <button
        type="button"
        onClick={onActivate}
        onDoubleClick={
          isActive
            ? () => {
                setNameInput(draft.name);
                setIsRenaming(true);
              }
            : undefined
        }
        className={cn(
          "max-w-full truncate text-xs",
          isActive
            ? "cursor-text font-semibold text-foreground"
            : "cursor-pointer font-medium text-muted-foreground hover:text-foreground",
        )}
        title={draft.agentName !== undefined ? draft.agentName : undefined}
        data-testid="draft-frame-label"
      >
        {draft.name}
      </button>
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
