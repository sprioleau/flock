"use client";

import { MinusIcon, ImageIcon, PlusIcon, SquareMousePointerIcon, TypeIcon } from "lucide-react";
import type { BlockId, LeafBlockType } from "@tandem/email-sdk";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEditorStore } from "@/lib/editor-store";
import { createDefaultLeafBlock, generateUniqueBlockId } from "./block-defaults";

export interface AddBlockMenuProps {
  /** The section (or column) the new block is appended to. */
  parentId: BlockId;
}

const LEAF_BLOCK_CHOICES: Array<{ type: LeafBlockType; label: string; Icon: typeof TypeIcon }> = [
  { type: "text", label: "Text", Icon: TypeIcon },
  { type: "button", label: "Button", Icon: SquareMousePointerIcon },
  { type: "image", label: "Image", Icon: ImageIcon },
  { type: "divider", label: "Divider", Icon: MinusIcon },
];

/**
 * The add-block affordance rendered at the foot of each section: a "+" menu
 * offering text / button / image / divider. Selecting one dispatches an
 * addBlock op (fresh generateBlockId, default properties) appending to the
 * parent's children.
 */
export function AddBlockMenu({ parentId }: AddBlockMenuProps) {
  const dispatch = useEditorStore((state) => state.dispatch);

  const addBlock = (type: LeafBlockType) => {
    const { doc } = useEditorStore.getState();
    const parent = doc[parentId];
    if (parent === undefined) {
      return;
    }
    const id = generateUniqueBlockId({ type, doc });
    dispatch({
      name: "addBlock",
      block: createDefaultLeafBlock({ type, id, parentId, doc }),
      parentId,
      index: parent.childrenIds.length,
    });
  };

  return (
    <div className="flex justify-center py-1" onClick={(event) => event.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs text-muted-foreground opacity-40 transition-opacity hover:opacity-100"
              aria-label={`Add block to ${parentId}`}
            />
          }
        >
          <PlusIcon className="size-3.5" />
          Add block
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-36">
          {LEAF_BLOCK_CHOICES.map(({ type, label, Icon }) => (
            <DropdownMenuItem key={type} onClick={() => addBlock(type)}>
              <Icon />
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
