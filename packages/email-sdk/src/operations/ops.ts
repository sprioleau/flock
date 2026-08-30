import { z } from "zod";
import { blockSchema, sectionBlockSchema } from "../schema/blocks";
import { globalStylesSchema } from "../schema/globals";
import {
  blockIdSchema,
  columnBlockIdSchema,
  leafBlockIdSchema,
  rowBlockIdSchema,
  sectionBlockIdSchema,
  textBlockIdSchema,
} from "../schema/ids";
import { textDocSchema } from "../schema/text";

/*
  Operations — the only way an email document changes.

  Each operation is a pure, replayable data transform: `applyOperation(doc,
  op)` returns a NEW document plus the operation's inverse, never mutating the
  input (docs/email-editor-phased-plan.md §9.2). The inverses power the
  SDK-owned undo/redo stack in Phase 4.3 (`undo`/`redo`/`advanceTo`/
  `rollbackTo` over the operation log) — which is why every op here must be
  deterministic and invertible.

  The envelope is a Zod discriminated union on `name`. Every field carries a
  `.describe()` — these descriptions are the LLM's documentation when ops are
  exposed as agent tools (Phase 1.5 `defineEmailAction`).

  Two operations exist primarily as GENERATED INVERSES, though both are
  ordinary members of the union and may be issued directly:
  - `replaceBlockProperties` — wholesale replace of one block's properties.
    Inverse of the merging ops (`updateBlockProperties`,
    `updateDocumentSettings`, and `applyTheme` when no section override was
    touched), because a merge cannot be undone by another merge when it
    introduced new keys (and JSON transport cannot express "delete this key").
  - `restoreBlocks` — re-insert a previously removed subtree. Inverse of
    `removeBlock`, whose cascade may span many blocks.

  One op additionally carries an inverse-support payload: `applyTheme` strips
  every section's theme-scoped background overrides, so its inverse is another
  `applyTheme` whose optional `sectionOverrides` restores them together with
  the previous globals in ONE op (the same pattern as removeBlock's inverse
  carrying a whole subtree).
*/

const insertionIndexSchema = z
  .number()
  .int()
  .min(0)
  .describe(
    "Zero-based position among the parent's children at which to insert. Must be between 0 and the parent's current child count, inclusive (the count itself appends).",
  );

/*
  ---------------------------------------------------------------------------
  Property & settings operations
  ---------------------------------------------------------------------------
*/

/*
  Merge a partial set of property overrides into one block.
*/
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

/*
  Wholesale replace of one block's properties (inverse of the merging ops).
*/
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
    "Replaces one block's entire properties object. Primarily generated as the inverse of updateBlockProperties / updateDocumentSettings, but valid to call directly (e.g. to clear overrides).",
  );

export type ReplaceBlockPropertiesOperation = z.infer<typeof replaceBlockPropertiesOperationSchema>;

/*
  Merge partial global styles into `root.properties.globals`.
*/
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

/*
  One section's theme-scoped background overrides, re-applied AFTER the
  theme's override strip. Carried on `applyTheme` inverses so one undo step
  restores both the previous globals and every section's removed overrides.
*/
export const themeSectionOverrideSchema = z
  .strictObject({
    blockId: sectionBlockIdSchema.describe("Id of the section block to set the overrides on."),
    innerBackgroundColor: z
      .string()
      .min(1)
      .optional()
      .describe("innerBackgroundColor to set on the section. Omit to leave it cleared."),
    outerBackgroundColor: z
      .string()
      .min(1)
      .optional()
      .describe("outerBackgroundColor to set on the section. Omit to leave it cleared."),
  })
  .describe(
    "One section's theme-scoped background overrides (innerBackgroundColor / outerBackgroundColor), set after the theme apply's override strip.",
  );

export type ThemeSectionOverride = z.infer<typeof themeSectionOverrideSchema>;

