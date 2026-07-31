"use client";

import { EMPTY_SECTION_ITEM, PALETTE_GROUPS, SECTION_GALLERY } from "./palette-items";
import { PaletteTile } from "./PaletteTile";
import { useClickToAdd } from "./use-click-to-add";

/**
 * The Blocks tab of the right rail: the full add-blocks palette — Content and
 * Layout block tiles, then the categorized Sections gallery (blank section
 * first, then ready-made templates grouped Headers → Heroes → Body → Social
 * proof → Footers). Block tiles drag onto the active draft (section templates
 * click-to-add only in v1) with click-to-add as the uniform fallback. THE
 * single add-blocks surface — the old per-section ghost "+ Add block" menu is
 * gone; only the doc-foot "Add section" pill remains on the canvas.
 */
export function AddBlocksPanel() {
  const addPaletteItem = useClickToAdd();
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
      <section className="flex flex-col gap-1.5" data-testid="section-gallery">
        <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Sections
        </h3>
        <div className="grid grid-cols-2 gap-1.5">
          <PaletteTile item={EMPTY_SECTION_ITEM} onAdd={addPaletteItem} />
        </div>
        {SECTION_GALLERY.map((category) => (
          <div key={category.id} className="flex flex-col gap-1.5">
            <h4 className="px-1 pt-1.5 text-[11px] font-medium text-muted-foreground/80">
              {category.label}
            </h4>
            <div className="grid grid-cols-2 gap-1.5">
              {category.items.map((item) => (
                <PaletteTile key={item.id} item={item} onAdd={addPaletteItem} />
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
