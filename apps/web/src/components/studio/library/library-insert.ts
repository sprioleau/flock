import { ImageIcon } from "lucide-react";
import type { BlockId, EmailDocument } from "@flock/email-sdk";
import type { DispatchableOp } from "@/lib/editor-store";
import { buildClickToAddPlan } from "../add-blocks/click-to-add-placement";
import type { PaletteItem } from "../add-blocks/palette-items";

/*
  Library → draft insertion (Content Studio Stage S, proposal §7.2). Composes
  EXISTING ops only — the studio never grows a new operation:

  - an image block is selected → ONE `updateBlockProperties { src, alt }`,
    exactly what both generation flows dispatch (undoable as one step);
  - anything else (or nothing) selected → a NEW image block via the
    add-blocks click-to-add placement rules (after a selected leaf / into a
    selected container / appended to the last section / composed section on
    an empty document), with the asset's src+alt in place of the palette
    defaults — still one op, one undo.

  Alt text carries from the asset: its stored alt when present, else the
  asset's display name (QA personas flag missing alt — never insert without).

  Pure — unit-tested directly.
*/

/*
  What insertion needs to know about a library asset.
*/
export interface LibraryInsertAsset {
  url: string;
  name: string;
  alt?: string | undefined;
}

export interface LibraryInsertPlan {
  op: DispatchableOp;
  /*
    Which gesture this is — the panel's Insert button labels itself by it.
  */
  mode: "replace-selected-image" | "add-image-block";
  /*
    The block to select + reveal after dispatch.
  */
  targetBlockId: BlockId | null;
}

/*
  The palette descriptor the placement rules see for a library image.
*/
const LIBRARY_IMAGE_PALETTE_ITEM: PaletteItem = {
  kind: "leaf",
  blockType: "image",
  id: "library-image",
  label: "Image",
  description: "An image from your library.",
  Icon: ImageIcon,
};

/*
  The alt text an asset carries into the draft: stored alt, else its name.
*/
export function resolveInsertAltText(asset: LibraryInsertAsset): string {
  const trimmedAlt = asset.alt?.trim() ?? "";
  return trimmedAlt.length > 0 ? trimmedAlt : asset.name;
}

export function buildLibraryInsertPlan(args: {
  doc: EmailDocument;
  selectedBlockId: BlockId | null;
  asset: LibraryInsertAsset;
}): LibraryInsertPlan | null {
  const { doc, selectedBlockId, asset } = args;
  const alt = resolveInsertAltText(asset);

  const selected = selectedBlockId === null ? undefined : doc[selectedBlockId];
  if (selected !== undefined && selected.type === "image") {
    return {
      op: {
        name: "updateBlockProperties",
        blockId: selected.id,
        properties: { src: asset.url, alt },
      },
      mode: "replace-selected-image",
      targetBlockId: selected.id,
    };
  }

  const plan = buildClickToAddPlan({
    doc,
    item: LIBRARY_IMAGE_PALETTE_ITEM,
    selectedBlockId,
  });
  if (plan === null || plan.newBlockId === null) {
    return null;
  }
  return {
    op: overrideNewImageProperties({ op: plan.op, imageBlockId: plan.newBlockId, src: asset.url, alt }),
    mode: "add-image-block",
    targetBlockId: plan.newBlockId,
  };
}

/*
  Swap the placement plan's palette-default image properties (placeholder
  src/alt) for the asset's, wherever the new leaf lives in the op: directly
  on an `addBlock`, or inside the composed `addSection`'s children on an
  empty document.
*/
function overrideNewImageProperties(args: {
  op: DispatchableOp;
  imageBlockId: BlockId;
  src: string;
  alt: string;
}): DispatchableOp {
  const { op, imageBlockId, src, alt } = args;
  if (op.name === "addBlock" && op.block.id === imageBlockId && op.block.type === "image") {
    return {
      ...op,
      block: { ...op.block, properties: { ...op.block.properties, src, alt } },
    };
  }
  if (op.name === "addSection" && op.children !== undefined) {
    return {
      ...op,
      children: op.children.map((child) =>
        child.id === imageBlockId && child.type === "image"
          ? { ...child, properties: { ...child.properties, src, alt } }
          : child,
      ),
    };
  }
  return op;
}
