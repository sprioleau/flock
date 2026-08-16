"use client";

import { useState, useSyncExternalStore } from "react";
import { useQuery } from "convex/react";
import { SparklesIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/lib/editor-store";
import {
  buildBrandDismissalToken,
  persistDismissedBrandToken,
  readDismissedBrandToken,
  subscribeToBrandDismissals,
} from "./brand-pill-dismissals";
import { BrandApplyDialog } from "./BrandApplyDialog";

/**
 * The NON-BLOCKING "Updated brand available" pill (brand-kit architecture
 * §5.2/§6) — the collaborator-safe half of the Figma model: when the canvas
 * binding changes or the bound kit's revision bumps, drafts still rendering
 * an older brand grow this pill; nobody gets a modal they didn't ask for.
 * Clicking it opens the per-draft prompt (update this draft / update all /
 * dismiss); dismissal is per (kit, revision) per client, so the next real
 * kit change re-arms it.
 *
 * Self-contained (drafts-v2 pattern): reads the canvas id from the active
 * editor store and subscribes to getCanvasBrandStatus itself — mount it with
 * one line anywhere a draft is represented (frame header, toolbar). Renders
 * null while the draft is "current" or "overridden", so it's free to mount
 * unconditionally.
 *
 * "overridden" (§14.5a, formerly "detached") deliberately gets NO pill: local
 * property overrides are a decision, not staleness, and there is nothing to
 * adopt. Its indicator is the quiet dot next to the theme dropdown
 * (ThemeOverrideDot) — and an overridden draft whose parent theme later moves
 * becomes "outdated" and grows this pill like any other.
 */
export function DraftBrandPill({
  documentId,
  className,
}: {
  documentId: Id<"documents">;
  className?: string;
}) {
  const canvasId = useEditorStore((state) => state.canvasId);
  const status = useQuery(
    api.brandKits.getCanvasBrandStatus,
    canvasId !== null ? { canvasId } : "skip",
  );
  const [isPromptOpen, setIsPromptOpen] = useState(false);
  // localStorage as an external store (SSR snapshot: nothing dismissed).
  const dismissedToken = useSyncExternalStore(
    subscribeToBrandDismissals,
    () => readDismissedBrandToken(documentId),
    () => null,
  );

  const binding = status?.binding ?? null;
  const draft = status?.drafts.find((entry) => entry.documentId === documentId) ?? null;
  if (binding === null || draft === null) {
    return null;
  }
  const hasPendingBrandUpdate = draft.state === "outdated" || draft.state === "never-applied";
  const currentToken = buildBrandDismissalToken({
    kitId: binding.kitId,
    revision: binding.revision,
  });
  if (!hasPendingBrandUpdate || dismissedToken === currentToken) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsPromptOpen(true)}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-full border bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground shadow-sm transition-colors hover:bg-secondary/80",
          className,
        )}
        title={`${binding.name} changed since this draft was styled — click to update it.`}
        data-testid={`brand-stale-pill-${documentId}`}
      >
        <SparklesIcon className="size-3" />
        Updated brand available
      </button>
      <BrandApplyDialog
        isOpen={isPromptOpen}
        onOpenChange={setIsPromptOpen}
        scopedDocumentId={documentId}
        onDismissScopedDraft={() => persistDismissedBrandToken({ documentId, token: currentToken })}
      />
    </>
  );
}