/*
  Wholesale replace of `root.properties.globals` (a theme switch).
*/
export const applyThemeOperationSchema = z
  .strictObject({
    name: z.literal("applyTheme").describe("Operation discriminator."),
    globals: globalStylesSchema.describe(
      "The complete new global styles object. Replaces root.properties.globals entirely — any global not listed here reverts to the renderer default.",
    ),
    sectionOverrides: z
      .array(themeSectionOverrideSchema)
      .optional()
      .describe(
        "Section background overrides to set AFTER the strip, one entry per section. Primarily generated on inverses (so one undo restores the previous globals AND every section's removed overrides); omit when applying a theme normally.",
      ),
  })
  .describe(
    "Applies a theme: wholesale-replaces the document's global styles with the given object AND removes every section's theme-scoped background overrides (innerBackgroundColor / outerBackgroundColor) so the theme's colors take effect everywhere. Other section overrides (padding, layout) are preserved. A theme switch is exactly one of these operations (Phase 7 builds theme presets on top).",
  );

export type ApplyThemeOperation = z.infer<typeof applyThemeOperationSchema>;

/*
  ---------------------------------------------------------------------------
  Structural operations
  ---------------------------------------------------------------------------
*/

/*
  Insert one fully-formed block under a parent at an index.
*/
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

/*
  Insert a section (optionally with a prebuilt subtree) under the root.
*/
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

/*
  One column's previous explicit width, restored by unplaceBlockBeside / restoreBlocks.
*/
export const previousColumnWidthSchema = z
  .strictObject({
    columnId: columnBlockIdSchema.describe("Id of the column whose width to restore."),
    widthPercent: z
      .number()
      .min(1)
      .max(100)
      .describe("The widthPercent to set back on the column."),
  })
  .describe("One column's previous explicit widthPercent, re-set after the column is removed.");

export type PreviousColumnWidth = z.infer<typeof previousColumnWidthSchema>;

/*
  Re-insert a previously removed subtree (inverse of removeBlock).
*/
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
    previousWidths: z
      .array(previousColumnWidthSchema)
      .optional()
      .describe(
        "Column-subtree case only: explicit widthPercent values a cascading removal stripped from the destination row's OTHER columns, re-set after the subtree is re-inserted so one undo restores the row's exact previous widths. Primarily generated on inverses of removeBlock with shouldRemoveEmptyAncestors.",
      ),
  })
  .describe(
    "Re-inserts a whole subtree (a block and all its descendants) under a parent at the given position, optionally restoring sibling column widths a cascading removal stripped. Primarily generated as the inverse of removeBlock, but valid to call directly.",
  );

export type RestoreBlocksOperation = z.infer<typeof restoreBlocksOperationSchema>;

/*
  Remove a block and, cascading, all of its descendants.
*/
export const removeBlockOperationSchema = z
  .strictObject({
    name: z.literal("removeBlock").describe("Operation discriminator."),
    blockId: blockIdSchema.describe(
      "Id of the block to remove. All of its descendants are removed with it. The root block cannot be removed.",
    ),
    shouldRemoveEmptyAncestors: z
      .boolean()
      .optional()
      .describe(
        "When true, empty containers never persist: removing a column's last remaining child removes the column too (surviving sibling columns reset to an equal width split), and removing a row's last remaining column removes the whole row. Every live removal path sets this (see withRemoveBlockCascadeDefault); operations logged before the field existed omit it and replay without the cascade.",
      ),
  })
  .describe(
    "Removes a block and every block beneath it (cascading delete). With shouldRemoveEmptyAncestors, a column emptied by the removal collapses — and an emptied row with it — while surviving sibling columns re-equalize; still ONE operation and ONE undo step. The inverse is a restoreBlocks operation carrying the entire removed subtree (plus any stripped sibling widths).",
  );

export type RemoveBlockOperation = z.infer<typeof removeBlockOperationSchema>;

/*
  Reparent and/or reorder one block (subtree moves with it).
*/
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

