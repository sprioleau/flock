"use client";

import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { ROOT_BLOCK_ID, type EmailDocument } from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import { cn } from "@/lib/utils";
import { useConvex } from "convex/react";
import { DraftBrandPill } from "../brand-kit/DraftBrandPill";
import type { DraftListEntry } from "./use-canvas-drafts";

/*
  Shared chrome for the §10.2 draft frames — the pieces both frame flavors
  (live editor frames in EditorDraftFrame.tsx, read-only preview frames in
  DraftFramesCanvas.tsx) render: the Figma-style name label, the generation
  glow + working overlay, and the shared sizing constants.
*/

/*
  Live editor frame width (the email's natural desktop layout width).
*/
/*
  The editing surface keeps its full desktop layout. DraftFramesCanvas applies
  the shared canvas zoom to the complete frame, including its title and rail.
*/
export const EDITOR_FRAME_DESKTOP_LAYOUT_WIDTH_PX = 680;
export const EDITOR_FRAME_DESKTOP_WIDTH_PX = EDITOR_FRAME_DESKTOP_LAYOUT_WIDTH_PX;
/*
  Live editor frame width under the mobile viewport toggle.
*/
export const EDITOR_FRAME_MOBILE_LAYOUT_WIDTH_PX = 375;
export const EDITOR_FRAME_MOBILE_WIDTH_PX = EDITOR_FRAME_MOBILE_LAYOUT_WIDTH_PX;
/*
  Read-only siblings occupy the same natural desktop frame as live editors.
  Selection changes the interaction target and outline only; it must never
  swap a draft into a narrower presentation width.
*/
export const PREVIEW_FRAME_WIDTH_PX = EDITOR_FRAME_DESKTOP_WIDTH_PX;

/*
  The selected frame needs to read at a glance from across the canvas. Keep
  this shared so editor and preview shells cannot drift into ambiguous states.
*/
export function getDraftFrameSelectionClassName(isActive: boolean): string {
  return isActive
    ? "border-primary ring-2 ring-primary/90 shadow-lg shadow-primary/15"
    : "border-border ring-1 ring-black/5 shadow-sm dark:ring-white/10";
}

/*
  The single selection region for a draft. Keeping the label and email body
  inside this wrapper makes the active outline describe the whole draft,
  rather than leaving the title in a separate outlined island.
*/
export function DraftFrameSelectionRegion({
  isActive,
  children,
}: {
  isActive: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-1 flex-col rounded-lg border",
        getDraftFrameSelectionClassName(isActive),
      )}
      data-draft-selected={isActive}
      data-draft-selection-region
    >
      {children}
    </div>
  );
}
/*
  Min height for a frame whose document has NO root sections — 2× the h-40
  (10rem) baseline the placeholder/loading frames use, so a freshly created
  blank draft (the AI-generation flows create one and stream into it) reads
  as a real frame instead of a short strip (owner feedback, item 28a).
*/
export const EMPTY_FRAME_MIN_HEIGHT_CLASS = "min-h-80";

/*
  Whether `doc` has no top-level sections yet (a blank/just-created draft).
*/
export function getIsDocEmpty(doc: EmailDocument): boolean {
  return (doc[ROOT_BLOCK_ID]?.childrenIds.length ?? 0) === 0;
}

/*
  Rotating stage lines under the generation spinner — deliberately GENERIC
  working words (honest presentation: no fake specific claims), cycled on a
  timer until the first section lands and the overlay unmounts.
*/
const GENERATION_STAGE_LINES = [
  "Finding relevant sections…",
  "Updating content…",
  "Adjusting the styles…",
] as const;

/*
  How long each stage line holds before rotating to the next.
*/
const GENERATION_STAGE_ROTATION_MS = 2200;

/*
  The in-frame working state while a generation turn targets a still-empty
  draft: centered spinner + message + rotating stage lines. Unmounts the
  moment the first section lands (content takes over); the glow border and
  the edit lock stay until the turn settles.
*/
export function GenerationWorkingOverlay() {
  const [stageIndex, setStageIndex] = useState(0);
  useEffect(() => {
    const intervalId = setInterval(() => {
      setStageIndex((index) => (index + 1) % GENERATION_STAGE_LINES.length);
    }, GENERATION_STAGE_ROTATION_MS);
    return () => clearInterval(intervalId);
  }, []);
  return (
    <div
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/85"
      data-testid="generation-working-overlay"
    >
      <Loader2Icon className="size-5 animate-spin text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">Flock is ideating…</p>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {GENERATION_STAGE_LINES[stageIndex]}
      </p>
    </div>
  );
}

/*
  EXPERIMENTAL (owner explicitly wants to try it): an animated glowing
  border around the frame a generation turn streams into — a rotating
  conic-gradient ring (crisp layer) plus a blurred halo, pulsing softly.
  Vivid mid-scale colors read on both themes; keyframes in globals.css
  (`generation-glow`). Rendered BEFORE the content box, which is positioned
  and opaque, so only the ring around its edges shows.
*/
export function GenerationGlowBorder() {
  return (
    <>
      <div
        aria-hidden
        className="generation-glow pointer-events-none absolute -inset-1.5 rounded-xl opacity-60 blur-md"
      />
      <div
        aria-hidden
        className="generation-glow pointer-events-none absolute -inset-0.5 rounded-[10px]"
        data-testid="generation-glow-border"
      />
    </>
  );
}

/*
  The Figma-frame-style name label above a frame. Active label is visually
  distinct and renames inline on double-click (writes `documents.name` —
  user-facing half of the §10.2 dual naming; `agentName` stays read-only in
  the selector menu). Inactive labels activate their frame on click.
*/
export function DraftFrameLabel({
  draft,
  isActive,
  onActivate,
  actions,
}: {
  draft: DraftListEntry;
  isActive: boolean;
  onActivate?: () => void;
  actions?: React.ReactNode;
}) {
  const convexClient = useConvex();
  const [isRenaming, setIsRenaming] = useState(false);
  const [nameInput, setNameInput] = useState("");

  function commitRename(): void {
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
  }

  if (isRenaming) {
    return (
      <div className="flex h-8 shrink-0 items-center px-2 py-1">
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
    <div className="shrink-0 px-2 py-1">
      <div className="flex h-6 items-center">
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
        <DraftBrandPill documentId={draft._id} />
        {actions !== undefined ? <div className="ml-auto shrink-0">{actions}</div> : null}
      </div>
    </div>
  );
}
