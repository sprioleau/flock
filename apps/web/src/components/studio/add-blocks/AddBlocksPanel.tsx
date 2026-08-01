"use client";

import { useState } from "react";
import { ArrowUpRightIcon, BookmarkIcon, ChevronLeftIcon, LayoutGridIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  EMPTY_SECTION_ITEM,
  PALETTE_GROUPS,
  SECTION_GALLERY,
  type PaletteItem,
} from "./palette-items";
import { PaletteTile } from "./PaletteTile";
import { SavedSectionsManagerDialog } from "./SavedSectionsManagerDialog";
import { SectionTemplatePreview } from "./SectionTemplatePreview";
import { useClickToAdd } from "./use-click-to-add";

/**
 * The Blocks tab of the right rail: the full add-blocks palette — Content and
 * Layout block tiles, then a three-entry Sections area (progressive
 * disclosure): "Empty section", "Section gallery", and "Saved" (the
 * session's saved reusable sections, managed in a modal). The gallery entry
 * drills into a second view of the panel (back affordance up top) listing
 * every catalog template by category — each tile draggable AND
 * click-to-add, exactly like every other palette item. A preview toggle
 * switches the gallery tiles to rendered miniatures styled with the active
 * draft's theme (SectionTemplatePreview); hovering an icon tile shows the
 * same miniature in a hover card. THE single add-blocks surface — the old
 * per-section ghost "+ Add block" menu is gone; only the doc-foot "Add
 * section" pill remains on the canvas.
 */
