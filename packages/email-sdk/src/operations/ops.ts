import { z } from "zod";
import { blockSchema, sectionBlockSchema } from "../schema/blocks";
import { globalStylesSchema } from "../schema/globals";
import { blockIdSchema, textBlockIdSchema } from "../schema/ids";
import { textDocSchema } from "../schema/text";

/**
 * Operations — the only way an email document changes.
 *
 * Each operation is a pure, replayable data transform: `applyOperation(doc,
 * op)` returns a NEW document plus the operation's inverse, never mutating the
 * input (docs/email-editor-phased-plan.md §9.2). The inverses power the
 * SDK-owned undo/redo stack in Phase 4.3 (`undo`/`redo`/`advanceTo`/
 * `rollbackTo` over the operation log) — which is why every op here must be
 * deterministic and invertible.
 *
 * The envelope is a Zod discriminated union on `name`. Every field carries a
 * `.describe()` — these descriptions are the LLM's documentation when ops are
 * exposed as agent tools (Phase 1.5 `defineEmailAction`).
 *
 * Two operations exist primarily as GENERATED INVERSES, though both are
 * ordinary members of the union and may be issued directly:
 * - `replaceBlockProperties` — wholesale replace of one block's properties.
 *   Inverse of the merging ops (`updateBlockProperties`,
 *   `updateDocumentSettings`, `applyTheme`), because a merge cannot be undone
 *   by another merge when it introduced new keys (and JSON transport cannot
 *   express "delete this key").
 * - `restoreBlocks` — re-insert a previously removed subtree. Inverse of
 *   `removeBlock`, whose cascade may span many blocks.
 */

const insertionIndexSchema = z
  .number()
  .int()
  .min(0)
  .describe(
    "Zero-based position among the parent's children at which to insert. Must be between 0 and the parent's current child count, inclusive (the count itself appends).",
  );

// ---------------------------------------------------------------------------
// Property & settings operations
// ---------------------------------------------------------------------------

/** Merge a partial set of property overrides into one block. */
export const updateBlockPropertiesOperationSchema = z
  .strictObject({
    name: z.literal("updateBlockProperties").describe("Operation discriminator."),
    blockId: blockIdSchema.describe("Id of the block whose properties to update."),
    properties: z
      .record(z.string(), z.unknown())
      .describe(
        "Partial property overrides, shallow-merged into the block's existing properties. Keys must be valid properties for the block's type — the merged result is validated against the block's full schema and the operation fails if it does not conform. A key set to undefined clears that override (JSON callers cannot express undefined; use replaceBlockProperties to clear).",
      ),
  })
  .describe(
    "Shallow-merges partial property overrides into one block's properties. Unmentioned properties are preserved. The merged block is re-validated against its schema.",
  );

export type UpdateBlockPropertiesOperation = z.infer<typeof updateBlockPropertiesOperationSchema>;

/** Wholesale replace of one block's properties (inverse of the merging ops). */
export const replaceBlockPropertiesOperationSchema = z
  .strictObject({
    name: z.literal("replaceBlockProperties").describe("Operation discriminator."),
    blockId: blockIdSchema.describe("Id of the block whose properties to replace."),
    properties: z
      .record(z.string(), z.unknown())
      .describe(
        "The complete new properties object for the block. Replaces the existing properties entirely — any property not listed here is removed. Must conform to the block type's properties schema.",
      ),
  })
  .describe(
    "Replaces one block's entire properties object. Primarily generated as the inverse of updateBlockProperties / updateDocumentSettings / applyTheme, but valid to call directly (e.g. to clear overrides).",
  );

export type ReplaceBlockPropertiesOperation = z.infer<typeof replaceBlockPropertiesOperationSchema>;

/** Merge partial global styles into `root.properties.globals`. */
export const updateDocumentSettingsOperationSchema = z
  .strictObject({
    name: z.literal("updateDocumentSettings").describe("Operation discriminator."),
    globals: globalStylesSchema.describe(
      "Partial global styles, shallow-merged into root.properties.globals. Only the fields present here change; all other globals are preserved.",
    ),
  })
  .describe(
    "Updates document-wide settings by merging partial global styles into the root block's globals. Use applyTheme instead to replace ALL globals at once.",
  );

