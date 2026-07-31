"use client";

import { PALETTE_GROUPS } from "./palette-items";
import { PaletteTile } from "./PaletteTile";
import { useClickToAdd } from "./use-click-to-add";

/**
 * The Blocks tab of the right rail: the full add-blocks palette (Content /
 * Layout / Sections), each tile draggable onto the active draft (section
 * templates click-to-add only in v1) with click-to-add as the uniform
 * fallback. THE single add-blocks surface — the old per-section ghost
 * "+ Add block" menu is gone; only the doc-foot "Add section" pill remains
 * on the canvas.
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
    </div>
  );
}
