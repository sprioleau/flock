"use client";

import { Fragment } from "react";
import { useEditorStore } from "@/lib/editor-store";
import { getAncestorIds } from "@/lib/get-ancestor-ids";
import { PropertyPanel } from "./property-panel/PropertyPanel";

/**
 * The right sidebar hosting the property panel. With a selection it edits the
 * selected block's properties; with no selection it shows document settings
 * (the root block's global styles). All edits dispatch SDK operations through
 * the store — the panel never touches the document directly.
 *
 * The header echoes the canvas ancestor stack as a horizontal breadcrumb
 * ("Section › Row › Column › Button") — always legible at the panel's fixed
 * width, with each ancestor clickable to select it.
 */
export function PropertyPanelSlot() {
  const doc = useEditorStore((state) => state.doc);
  const selectedBlockId = useEditorStore((state) => state.selectedBlockId);
  const selectedBlock = useEditorStore((state) =>
    state.selectedBlockId !== null ? state.doc[state.selectedBlockId] : undefined,
  );
  const selectBlock = useEditorStore((state) => state.selectBlock);

  const hasSelection = selectedBlockId !== null && selectedBlock !== undefined;

  return (
    <aside
      data-slot="property-panel"
      className="flex w-[280px] shrink-0 flex-col border-l bg-background"
    >
      <div className="flex h-12 shrink-0 items-center border-b px-4">
        {hasSelection ? (
          <nav
            aria-label="Selected block ancestors"
            className="flex min-w-0 items-baseline"
            data-testid="panel-breadcrumb"
          >
            {getAncestorIds({ doc, blockId: selectedBlockId }).map((ancestorId) => (
              <Fragment key={ancestorId}>
                <button
                  type="button"
                  onClick={() => selectBlock(ancestorId)}
                  className="cursor-pointer text-xs capitalize text-muted-foreground hover:text-foreground hover:underline"
                >
                  {doc[ancestorId]?.type}
                </button>
                <span aria-hidden className="px-1 text-xs text-muted-foreground/60">
                  ›
                </span>
              </Fragment>
            ))}
            {/* Block ids are internal — the header shows only the type. */}
            <h2 className="text-sm font-semibold capitalize">{selectedBlock.type}</h2>
          </nav>
        ) : (
          <>
            <h2 className="text-sm font-semibold">Document</h2>
            <span className="ml-2 text-xs text-muted-foreground">Global styles</span>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PropertyPanel key={selectedBlockId ?? "document"} block={selectedBlock} />
      </div>
    </aside>
  );
}
