import type { Block, BlockType } from "@flock/email-sdk";

/** Display labels per block type — always full words, never abbreviated or truncated. */
export const BLOCK_TYPE_LABELS: Record<BlockType, string> = {
  root: "Email",
  section: "Section",
  row: "Row",
  column: "Column",
  text: "Text",
  button: "Button",
  image: "Image",
  divider: "Divider",
  link: "Link",
  code: "Code",
  spacer: "Spacer",
};

/**
 * User-facing display label for a block — the type label for most blocks,
 * with one refinement: an image carrying the brand-kit semantic marker
 * `properties.role === "logo"` reads "Logo", so logo blocks are identifiable
 * at a glance in the canvas chip stack and the property-panel breadcrumb.
 * Display-only: the block is still an ordinary image block everywhere else.
 */
export function getBlockDisplayLabel({ block }: { block: Block }): string {
  if (block.type === "image" && block.properties.role === "logo") {
    return "Logo";
  }
  return BLOCK_TYPE_LABELS[block.type];
}
