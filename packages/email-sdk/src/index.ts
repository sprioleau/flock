/**
 * @tandem/email-sdk — document definition, Zod schemas, operations, renderers.
 *
 * Phase 1 status: 1.1 (schemas) and 1.2 (flat store & integrity) implemented.
 * Operations (1.3) and renderers (1.4) build on this surface.
 */

export const SDK_VERSION = "0.1.0";

// --- Ids (schema/ids) -------------------------------------------------------
export {
  BLOCK_TYPES,
  CONTAINER_BLOCK_TYPES,
  LEAF_BLOCK_TYPES,
  ROOT_BLOCK_ID,
  BLOCK_ID_PREFIXES,
  BLOCK_ID_SUFFIX_LENGTH,
  generateBlockId,
  blockIdSchema,
  blockIdSchemasByType,
  rootBlockIdSchema,
  sectionBlockIdSchema,
  rowBlockIdSchema,
  columnBlockIdSchema,
  textBlockIdSchema,
  buttonBlockIdSchema,
  imageBlockIdSchema,
  dividerBlockIdSchema,
  leafBlockIdSchema,
} from "./schema/ids";
export type {
  BlockId,
  BlockType,
  ContainerBlockType,
  LeafBlockType,
  RandomFn,
} from "./schema/ids";

// --- Rich text (schema/text) --------------------------------------------------
export {
  textDocSchema,
  textBlockNodeSchema,
  headingNodeSchema,
  paragraphNodeSchema,
  inlineNodeSchema,
  textNodeSchema,
  hardBreakNodeSchema,
  textMarkSchema,
  boldMarkSchema,
  italicMarkSchema,
  underlineMarkSchema,
  strikeMarkSchema,
  linkMarkSchema,
  createTextDoc,
} from "./schema/text";
export type {
  TextDoc,
  TextBlockNode,
  HeadingNode,
  ParagraphNode,
  InlineNode,
  TextNode,
  HardBreakNode,
  TextMark,
} from "./schema/text";

// --- Global styles (schema/globals) --------------------------------------------
export { globalStylesSchema, textAlignSchema, DEFAULT_GLOBAL_STYLES } from "./schema/globals";
export type { GlobalStyles, TextAlign } from "./schema/globals";

// --- Blocks (schema/blocks) ------------------------------------------------------
export {
  blockSchema,
  rootBlockSchema,
  sectionBlockSchema,
  rowBlockSchema,
  columnBlockSchema,
  textBlockSchema,
  buttonBlockSchema,
  imageBlockSchema,
  dividerBlockSchema,
} from "./schema/blocks";
export type {
  Block,
  RootBlock,
  SectionBlock,
  RowBlock,
  ColumnBlock,
  TextBlock,
  ButtonBlock,
  ImageBlock,
  DividerBlock,
  ContainerBlock,
  LeafBlock,
} from "./schema/blocks";

// --- Flat store (store/document) ----------------------------------------------
export { emailDocumentSchema, createEmptyDocument, createSampleDocument } from "./store/document";
export type { EmailDocument } from "./store/document";

// --- Tree derivation (store/tree) ------------------------------------------------
export { inflate, deflate } from "./store/tree";
export type { EmailTree, EmailTreeNode } from "./store/tree";

// --- Integrity (store/integrity) ----------------------------------------------------
export { checkDocumentIntegrity, ALLOWED_CHILD_TYPES } from "./store/integrity";
export type {
  IntegrityCheckResult,
  IntegrityError,
  IntegrityErrorCode,
} from "./store/integrity";
