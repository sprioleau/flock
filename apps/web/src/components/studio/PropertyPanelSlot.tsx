"use client";

import { Fragment, useState } from "react";
import { PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useEditorStore } from "@/lib/editor-store";
import { getAncestorIds } from "@/lib/get-ancestor-ids";
import { cn } from "@/lib/utils";
import { AddBlocksPanel } from "./add-blocks/AddBlocksPanel";
import { useCanvasDragStore } from "./dnd/drag-drop-store";
import { updatePanelPreferences, usePanelPreferences } from "./panel-preferences";
import { PropertyPanel } from "./property-panel/PropertyPanel";
import { ShortcutKbd } from "./shortcuts/ShortcutKbd";

/**
 * The right rail: a two-tab panel — BLOCKS (the add-blocks palette, §8.1
 * owner decision: the palette lives here, not in a left rail) and
 * PROPERTIES (the selection-driven property panel; document settings with no
 * selection).
 *
 * Tab semantics: Blocks is the landing tab (browse what's available);
 * selecting a block auto-switches to Properties, and deselecting (clicking
 * the canvas or frames-surface background, Escape) switches back to Blocks —
 * the add-then-tweak loop in both directions. NEITHER switch fires while a
 * drag is live, so the Blocks tab never unmounts its own active drag source
 * mid-gesture. The post-drop selection lands after the gesture ends, which
 * is what flips the rail to Properties.
 *
 * Collapsible like the chat panel (same animated width + cross-fade, same
 * persisted-preference plumbing — panel-preferences.ts; ⌘\ toggles via
 * StudioShortcuts). Expanded by default: the palette is the primary add
 * affordance. The body stays MOUNTED while collapsed (fixed inner width,
 * hidden + unreachable), so tab state and the palette's drag sources survive
 * a collapse exactly like the chat panel's message list does.
 */
type RightRailTab = "blocks" | "properties";

const EXPANDED_WIDTH_PX = 280;
const COLLAPSED_WIDTH_PX = 48;

export function PropertyPanelSlot() {
  const [activeTab, setActiveTab] = useState<RightRailTab>("blocks");
  const selectedBlockId = useEditorStore((state) => state.selectedBlockId);
  const isExpanded = usePanelPreferences().isRightRailExpanded;
  const setIsExpanded = (nextIsExpanded: boolean): void => {
    updatePanelPreferences({ isRightRailExpanded: nextIsExpanded });
  };

  // Adjust-state-during-render (the React "derive from props" pattern, no
  // effect): a NEW selection flips the rail to Properties, and a DESELECT
  // (canvas-background click, Escape) flips it back to Blocks so adding is
  // immediately available — the two halves of the add-then-tweak loop.
  // Neither fires while a drag is live: the Blocks tab must never unmount
  // its own active drag source mid-gesture.
  const [lastSeenSelectedBlockId, setLastSeenSelectedBlockId] = useState(selectedBlockId);
  if (selectedBlockId !== lastSeenSelectedBlockId) {
    setLastSeenSelectedBlockId(selectedBlockId);
    if (useCanvasDragStore.getState().dragSource === null) {
      setActiveTab(selectedBlockId !== null ? "properties" : "blocks");
    }
  }

  return (
    <aside
      data-slot="right-rail"
      className="relative shrink-0 overflow-hidden border-l bg-background transition-[width] duration-300 ease-in-out"
      style={{ width: isExpanded ? EXPANDED_WIDTH_PX : COLLAPSED_WIDTH_PX }}
    >
      {/* Collapsed rail */}
      <div
        className={cn(
          "absolute inset-y-0 right-0 flex w-12 flex-col items-center py-3 transition-opacity duration-200",
          isExpanded ? "pointer-events-none opacity-0" : "opacity-100 delay-100",
        )}
        aria-hidden={isExpanded}
      >
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Expand blocks and properties panel"
                  tabIndex={isExpanded ? -1 : 0}
                  onClick={() => setIsExpanded(true)}
                  data-testid="right-rail-expand"
                />
              }
            >
              <PanelRightOpenIcon />
            </TooltipTrigger>
            <TooltipContent side="left">
              Open blocks &amp; properties <ShortcutKbd shortcutId="toggleRightRail" />
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Expanded body (fixed inner width so content never reflows mid-animation) */}
      <div
        className={cn(
          "flex h-full flex-col transition-opacity duration-200",
          isExpanded ? "opacity-100 delay-100" : "pointer-events-none opacity-0",
        )}
        style={{ width: EXPANDED_WIDTH_PX }}
        aria-hidden={!isExpanded}
      >
        <div className="flex h-12 shrink-0 items-stretch gap-1 border-b px-2 pt-2">
          <div role="tablist" aria-label="Editor panel" className="flex flex-1 items-stretch gap-1">
            <RightRailTabButton
              label="Blocks"
              isActive={activeTab === "blocks"}
              isReachable={isExpanded}
              onSelect={() => setActiveTab("blocks")}
            />
            <RightRailTabButton
              label="Properties"
              isActive={activeTab === "properties"}
              isReachable={isExpanded}
              onSelect={() => setActiveTab("properties")}
            />
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Collapse blocks and properties panel"
                    tabIndex={isExpanded ? 0 : -1}
                    onClick={() => setIsExpanded(false)}
                    className="self-center"
                    data-testid="right-rail-collapse"
                  />
                }
              >
                <PanelRightCloseIcon />
              </TooltipTrigger>
              <TooltipContent side="left">
                Collapse <ShortcutKbd shortcutId="toggleRightRail" />
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" role="tabpanel">
          {activeTab === "blocks" ? <AddBlocksPanel /> : <PropertiesTab />}
        </div>
      </div>
    </aside>
  );
}

function RightRailTabButton({
  label,
  isActive,
  isReachable,
  onSelect,
}: {
  label: string;
  isActive: boolean;
  /** False while the rail is collapsed — hidden tabs leave the tab order. */
  isReachable: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      tabIndex={isReachable ? 0 : -1}
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
