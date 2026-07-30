"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useEditorStore } from "@/lib/editor-store";

/**
 * Shared data spine for the §10.2 frames UX: the ordered draft list of the
 * CONNECTED canvas plus the active (store-connected) draft. Every consumer
 * (frames canvas, selector dropdown, chat indicator) calls this hook with the
 * same args, so Convex dedupes it into ONE reactive subscription.
 */

export type DraftListEntry = FunctionReturnType<
  typeof api.documents.listDocumentsByCanvas
>[number];

export interface CanvasDrafts {
  /** Ordered by fractional orderIndex (undefined while the subscription warms up). */
  drafts: DraftListEntry[] | undefined;
  /** The draft the editor store is CONNECTED to — "last frame clicked" wins. */
  activeDocumentId: Id<"documents"> | null;
  /** Index of the active draft in `drafts` (-1 while unknown). */
  activeIndex: number;
  canvasId: Id<"canvases"> | null;
}

export function useCanvasDrafts(): CanvasDrafts {
  const canvasId = useEditorStore((state) => state.canvasId);
  const activeDocumentId = useEditorStore((state) => state.documentId);
  const drafts = useQuery(
    api.documents.listDocumentsByCanvas,
    canvasId !== null ? { canvasId } : "skip",
  );
  const activeIndex =
    drafts === undefined || activeDocumentId === null
      ? -1
      : drafts.findIndex((draft) => draft._id === activeDocumentId);
  return { drafts, activeDocumentId, activeIndex, canvasId };
}

/** Smallest unused "Draft N" so new-draft names stay unique per canvas. */
export function computeNextDraftName(drafts: DraftListEntry[]): string {
  const takenNames = new Set(drafts.map((draft) => draft.name));
  for (let candidate = drafts.length + 1; ; candidate++) {
    const name = `Draft ${candidate}`;
    if (!takenNames.has(name)) {
      return name;
    }
  }
}
