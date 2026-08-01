"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { Loader2Icon } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEditorStore } from "@/lib/editor-store";

/**
 * The Figma-style brand propagation prompt (brand-kit architecture §5.2):
 * shown ONLY to the actor — after they bind a kit to the canvas, after they
 * save the bound kit (revision bump), or when they click a draft's "Updated
 * brand available" pill. Collaborators never see it unprompted; they see
 * pills (§6).
 *
 * Deliberate, destructive-action framing: binding/saving alone restyled
 * nothing; THIS confirm is what emits ops — one revertable batch per draft
 * through the one history spine. PRESERVE-VARIATION semantics (owner
 * decision 2): each updated draft keeps its variation identity when the kit
 * still offers it, falling back to the kit's first theme.
 *
 * `scopedDocumentId` null = the canvas-wide prompt ("Update all" / "Only the
 * active draft" / "Not now"); set = the pill's per-draft prompt ("Update
 * this draft" / "Update all" / "Dismiss").
 */
export function BrandApplyDialog({
  isOpen,
  onOpenChange,
  scopedDocumentId = null,
  onDismissScopedDraft,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  scopedDocumentId?: Id<"documents"> | null;
  /** The pill's Dismiss: hide the pill for this kit revision on this client. */
  onDismissScopedDraft?: () => void;
}) {
  const canvasId = useEditorStore((state) => state.canvasId);
  const sessionId = useEditorStore((state) => state.authorId);
  const activeDocumentId = useEditorStore((state) => state.documentId);
  const status = useQuery(
    api.brandKits.getCanvasBrandStatus,
    isOpen && canvasId !== null ? { canvasId } : "skip",
  );
  const applyBrandToDocuments = useMutation(api.brandKits.applyBrandToDocuments);
  const [busyScope, setBusyScope] = useState<"all" | "one" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const binding = status?.binding ?? null;
  const drafts = status?.drafts ?? [];
  const scopedDraft =
    scopedDocumentId === null
      ? null
      : (drafts.find((draft) => draft.documentId === scopedDocumentId) ?? null);
  const activeDraft = drafts.find((draft) => draft.documentId === activeDocumentId) ?? null;

  const applyToDrafts = async (documentIds: Id<"documents">[], scope: "all" | "one") => {
    if (canvasId === null || sessionId === null || busyScope !== null || documentIds.length === 0) {
      return;
    }
    setBusyScope(scope);
    setErrorMessage(null);
    try {
      await applyBrandToDocuments({ canvasId, documentIds, sessionId });
      onOpenChange(false);
    } catch (error: unknown) {
      setErrorMessage(
        error instanceof ConvexError
          ? String(error.data)
          : "Couldn't update the drafts right now. Try again.",
      );
    } finally {
      setBusyScope(null);
    }
  };

  if (binding === null) {
    return null;
  }
  const allDocumentIds = drafts.map((draft) => draft.documentId);
  const isScoped = scopedDraft !== null;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="brand-apply-dialog">
        <DialogHeader>
          <DialogTitle>
            {isScoped
              ? `Update “${scopedDraft.name}” to ${binding.name}?`
              : `Apply “${binding.name}” to this canvas?`}
          </DialogTitle>
          <DialogDescription>
            {isScoped
              ? `This draft switches to the “${scopedDraft.targetVariation.name}” theme and its logo images are re-sourced. That's one history entry — you can undo it anytime.`
              : `Choosing a brand doesn't change your drafts by itself. Each draft you update now keeps its current theme where ${binding.name} offers it — otherwise it switches to the first theme, “${binding.firstVariation.name}” — and its logo images are re-sourced.`}
          </DialogDescription>
        </DialogHeader>
        {!isScoped && (
          <p className="text-sm text-muted-foreground">
            This creates one history entry per draft. You can undo any draft individually.
          </p>
        )}
        {errorMessage !== null && (
          <p className="text-xs text-destructive" data-testid="brand-apply-error">
            {errorMessage}
          </p>
        )}
        <DialogFooter className="flex-wrap gap-1.5 sm:justify-start">
          {isScoped ? (
            <>
              <Button
                size="sm"
                onClick={() => void applyToDrafts([scopedDraft.documentId], "one")}
                disabled={busyScope !== null}
                data-testid="brand-apply-this-draft"
              >
                {busyScope === "one" && <Loader2Icon className="animate-spin" />}
                Update this draft
              </Button>
              {allDocumentIds.length > 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void applyToDrafts(allDocumentIds, "all")}
                  disabled={busyScope !== null}
                  data-testid="brand-apply-all-drafts"
                >
                  {busyScope === "all" && <Loader2Icon className="animate-spin" />}
                  {`Update all ${allDocumentIds.length} drafts`}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onDismissScopedDraft?.();
                  onOpenChange(false);
                }}
                disabled={busyScope !== null}
                data-testid="brand-apply-dismiss"
              >
                Dismiss
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                onClick={() => void applyToDrafts(allDocumentIds, "all")}
                disabled={busyScope !== null}
                data-testid="brand-apply-all-drafts"
              >
                {busyScope === "all" && <Loader2Icon className="animate-spin" />}
                {`Update all ${allDocumentIds.length} ${allDocumentIds.length === 1 ? "draft" : "drafts"}`}
              </Button>
              {activeDraft !== null && allDocumentIds.length > 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void applyToDrafts([activeDraft.documentId], "one")}
                  disabled={busyScope !== null}
                  data-testid="brand-apply-active-draft"
                >
                  {busyScope === "one" && <Loader2Icon className="animate-spin" />}
                  {`Only “${activeDraft.name}”`}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenChange(false)}
                disabled={busyScope !== null}
                data-testid="brand-apply-not-now"
              >
                Not now
              </Button>
            </>
          )}
        </DialogFooter>
        {!isScoped && (
          <p className="text-xs text-muted-foreground">
            Drafts you skip keep their current look and show an &ldquo;Updated brand
            available&rdquo; pill until someone updates them.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