/*
  Reorder a parent's children — must be a permutation of the current ids.
*/
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

/*
  ---------------------------------------------------------------------------
  Column-placement operations (drag-to-create columns)
  ---------------------------------------------------------------------------
*/

/*
  What occupies the new column a placeBlockBeside creates.
*/
export const placeBlockBesideContentSchema = z
  .discriminatedUnion("kind", [
    z
      .strictObject({
        kind: z.literal("new-block").describe("Content discriminator: insert a brand-new block."),
        block: blockSchema.describe(
          "The complete new leaf block (text, button, image, divider, link, code, spacer), including a caller-generated id (see generateBlockId) that must not already exist in the document. Its parentId is overwritten with the new column's id on apply.",
        ),
      })
      .describe("Insert a brand-new leaf block into the new column."),
    z
      .strictObject({
        kind: z
          .literal("existing-block")
          .describe("Content discriminator: move an existing block."),
        blockId: leafBlockIdSchema.describe(
          "Id of an existing leaf block anywhere in the document. It moves into the new column; its old parent keeps its other children.",
        ),
      })
      .describe("Move an existing leaf block into the new column."),
  ])
  .describe(
    "What occupies the new column: a brand-new leaf block, or an existing leaf block moved from elsewhere in the document.",
  );

export type PlaceBlockBesideContent = z.infer<typeof placeBlockBesideContentSchema>;

/*
  Which side of the target the placed block lands on.
*/
export const placeBlockBesideSideSchema = z
  .enum(["left", "right"])
  .describe('Which side of the target the placed block lands on: "left" or "right".');

export type PlaceBlockBesideSide = z.infer<typeof placeBlockBesideSideSchema>;

/*
  Place a block side-by-side with a target leaf, creating columns as needed.
*/
export const placeBlockBesideOperationSchema = z
  .strictObject({
    name: z.literal("placeBlockBeside").describe("Operation discriminator."),
    targetBlockId: leafBlockIdSchema.describe(
      "Id of the existing leaf block to place beside. Never a section, row, or column.",
    ),
    side: placeBlockBesideSideSchema,
    content: placeBlockBesideContentSchema,
    newColumnId: columnBlockIdSchema.describe(
      "Caller-generated id for the new column that holds the placed block. Must not already exist in the document.",
    ),
    newRowId: rowBlockIdSchema
      .optional()
      .describe(
        "Caller-generated id for the wrapping row. REQUIRED when the target sits directly in a section (the wrap case); ignored when the target already sits inside a column.",
      ),
    newTargetColumnId: columnBlockIdSchema
      .optional()
      .describe(
        "Caller-generated id for the column that receives the target in the wrap case. REQUIRED when the target sits directly in a section; ignored otherwise.",
      ),
  })
  .describe(
    "Places a block side-by-side with a target leaf block, creating column layout as needed. A target sitting directly in a section is wrapped in a new row of two equal columns (target in one, the placed block in the other); a target already inside a column gets a new sibling column beside its column. Rows hold at most 4 columns. All column widths in the affected row are reset to an equal split. One operation — one undo step; the inverse is a single unplaceBlockBeside.",
  );

export type PlaceBlockBesideOperation = z.infer<typeof placeBlockBesideOperationSchema>;