export function AddBlocksPanel() {
  const addPaletteItem = useClickToAdd();
  const [isGalleryOpen, setIsGalleryOpen] = useState(false);
  // Lifted above the gallery view so the choice survives drilling in and out.
  const [isPreviewModeOn, setIsPreviewModeOn] = useState(false);
  const [isSavedSectionsOpen, setIsSavedSectionsOpen] = useState(false);

  if (isGalleryOpen) {
    return (
      <SectionGalleryView
        isPreviewModeOn={isPreviewModeOn}
        onTogglePreviewMode={() => setIsPreviewModeOn((wasOn) => !wasOn)}
        onBack={() => setIsGalleryOpen(false)}
        onAdd={addPaletteItem}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 p-3" data-testid="add-blocks-panel">
      <p className="px-1 text-xs leading-relaxed text-muted-foreground">
        Drag a block onto the draft, or click to add it at the selection.
      </p>
      {PALETTE_GROUPS.map((group) => (
        <section key={group.label} className="flex flex-col gap-1.5">
          <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {group.label}
          </h3>
          <div className="grid grid-cols-2 gap-1.5">
            {group.items.map((item) => (
              <PaletteTile key={item.id} item={item} onAdd={addPaletteItem} />
            ))}
          </div>
        </section>
      ))}
      <section className="flex flex-col gap-1.5" data-testid="sections-area">
        <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Sections
        </h3>
        <div className="grid grid-cols-2 gap-1.5">
          <PaletteTile item={EMPTY_SECTION_ITEM} onAdd={addPaletteItem} />
          <button
            type="button"
            onClick={() => setIsGalleryOpen(true)}
            title="Browse ready-made sections by category."
            className={cn(
              // min-height matches PaletteTile so the Sections row stays even.
              "relative flex min-h-[3.75rem] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md border bg-background p-3 text-center transition-colors",
              "hover:border-ring/60 hover:bg-muted/60",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
            data-testid="open-section-gallery"
          >
            <LayoutGridIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="line-clamp-1 max-w-full text-xs font-medium leading-tight text-foreground">
              Section gallery
            </span>
            {/* Corner arrow (owner ask): reads as "takes you elsewhere in the
                app", not a plain disclosure — tucked in the top-right corner,
                clear of the centered icon+label even at narrow rail widths. */}
            <ArrowUpRightIcon
              className="absolute top-1 right-1 size-3 text-muted-foreground/70"
              aria-hidden
            />
          </button>
          {/* Saved sections live behind a card like the gallery (owner ask):
              same tile styling + corner arrow (reveals more UI, not
              draggable). Opens the saved-sections manager modal. */}
          <button
            type="button"
            onClick={() => setIsSavedSectionsOpen(true)}
            title="Reuse sections you saved from any draft."
            className={cn(
              // min-height matches PaletteTile so the Sections row stays even.
              "relative flex min-h-[3.75rem] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md border bg-background p-3 text-center transition-colors",
              "hover:border-ring/60 hover:bg-muted/60",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
            data-testid="open-saved-sections-manager"
          >
            <BookmarkIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="line-clamp-1 max-w-full text-xs font-medium leading-tight text-foreground">
              Saved
            </span>
            <ArrowUpRightIcon
              className="absolute top-1 right-1 size-3 text-muted-foreground/70"
              aria-hidden
            />
          </button>
        </div>
        <SavedSectionsManagerDialog
          isOpen={isSavedSectionsOpen}
          onOpenChange={setIsSavedSectionsOpen}
        />
      </section>
    </div>
  );
}

/**
 * The drilled-in gallery: back affordance, the preview-mode switch, then the
 * catalog templates grouped by category. Icon tiles get a themed hover-card
 * miniature; preview mode swaps every tile body for the miniature itself.
 * Previews render lazily — nothing is instantiated until preview mode turns
 * on or a hover card opens.
 */
function SectionGalleryView({
  isPreviewModeOn,
  onTogglePreviewMode,
  onBack,
  onAdd,
}: {
  isPreviewModeOn: boolean;
  onTogglePreviewMode: () => void;
  onBack: () => void;
  onAdd: (item: PaletteItem) => void;
}) {
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="section-gallery">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label="Back to all blocks"
          data-testid="section-gallery-back"
        >
          <ChevronLeftIcon />
        </Button>
        <h3 className="text-sm font-semibold">Section gallery</h3>
      </div>
      <div className="flex items-center justify-between px-1">
        <span id="gallery-preview-toggle-label" className="text-xs text-muted-foreground">
          Show previews in your email&apos;s style
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={isPreviewModeOn}
          aria-labelledby="gallery-preview-toggle-label"
          onClick={onTogglePreviewMode}
          className={cn(
            "relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isPreviewModeOn ? "bg-primary" : "bg-muted-foreground/30",
          )}
          data-testid="gallery-preview-toggle"
        >
          <span
            className={cn(
              "absolute top-0.5 left-0.5 size-4 rounded-full bg-background shadow-sm transition-transform",
              isPreviewModeOn && "translate-x-4",
            )}
            aria-hidden
          />
        </button>
      </div>
      <TooltipProvider delay={350}>
        {SECTION_GALLERY.map((category) => (
          <div key={category.id} className="flex flex-col gap-1.5">
            <h4 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {category.label}
            </h4>
            <div className={cn("grid gap-1.5", isPreviewModeOn ? "grid-cols-1" : "grid-cols-2")}>
              {category.items.map((item) =>
                isPreviewModeOn ? (
                  <PaletteTile
                    key={item.id}
                    item={item}
                    onAdd={onAdd}
                    previewBody={
                      item.kind === "section-template" ? (
                        <SectionTemplatePreview templateId={item.templateId} />
                      ) : undefined
                    }
                  />
                ) : (
                  <GalleryIconTile key={item.id} item={item} onAdd={onAdd} />
                ),
              )}
            </div>
          </div>
        ))}
      </TooltipProvider>
    </div>
  );
}

/**
 * Icon-mode gallery tile: the standard PaletteTile inside a hover-card
 * trigger whose tooltip shows the themed miniature. The trigger renders as a
 * plain wrapper div so the tile's own drag listeners and click-to-add stay
 * untouched; the card content only mounts while open (lazy).
 */
function GalleryIconTile({
  item,
  onAdd,
}: {
  item: PaletteItem;
  onAdd: (item: PaletteItem) => void;
}) {
  if (item.kind !== "section-template") {
    return <PaletteTile item={item} onAdd={onAdd} />;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<div className="flex min-w-0 flex-col" />}>
        <PaletteTile item={item} onAdd={onAdd} />
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={8} className="max-w-none p-1.5">
        <div className="w-64">
          <SectionTemplatePreview templateId={item.templateId} />
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
