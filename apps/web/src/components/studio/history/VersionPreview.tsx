"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { ArrowLeftIcon, HistoryIcon, Loader2Icon } from "lucide-react";
import type { EmailDocument } from "@flock/email-sdk";
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
import { useEditorStore } from "@/lib/editor-store";
import { ReadOnlyEmailPreview } from "./ReadOnlyEmailPreview";

type RestorePhase =
  | { name: "idle" }
  | { name: "restoring" }
  | { name: "failed"; message: string };

/**
 * The drawer's preview pane: one historical version reconstructed via
 * `getDocumentAtVersion` (snapshot + replay), rendered read-only, with the
 * restore affordance. The live canvas is untouched — restoring goes through
 * `history.rollbackToVersion`, and the resulting head change flows back in
 * through the normal reactive snapshot feed.
 */
export function VersionPreview({
  documentId,
  version,
  onBack,
}: {
  documentId: Id<"documents">;
  version: number;
  onBack: () => void;
}) {
  const versionSnapshot = useQuery(api.documents.getDocumentAtVersion, { documentId, version });
  const restoreVersion = useEditorStore((state) => state.restoreVersion);
  const showNotice = useEditorStore((state) => state.showNotice);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [restorePhase, setRestorePhase] = useState<RestorePhase>({ name: "idle" });

  const handleRestore = async (): Promise<void> => {
    setRestorePhase({ name: "restoring" });
    const result = await restoreVersion(version);
    if (!result.isOk) {
      setRestorePhase({ name: "failed", message: result.message });
      return;
    }
    setRestorePhase({ name: "idle" });
    setIsConfirmOpen(false);
    showNotice(`Restored to version ${version}.`);
    onBack();
  };

  if (versionSnapshot === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2Icon className="size-5 animate-spin" />
      </div>
    );
  }
  if (versionSnapshot === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm text-muted-foreground">This version isn&apos;t available.</p>
        <Button variant="outline" size="sm" onClick={onBack}>
          Back to history
        </Button>
      </div>
    );
  }

  const isHeadVersion = version === versionSnapshot.headVersion;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="history-preview-pane">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon-sm" aria-label="Back to history list" onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        <p className="text-xs font-medium" data-testid="history-preview-banner">
          Viewing version {version} of {versionSnapshot.headVersion}
        </p>
      </div>
      {/* scrollbar-visible: a tall email must LOOK scrollable (overlay
          scrollbars hide until scrolled); draws nothing when it fits. */}
      <div className="scrollbar-visible min-h-0 flex-1 overflow-y-auto p-3">
        <ReadOnlyEmailPreview doc={versionSnapshot.doc as EmailDocument} />
      </div>
      <div className="flex flex-col gap-2 border-t p-3">
        {restorePhase.name === "failed" && (
          <p className="text-xs text-destructive" data-testid="history-restore-error">
            {restorePhase.message}
          </p>
        )}
        {isHeadVersion ? (
          <p className="text-center text-xs text-muted-foreground">
            This is the current version.
          </p>
        ) : (
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => {
              setRestorePhase({ name: "idle" });
              setIsConfirmOpen(true);
            }}
            data-testid="history-restore-button"
          >
            <HistoryIcon className="size-4" />
            Restore this version
          </Button>
        )}
      </div>

      <Dialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Restore to version {version}?</DialogTitle>
            <DialogDescription>
              Later edits stay in history and this action can be undone.
            </DialogDescription>
          </DialogHeader>
          {restorePhase.name === "failed" && (
            <p className="text-xs text-destructive">{restorePhase.message}</p>
          )}
          <DialogFooter>
            <DialogClose
              render={<Button variant="outline" size="sm" />}
              disabled={restorePhase.name === "restoring"}
            >
              Cancel
            </DialogClose>
            <Button
              size="sm"
              onClick={() => void handleRestore()}
              disabled={restorePhase.name === "restoring"}
              data-testid="history-restore-confirm"
            >
              {restorePhase.name === "restoring" && (
                <Loader2Icon className="size-4 animate-spin" />
              )}
              Restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