export type UpdateDocumentSettingsOperation = z.infer<typeof updateDocumentSettingsOperationSchema>;

/** Wholesale replace of `root.properties.globals` (a theme switch). */
export const applyThemeOperationSchema = z
  .strictObject({
    name: z.literal("applyTheme").describe("Operation discriminator."),
    globals: globalStylesSchema.describe(
      "The complete new global styles object. Replaces root.properties.globals entirely — any global not listed here reverts to the renderer default.",
    ),
  })
  .describe(
    "Applies a theme: wholesale-replaces the document's global styles with the given object. A theme switch is exactly one of these operations (Phase 7 builds theme presets on top).",
  );

export type ApplyThemeOperation = z.infer<typeof applyThemeOperationSchema>;

// ---------------------------------------------------------------------------
// Structural operations
// ---------------------------------------------------------------------------

/** Insert one fully-formed block under a parent at an index. */
export const addBlockOperationSchema = z
  .strictObject({
    name: z.literal("addBlock").describe("Operation discriminator."),
    block: blockSchema.describe(
      "The complete new block, including a caller-generated id (see generateBlockId) that must not already exist in the document. Its parentId is overwritten with this operation's parentId on apply.",
    ),
    parentId: blockIdSchema.describe(
      "Id of the container block to insert into. The parent's type must accept the new block's type (root > section > (row | leaf) · row > column > leaf).",
    ),
    index: insertionIndexSchema,
  })
  .describe(
    "Inserts one new block under a parent at the given position. For a section together with a prebuilt subtree, prefer addSection.",
  );

export type AddBlockOperation = z.infer<typeof addBlockOperationSchema>;

/** Insert a section (optionally with a prebuilt subtree) under the root. */
export const addSectionOperationSchema = z
  .strictObject({
    name: z.literal("addSection").describe("Operation discriminator."),
    section: sectionBlockSchema.describe(
      "The complete new section block with a caller-generated id not already in the document. Its childrenIds must reference only blocks provided in `children`.",
    ),
    index: insertionIndexSchema,
    children: z
      .array(blockSchema)
      .optional()
      .describe(
        "Optional prebuilt subtree of the section: every descendant block (rows, columns, leaves), each with a fresh id and a parentId pointing at the section or another block in this array. Omit for an empty section.",
      ),
  })
  .describe(
    "Convenience composite: inserts a new section under the root at the given position, together with an optional prebuilt subtree of descendant blocks, atomically.",
  );

export type AddSectionOperation = z.infer<typeof addSectionOperationSchema>;

/** Re-insert a previously removed subtree (inverse of removeBlock). */
export const restoreBlocksOperationSchema = z
  .strictObject({
    name: z.literal("restoreBlocks").describe("Operation discriminator."),
    blocks: z
      .array(blockSchema)
      .min(1)
      .describe(
        "The subtree to restore as a flat list. The FIRST block is the subtree root and is re-attached under parentId; every other block's parentId must point at another block in this list. Ids must not exist in the document.",
      ),
    parentId: blockIdSchema.describe(
      "Id of the container to re-attach the subtree root under. Its type must accept the subtree root's type.",
    ),
    index: insertionIndexSchema,
  })
  .describe(
    "Re-inserts a whole subtree (a block and all its descendants) under a parent at the given position. Primarily generated as the inverse of removeBlock, but valid to call directly.",
  );

export type RestoreBlocksOperation = z.infer<typeof restoreBlocksOperationSchema>;

/** Remove a block and, cascading, all of its descendants. */
export const removeBlockOperationSchema = z
  .strictObject({
    name: z.literal("removeBlock").describe("Operation discriminator."),
    blockId: blockIdSchema.describe(
      "Id of the block to remove. All of its descendants are removed with it. The root block cannot be removed.",
    ),
  })
  .describe(
    "Removes a block and every block beneath it (cascading delete). The inverse is a restoreBlocks operation carrying the entire removed subtree.",
  );

