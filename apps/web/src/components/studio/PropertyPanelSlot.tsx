"use client";

import { useEditorStore } from "@/lib/editor-store";

/**
 * Wave-2 seam: the right sidebar where the property panel mounts. Selection
 * state already lives in the store (selectedBlockId); wave 2 replaces this
 * component's body with the field editor for the selected block.
 */
export function PropertyPanelSlot() {
  const selectedBlockId = useEditorStore((state) => state.selectedBlockId);
  const selectedBlock = useEditorStore((state) =>
    state.selectedBlockId !== null ? state.doc[state.selectedBlockId] : undefined,
  );

  if (selectedBlockId === null || selectedBlock === undefined) {
    return null;
  }

  return (
    <aside
      data-slot="property-panel"
      className="flex w-[280px] shrink-0 flex-col border-l bg-background"
    >
      <div className="flex h-12 shrink-0 items-center border-b px-4">
        <h2 className="text-sm font-semibold capitalize">{selectedBlock.type}</h2>
        <span className="ml-2 font-mono text-xs text-muted-foreground">{selectedBlockId}</span>
      </div>
      <div className="p-4">
        <p className="text-xs text-muted-foreground">
          Property editing arrives in wave 2.
        </p>
      </div>
    </aside>
  );
}
