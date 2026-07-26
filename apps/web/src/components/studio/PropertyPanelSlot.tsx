"use client";

import { useEditorStore } from "@/lib/editor-store";
import { PropertyPanel } from "./property-panel/PropertyPanel";

/**
 * The right sidebar hosting the property panel. With a selection it edits the
 * selected block's properties; with no selection it shows document settings
 * (the root block's global styles). All edits dispatch SDK operations through
 * the store — the panel never touches the document directly.
 */
export function PropertyPanelSlot() {
  const selectedBlockId = useEditorStore((state) => state.selectedBlockId);
  const selectedBlock = useEditorStore((state) =>
    state.selectedBlockId !== null ? state.doc[state.selectedBlockId] : undefined,
  );

  const hasSelection = selectedBlock !== undefined;

  return (
    <aside
      data-slot="property-panel"
      className="flex w-[280px] shrink-0 flex-col border-l bg-background"
    >
      <div className="flex h-12 shrink-0 items-center border-b px-4">
        <h2 className="text-sm font-semibold capitalize">
          {hasSelection ? selectedBlock.type : "Document"}
        </h2>
        {hasSelection ? (
          <span className="ml-2 font-mono text-xs text-muted-foreground">{selectedBlockId}</span>
        ) : (
          <span className="ml-2 text-xs text-muted-foreground">Global styles</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PropertyPanel key={selectedBlockId ?? "document"} block={selectedBlock} />
      </div>
    </aside>
  );
}