/*
  Undo a placeBlockBeside: dissolve the created column (and row, if wrapped).
*/
export const unplaceBlockBesideOperationSchema = z
  .strictObject({
    name: z.literal("unplaceBlockBeside").describe("Operation discriminator."),
    targetBlockId: leafBlockIdSchema.describe(
      "The target of the original placeBlockBeside (also used to reconstruct the redo operation).",
    ),
    side: placeBlockBesideSideSchema,
    newColumnId: columnBlockIdSchema.describe(
      "The column the original operation created. It must currently hold exactly the placed block, and it is removed.",
    ),
    content: z
      .discriminatedUnion("kind", [
        z
          .strictObject({
            kind: z
              .literal("new-block")
              .describe("Content discriminator: the placed block was brand-new."),
            blockId: leafBlockIdSchema.describe(
              "Id of the placed block. It was created by the original operation, so it is removed together with its column.",
            ),
          })
          .describe("Remove the placed block (it was created by the original operation)."),
        z
          .strictObject({
            kind: z
              .literal("existing-block")
              .describe("Content discriminator: the placed block was moved from elsewhere."),
            blockId: leafBlockIdSchema.describe("Id of the placed block to move back."),
            previousParentId: z
              .union([sectionBlockIdSchema, columnBlockIdSchema])
              .describe("The section or column the placed block came from."),
            previousIndex: z
              .number()
              .int()
              .min(0)
              .describe("The placed block's position among its previous parent's children."),
          })
          .describe("Move the placed block back to where it came from."),
      ])
      .describe(
        "What happens to the placed block: brand-new blocks are removed with their column; moved blocks return to their previous parent and position.",
      ),
    unwrapRowId: rowBlockIdSchema
      .optional()
      .describe(
        "Wrap case only: the row the original operation created. The target moves back into the section at the row's position and the row (with both of its columns) is removed.",
      ),
    previousWidths: z
      .array(previousColumnWidthSchema)
      .optional()
      .describe(
        "Column case only: explicit widthPercent values the original operation stripped from the row's other columns, re-set after the new column is removed.",
      ),
  })
  .describe(
    "Reverts a placeBlockBeside: removes the column it created (removing a brand-new placed block, or moving a relocated one back to its previous parent), unwraps the created row in the wrap case, and restores the row's previous column widths. Primarily generated as the inverse of placeBlockBeside, but valid to call directly.",
  );

export type UnplaceBlockBesideOperation = z.infer<typeof unplaceBlockBesideOperationSchema>;

/*
  ---------------------------------------------------------------------------
  Text operations
  ---------------------------------------------------------------------------
*/

/*
  Replace a text block's rich-text doc.

  Phase 5 note: collaborative text editing adds a ProseMirror-step-based path
  (`updateTextAndMarks`) that applies steps through prosemirror-sync's
  server-side transform, so concurrent keystrokes rebase instead of
  clobbering each other. This whole-doc replacement op remains the SDK-core
  fallback — the path agents and non-collaborative callers use when no live
  editor session owns the block.
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

/*
  ---------------------------------------------------------------------------
  Union
  ---------------------------------------------------------------------------
*/

/*
  Any operation — discriminated union on `name`.
*/
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
    placeBlockBesideOperationSchema,
    unplaceBlockBesideOperationSchema,
    updateTextOperationSchema,
  ])
  .describe("Any document operation, discriminated by its name field.");

export type Operation = z.infer<typeof operationSchema>;

/*
  The `name` values of every operation in the union.
*/
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
  "placeBlockBeside",
  "unplaceBlockBeside",
  "updateText",
] as const satisfies readonly Operation["name"][];

export type OperationName = (typeof OPERATION_NAMES)[number];

/*
  Entry-point default for removeBlock's empty-container cascade: a removeBlock
  that does not state a `shouldRemoveEmptyAncestors` choice gets `true`, so
  every LIVE removal path (toolbar delete, agent-issued ops, raw API callers)
  collapses emptied columns/rows. Applied where operations ENTER the system
  (the action registry's resolveOperation and Convex applyOperations) — the
  explicit flag is what reaches the op log, so historical operations that
  predate the field keep replaying with their original no-cascade semantics.
  Non-removeBlock operations pass through untouched.
*/
export function withRemoveBlockCascadeDefault(operation: Operation): Operation {
  if (operation.name !== "removeBlock" || operation.shouldRemoveEmptyAncestors !== undefined) {
    return operation;
  }
  return { ...operation, shouldRemoveEmptyAncestors: true };
}