export type RemoveBlockOperation = z.infer<typeof removeBlockOperationSchema>;

/** Reparent and/or reorder one block (subtree moves with it). */
export const moveBlockOperationSchema = z
  .strictObject({
    name: z.literal("moveBlock").describe("Operation discriminator."),
    blockId: blockIdSchema.describe(
      "Id of the block to move. Its whole subtree moves with it. The root block cannot be moved.",
    ),
    newParentId: blockIdSchema.describe(
      "Id of the destination container. Its type must accept the moved block's type, and it must not be the moved block itself or any of its descendants (no cycles).",
    ),
    index: insertionIndexSchema.describe(
      "Zero-based position among the destination parent's children AFTER the block is detached from its current position. Between 0 and the destination's resulting child count, inclusive.",
    ),
  })
  .describe(
    "Moves a block (with its subtree) to a new parent and/or position. Rejects moves that violate nesting rules or would create a cycle (moving a block into its own subtree).",
  );

export type MoveBlockOperation = z.infer<typeof moveBlockOperationSchema>;

/** Reorder a parent's children — must be a permutation of the current ids. */
export const reorderChildrenOperationSchema = z
  .strictObject({
    name: z.literal("reorderChildren").describe("Operation discriminator."),
    parentId: blockIdSchema.describe("Id of the container whose children to reorder."),
    orderedChildIds: z
      .array(blockIdSchema)
      .describe(
        "The parent's complete childrenIds in the new order. Must be an exact permutation of the current children — same ids, no additions, removals, or duplicates.",
      ),
  })
  .describe(
    "Reorders the children of one container. The new order must be a permutation of the existing children; use moveBlock to change parents.",
  );

export type ReorderChildrenOperation = z.infer<typeof reorderChildrenOperationSchema>;

// ---------------------------------------------------------------------------
// Text operations
// ---------------------------------------------------------------------------

/**
 * Replace a text block's rich-text doc.
 *
 * Phase 5 note: collaborative text editing adds a ProseMirror-step-based path
 * (`updateTextAndMarks`) that applies steps through prosemirror-sync's
 * server-side transform, so concurrent keystrokes rebase instead of
 * clobbering each other. This whole-doc replacement op remains the SDK-core
 * fallback — the path agents and non-collaborative callers use when no live
 * editor session owns the block.
 */
export const updateTextOperationSchema = z
  .strictObject({
    name: z.literal("updateText").describe("Operation discriminator."),
    blockId: textBlockIdSchema.describe("Id of the text block whose content to replace."),
    text: textDocSchema.describe(
      "The complete new rich-text doc for the block. Replaces the existing doc entirely — content and inline marks only; alignment, color, and padding are block properties.",
    ),
  })
  .describe(
    "Replaces a text block's entire rich-text doc. Whole-doc replacement — Phase 5 adds a finer-grained ProseMirror-step path (updateTextAndMarks) for live collaborative editing.",
  );

export type UpdateTextOperation = z.infer<typeof updateTextOperationSchema>;

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

/** Any operation — discriminated union on `name`. */
export const operationSchema = z
  .discriminatedUnion("name", [
    updateBlockPropertiesOperationSchema,
    replaceBlockPropertiesOperationSchema,
    updateDocumentSettingsOperationSchema,
    applyThemeOperationSchema,
    addBlockOperationSchema,
    addSectionOperationSchema,
    restoreBlocksOperationSchema,
    removeBlockOperationSchema,
    moveBlockOperationSchema,
    reorderChildrenOperationSchema,
    updateTextOperationSchema,
  ])
  .describe("Any document operation, discriminated by its name field.");

export type Operation = z.infer<typeof operationSchema>;

/** The `name` values of every operation in the union. */
export const OPERATION_NAMES = [
  "updateBlockProperties",
  "replaceBlockProperties",
  "updateDocumentSettings",
  "applyTheme",
  "addBlock",
  "addSection",
  "restoreBlocks",
  "removeBlock",
  "moveBlock",
  "reorderChildren",
  "updateText",
] as const satisfies readonly Operation["name"][];

export type OperationName = (typeof OPERATION_NAMES)[number];
