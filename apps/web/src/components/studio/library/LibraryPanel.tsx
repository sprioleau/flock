"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { ImagesIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/lib/editor-store";
import { scrollBlockIntoView } from "../add-blocks/scroll-block-into-view";
import { formatRelativeTime } from "../history/history-grouping";
import { buildLibraryInsertPlan } from "./library-insert";

/**
 * Content Studio Stage S — the session's asset library (proposal §8): a
 * header "Library" button beside the Brand kit trigger (both are USER-level
 * surfaces, not draft-level) opening the standard centered modal. Every
 * image the session uploads, generates, or confirms from a brand kit lands
 * here automatically at upload time (assets.register — the one seam), so
 * "the image I uploaded yesterday" is one click away in any canvas.
 *
 * v1 scope: reactive grid (thumbnail, name, kind chip, relative time), kind
 * filter chips, and insert-into-draft — a src swap on the selected image
 * block, else a new image block per the add-blocks placement rules (see
 * library-insert.ts). Rename/delete are Stage M.
 */

type LibraryAsset = Doc<"assets">;
type AssetKind = LibraryAsset["kind"];
type KindFilter = "all" | AssetKind;

const KIND_LABELS: Record<AssetKind, string> = {
  uploaded: "Uploaded",
  generated: "Generated",
  logo: "Logo",
  "social-card": "Social card",
};

const FILTER_CHIPS: readonly { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "uploaded", label: "Uploaded" },
  { value: "generated", label: "Generated" },
  { value: "logo", label: "Logos" },
  { value: "social-card", label: "Social cards" },
];

/** "84 KB" / "1.2 MB" — compact size for the selection summary. */
function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function LibraryPanel() {
  const sessionId = useEditorStore((state) => state.authorId);
  const isImageBlockSelected = useEditorStore(
    (state) =>
      state.selectedBlockId !== null && state.doc[state.selectedBlockId]?.type === "image",
  );

  const [isOpen, setIsOpen] = useState(false);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [selectedAssetId, setSelectedAssetId] = useState<Id<"assets"> | null>(null);

  // Reactive: an upload/generation/confirm in any tab appears here live.
  const assets = useQuery(
    api.assets.listForSession,
    sessionId === null ? "skip" : { sessionId },
  );
  const isLoading = sessionId === null || assets === undefined;
  const visibleAssets = (assets ?? []).filter(
    (asset) => kindFilter === "all" || asset.kind === kindFilter,
  );
  const selectedAsset = visibleAssets.find((asset) => asset._id === selectedAssetId) ?? null;

  const handleOpenChange = (nextIsOpen: boolean): void => {
    setIsOpen(nextIsOpen);
    if (nextIsOpen) {
      setKindFilter("all");
      setSelectedAssetId(null);
    }
  };

  const insertAsset = (asset: LibraryAsset): void => {
    const editorStore = useEditorStore.getState();
    const plan = buildLibraryInsertPlan({
      doc: editorStore.doc,
      selectedBlockId: editorStore.selectedBlockId,
      asset: { url: asset.url, name: asset.name, alt: asset.alt },
    });
    if (plan === null) {
      return;
    }
    const result = editorStore.dispatch(plan.op);
    if (!result.isOk) {
      return;
    }
    if (plan.targetBlockId !== null) {
      editorStore.selectBlock(plan.targetBlockId);
      scrollBlockIntoView(plan.targetBlockId);
    }
    // Close so the draft (and the fresh image) is immediately visible.
    setIsOpen(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            aria-label="Library"
            title="Library"
          />
        }
        data-testid="library-open-button"
      >
        <ImagesIcon className="size-4" />
        {/* Narrow-width degradation: icon-only below xl, matching Brand kit. */}
        <span className="hidden xl:inline">Library</span>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl" data-testid="library-panel">
        <DialogHeader>
          <DialogTitle>Library</DialogTitle>
          <DialogDescription>
            Every image you upload or generate, in one place — one library per browser.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by kind">
          {FILTER_CHIPS.map((chip) => (
            <Button
              key={chip.value}
              variant={kindFilter === chip.value ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              aria-pressed={kindFilter === chip.value}
              onClick={() => setKindFilter(chip.value)}
              data-testid={`library-filter-${chip.value}`}
            >
              {chip.label}
            </Button>
          ))}
        </div>

        <div className="max-h-[50vh] min-h-32 overflow-y-auto">
          {isLoading ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Loading your library…</p>
          ) : visibleAssets.length === 0 ? (
            <p
              className="mx-auto max-w-sm py-10 text-center text-sm text-muted-foreground"
              data-testid="library-empty"
            >
              {kindFilter === "all"
                ? "Nothing here yet — images you upload or generate land in your library automatically."
                : `No ${KIND_LABELS[kindFilter].toLowerCase()} images yet.`}
            </p>
          ) : (
            <ul className="grid grid-cols-3 gap-2">
              {visibleAssets.map((asset) => (
                <li key={asset._id}>
                  <button
                    type="button"
                    onClick={() => setSelectedAssetId(asset._id)}
                    onDoubleClick={() => insertAsset(asset)}
                    aria-pressed={selectedAssetId === asset._id}
                    aria-label={`${asset.name} (${KIND_LABELS[asset.kind]})`}
                    className={cn(
                      "flex w-full flex-col overflow-hidden rounded-lg border text-left transition-colors hover:bg-accent",
                      selectedAssetId === asset._id && "ring-2 ring-ring",
                    )}
                    data-testid={`library-asset-${asset._id}`}
                  >
                    {/* Plain <img>: Convex storage serving URLs — next/image
                        can't optimize them, and the file IS the thumbnail. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={asset.url}
                      alt=""
                      loading="lazy"
                      className="aspect-video w-full bg-muted object-cover"
                    />
                    <span className="flex flex-col gap-0.5 p-1.5">
                      <span className="truncate text-xs font-medium">{asset.name}</span>
                      <span className="flex items-center gap-1">
                        <span className="shrink-0 rounded-full border bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                          {KIND_LABELS[asset.kind]}
                        </span>
                        <span className="truncate text-[10px] text-muted-foreground">
                          {formatRelativeTime(asset.createdAtMs)}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <p className="min-w-0 truncate text-xs text-muted-foreground" data-testid="library-selection-summary">
            {selectedAsset === null
              ? "Select an image to insert it into your draft."
              : [
                  selectedAsset.name,
                  selectedAsset.sizeBytes === undefined
                    ? null
                    : formatFileSize(selectedAsset.sizeBytes),
                  selectedAsset.mimeType?.split("/")[1]?.toUpperCase() ?? null,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
          </p>
          <Button
            size="sm"
            className="shrink-0"
            disabled={selectedAsset === null}
            onClick={() => {
              if (selectedAsset !== null) {
                insertAsset(selectedAsset);
              }
            }}
            data-testid="library-insert-button"
          >
            {isImageBlockSelected ? "Insert into selected image" : "Add to draft"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
