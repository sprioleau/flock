"use client";

import { useMemo } from "react";
import { PlusIcon } from "lucide-react";
import { inflate, resolveRootBlockStyles, ROOT_BLOCK_ID } from "@tandem/email-sdk";
import { Button } from "@/components/ui/button";
import { useEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";
import { createDefaultSection, generateUniqueBlockId } from "./block-defaults";
import { CanvasNode } from "./CanvasNode";

/**
 * The editing canvas: the store's document inflated and rendered through the
 * SDK's block views (visual parity with the email HTML), wrapped in
 * interactive shells. Rendered in-page — the sandboxed iframe lives in the
 * HTML preview dialog. Clicking empty canvas clears the selection.
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
    <div
      className="email-canvas flex-1 overflow-y-auto"
      style={{ backgroundColor: rootStyles.emailBackgroundColor }}
      onClick={() => selectBlock(null)}
      data-testid="editor-canvas"
    >
      <div
        className={cn(
          "mx-auto px-6 py-10 transition-[width] duration-200",
          viewport === "mobile" ? "w-[375px] px-2" : "w-full max-w-[760px]",
        )}
        data-viewport={viewport}
      >
        {tree.children.map((child) => (
          <CanvasNode key={child.block.id} node={child} globals={globals} />
        ))}
        <div className="flex justify-center pt-6">
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
      </div>
    </div>
  );
}
