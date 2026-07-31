"use client";

import { Fragment, useState } from "react";
import { useEditorStore } from "@/lib/editor-store";
import { getAncestorIds } from "@/lib/get-ancestor-ids";
import { cn } from "@/lib/utils";
import { AddBlocksPanel } from "./add-blocks/AddBlocksPanel";
import { useCanvasDragStore } from "./dnd/drag-drop-store";
import { PropertyPanel } from "./property-panel/PropertyPanel";

/**
 * The right rail: a two-tab panel — BLOCKS (the add-blocks palette, §8.1
 * owner decision: the palette lives here, not in a left rail) and
 * PROPERTIES (the selection-driven property panel; document settings with no
 * selection).
 *
 * Tab semantics: Blocks is the landing tab (browse what's available);
 * selecting a block auto-switches to Properties (the add-then-tweak loop) —
 * EXCEPT while a drag is live, so the Blocks tab never unmounts its own
 * active drag source mid-gesture. The post-drop selection lands after the
 * gesture ends, which is what flips the rail to Properties.
 */
type RightRailTab = "blocks" | "properties";

export function PropertyPanelSlot() {
  const [activeTab, setActiveTab] = useState<RightRailTab>("blocks");
  const selectedBlockId = useEditorStore((state) => state.selectedBlockId);

  // Adjust-state-during-render (the React "derive from props" pattern, no
  // effect): a NEW selection flips the rail to Properties unless a drag is
  // live — the Blocks tab must never unmount its own active drag source.
  const [lastSeenSelectedBlockId, setLastSeenSelectedBlockId] = useState(selectedBlockId);
  if (selectedBlockId !== lastSeenSelectedBlockId) {
    setLastSeenSelectedBlockId(selectedBlockId);
    if (selectedBlockId !== null && useCanvasDragStore.getState().dragSource === null) {
      setActiveTab("properties");
    }
  }

  return (
    <aside
      data-slot="right-rail"
      className="flex w-[280px] shrink-0 flex-col border-l bg-background"
    >
      <div
        role="tablist"
        aria-label="Editor panel"
        className="flex h-12 shrink-0 items-stretch gap-1 border-b px-2 pt-2"
      >
        <RightRailTabButton
          label="Blocks"
          isActive={activeTab === "blocks"}
          onSelect={() => setActiveTab("blocks")}
        />
        <RightRailTabButton
          label="Properties"
          isActive={activeTab === "properties"}
          onSelect={() => setActiveTab("properties")}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" role="tabpanel">
        {activeTab === "blocks" ? <AddBlocksPanel /> : <PropertiesTab />}
      </div>
    </aside>
  );
}

function RightRailTabButton({
  label,
  isActive,
  onSelect,
}: {
  label: string;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={onSelect}
      className={cn(
        "flex-1 cursor-pointer rounded-t-md border-b-2 px-3 text-sm font-medium transition-colors",
        isActive
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
      data-testid={`right-rail-tab-${label.toLowerCase()}`}
    >
      {label}
    </button>
  );
}

/**
 * The Properties tab: the ancestor-breadcrumb header ("Section › Row ›
 * Column › Button", each ancestor clickable) over the schema-driven property
 * panel. With no selection it shows document settings (the root block's
 * global styles). All edits dispatch SDK operations through the store — the
 * panel never touches the document directly.
 */
function PropertiesTab() {
  const doc = useEditorStore((state) => state.doc);
  const selectedBlockId = useEditorStore((state) => state.selectedBlockId);
  const selectedBlock = useEditorStore((state) =>
    state.selectedBlockId !== null ? state.doc[state.selectedBlockId] : undefined,
  );
  const selectBlock = useEditorStore((state) => state.selectBlock);

  const hasSelection = selectedBlockId !== null && selectedBlock !== undefined;

  return (
    <div data-slot="property-panel">
      <div className="flex h-10 items-center border-b px-4">
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
      <PropertyPanel key={selectedBlockId ?? "document"} block={selectedBlock} />
    </div>
  );
}
