"use client";

import { useMemo } from "react";
import { PlusIcon } from "lucide-react";
import { inflate, resolveRootBlockStyles, ROOT_BLOCK_ID } from "@tandem/email-sdk";
import { Button } from "@/components/ui/button";
import { useEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";
import { createDefaultSection, generateUniqueBlockId } from "./block-defaults";
import { CanvasNode } from "./CanvasNode";
import { CanvasDndContext } from "./dnd/CanvasDndContext";
import { PersonaCursorOverlay } from "./presence/PersonaCursorOverlay";
import { PointerPresenceOverlay } from "./presence/PointerPresenceOverlay";

/**
 * The editing canvas: the store's document inflated and rendered through the
 * SDK's block views (visual parity with the email HTML), wrapped in
 * interactive shells. Rendered in-page — the sandboxed iframe lives in the
 * HTML preview dialog. Clicking empty canvas clears the selection.
 *
 * Layout mirrors the emitted email: the email surface (emailBackgroundColor)
 * spans the full canvas width so each section's outer band renders
 * full-bleed, with only the section's inner Container centered at
 * contentWidth (SectionBlockView). The mobile toggle bounds the whole
 * surface to a 375px frame — outer bands then fill the frame.
 */
export function EditorCanvas() {
  const doc = useEditorStore((state) => state.doc);
  const viewport = useEditorStore((state) => state.viewport);
  const selectBlock = useEditorStore((state) => state.selectBlock);
  const dispatch = useEditorStore((state) => state.dispatch);

  const tree = useMemo(() => inflate(doc), [doc]);
  const rootStyles = resolveRootBlockStyles(tree.block);
  const globals = tree.block.properties.globals;

  const addSection = () => {
    const root = doc[ROOT_BLOCK_ID];
    if (root === undefined) {
      return;
    }
    const id = generateUniqueBlockId({ type: "section", doc });
    dispatch({
      name: "addSection",
      section: createDefaultSection(id),
      index: root.childrenIds.length,
    });
  };

  return (
    <CanvasDndContext>
      <div
        className="email-canvas flex-1 overflow-y-auto bg-neutral-200/70"
        onClick={() => selectBlock(null)}
        data-testid="editor-canvas"
      >
        <div
          className={cn(
            "relative mx-auto flex min-h-full flex-col pt-10 transition-[width] duration-200",
            viewport === "mobile" ? "w-[375px] shadow-lg" : "w-full",
          )}
          style={{ backgroundColor: rootStyles.emailBackgroundColor }}
          data-viewport={viewport}
          data-dnd-canvas-root
        >
          {tree.children.map((child) => (
            <CanvasNode key={child.block.id} node={child} globals={globals} />
          ))}
          <div className="flex flex-1 items-start justify-center py-6">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={(event) => {
                event.stopPropagation();
                addSection();
              }}
            >
              <PlusIcon className="size-4" />
              Add section
            </Button>
          </div>
          {/* Persona cursors (multi-agent v1): simulated advisory-persona
              mice, choreographed client-side from the reactive findings query
              + persona presence status. Before the human overlay so human
              cursors paint on top. */}
          <PersonaCursorOverlay />
          {/* Pointer presence (remote cursors + local capture): inside the
              canvas root so cursors live in content space — scrolling and
              scrollport clipping come for free. */}
          <PointerPresenceOverlay />
        </div>
      </div>
    </CanvasDndContext>
  );
}
