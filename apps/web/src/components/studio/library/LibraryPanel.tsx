"use client";

import { useRef, useState } from "react";
import { useQuery } from "convex/react";
import { ImagesIcon, LinkIcon, Loader2, Upload } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/lib/editor-store";
import { useUiSurfaceOpenRequest } from "@/lib/ui-surfaces";
import { scrollBlockIntoView } from "../add-blocks/scroll-block-into-view";
import { formatRelativeTime } from "../history/history-grouping";
import { buildLibraryInsertPlan } from "./library-insert";
import { useUploadImageAsset } from "./use-upload-image-asset";

/**
 * Content Studio Stage S — the session's asset library (proposal §8; the
 * USER-FACING name is "Asset Library", "Library" as the compact button
 * label — "Content Studio" is the internal stage name and never appears in
 * UI): a header "Library" button beside the Brand kit trigger (both are
 * USER-level surfaces, not draft-level) opening the standard centered modal. Every
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
  const { isUploading, uploadImageAsset } = useUploadImageAsset();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [isImportPopoverOpen, setIsImportPopoverOpen] = useState(false);
  const [importUrlDraft, setImportUrlDraft] = useState("");
  const [isImporting, setIsImporting] = useState(false);

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
      setIsImportPopoverOpen(false);
      setImportUrlDraft("");
    }
  };

  // Agent-parity: the chat's openPanel("library") command opens this dialog
  // through the same reset-on-open path as a human click.
  useUiSurfaceOpenRequest("library", () => handleOpenChange(true));

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

  // Pure library add — the shared upload path registers the asset and
  // Convex reactivity lands it in the grid. Deliberately NO block mutation:
  // even in pick mode (image block selected) an upload only fills the
  // library; inserting stays a separate, explicit click.
  const uploadFilesToLibrary = async (files: readonly File[]): Promise<void> => {
    let uploadedCount = 0;
    for (const file of files) {
      try {
        await uploadImageAsset(file);
        uploadedCount += 1;
      } catch (error) {
        toast.error(`Couldn't upload ${file.name}`, {
          description: error instanceof Error ? error.message : undefined,
        });
      }
    }
    if (uploadedCount === 0) {
      return;
    }
    // A filter that would hide the fresh upload defeats "it appears right
    // away" — widen to All so the new asset is visible immediately.
    setKindFilter((current) => (current === "all" || current === "uploaded" ? current : "all"));
    toast.success(
      uploadedCount === 1
        ? "Image added to your library"
        : `${uploadedCount} images added to your library`,
    );
  };

  // "From URL": the /api/library/import-image route fetches the external
  // image SERVER-side (client fetch = CORS), rehosts the bytes into Convex
  // storage, and registers the asset — the grid row's src is OUR durable
  // Convex URL, never the external one. Reactivity lands it in the grid.
  const importImageFromUrl = async (): Promise<void> => {
    const trimmedUrl = importUrlDraft.trim();
    if (trimmedUrl === "" || sessionId === null || isImporting) {
      return;
    }
    setIsImporting(true);
    try {
      const response = await fetch("/api/library/import-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, url: trimmedUrl }),
      });
      const payload = (await response.json().catch(() => null)) as {
        isOk: boolean;
        message?: string;
      } | null;
      if (payload === null || !payload.isOk) {
        toast.error("Couldn't import that image", {
          description: payload?.message ?? "Something went wrong — please try again.",
        });
        return;
      }
      setKindFilter((current) => (current === "all" || current === "uploaded" ? current : "all"));
      setImportUrlDraft("");
      setIsImportPopoverOpen(false);
      toast.success("Image imported to your library");
    } catch {
      toast.error("Couldn't import that image", {
        description: "Something went wrong — please try again.",
      });
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {/* Tooltip + dialog trigger on ONE element (base-ui render composition)
          — below xl the trigger is icon-only, so hover carries the label. */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <DialogTrigger
                render={
                  <Button variant="outline" size="sm" className="gap-1.5" aria-label="Asset Library" />
                }
                data-testid="library-open-button"
              >
                <ImagesIcon className="size-4" />
                {/* Narrow-width degradation: icon-only below xl, matching
                    Brand kit. */}
                <span className="hidden xl:inline">Library</span>
              </DialogTrigger>
            }
          />
          <TooltipContent side="bottom">Asset Library</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DialogContent className="sm:max-w-xl" data-testid="library-panel">
        <DialogHeader>
          <DialogTitle>Asset Library</DialogTitle>
          <DialogDescription>
            Every image you upload or generate, in one place — one library per browser.
          </DialogDescription>
        </DialogHeader>

        {/* One header row over the grid: kind filters on the left, Upload on
            the right — the library's own way in for new images (same shared
            upload path as the property panel, but a pure library add: no
            block's src is touched). */}
        <div className="flex flex-wrap items-center gap-1">
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Filter by kind"
          >
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
          <input
            ref={uploadInputRef}
            type="file"
            accept="image/*"
            multiple
            aria-label="Choose image files to upload"
            tabIndex={-1}
            className="hidden"
            data-testid="library-upload-file-input"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              // Allow re-selecting the same file(s) later.
              event.target.value = "";
              if (files.length > 0) {
                void uploadFilesToLibrary(files);
              }
            }}
          />
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs"
              disabled={isUploading}
              aria-label="Upload image to your library"
              data-testid="library-upload-button"
              onClick={() => uploadInputRef.current?.click()}
            >
              {isUploading ? (
                <Loader2 className="animate-spin" data-testid="library-upload-spinner" />
              ) : (
                <Upload />
              )}
              {isUploading ? "Uploading…" : "Upload image"}
            </Button>
            <Popover open={isImportPopoverOpen} onOpenChange={setIsImportPopoverOpen}>
              <PopoverTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 px-2.5 text-xs"
                    aria-label="Import image from a URL"
                  />
                }
                data-testid="library-import-url-button"
              >
                <LinkIcon />
                From URL
              </PopoverTrigger>
              <PopoverContent
                className="w-80 space-y-2"
                align="end"
                data-testid="library-import-url-popover"
              >
                <Label
                  htmlFor="library-import-url-input"
                  className="text-xs text-muted-foreground"
                >
                  Image URL
                </Label>
                <div className="flex gap-1.5">
                  <Input
                    id="library-import-url-input"
                    value={importUrlDraft}
                    placeholder="https://…"
                    className="h-7 font-mono text-xs"
                    aria-label="Image URL to import"
                    onChange={(event) => setImportUrlDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void importImageFromUrl();
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    className="h-7 shrink-0"
                    disabled={isImporting || importUrlDraft.trim() === ""}
                    aria-label="Import this image into your library"
                    data-testid="library-import-url-submit"
                    onClick={() => void importImageFromUrl()}
                  >
                    {isImporting ? (
                      <Loader2 className="animate-spin" data-testid="library-import-spinner" />
                    ) : null}
                    {isImporting ? "Importing…" : "Import"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  We copy the image into your library, so it keeps working even if the original
                  link goes away.
                </p>
              </PopoverContent>
            </Popover>
          </div>
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
