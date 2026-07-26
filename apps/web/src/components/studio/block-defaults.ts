import {
  createTextDoc,
  generateBlockId,
  resolveGlobalStyles,
  ROOT_BLOCK_ID,
  type Block,
  type BlockId,
  type BlockType,
  type EmailDocument,
  type LeafBlockType,
  type SectionBlock,
} from "@tandem/email-sdk";

/**
 * Factories for the add-block affordance: fresh ids plus sensible default
 * properties per leaf type. Pure — the resulting blocks are handed to the
 * store's dispatch (addBlock / addSection) like any other operation input.
 * Image defaults depend on the current document (width derives from the
 * resolved contentWidth), so the factory takes the doc as input.
 */

export const DEFAULT_IMAGE_SRC = "https://placehold.co/600x400";

/** New images default to this share of the email's content width. */
export const DEFAULT_IMAGE_WIDTH_RATIO = 0.85;

/** New images default to this outer padding on all four sides (px). */
export const DEFAULT_IMAGE_PADDING_PX = 10;

/**
 * Default width for a new image block: 85% of the document's resolved
 * contentWidth (root.properties.globals.contentWidth, falling back to the
 * SDK default), stored as an ABSOLUTE pixel value computed at creation time.
 */
export function getDefaultImageWidth(doc: EmailDocument): number {
  const root = doc[ROOT_BLOCK_ID];
  const globals = root !== undefined && root.type === "root" ? root.properties.globals : undefined;
  return Math.round(resolveGlobalStyles(globals).contentWidth * DEFAULT_IMAGE_WIDTH_RATIO);
}

export interface GenerateUniqueBlockIdInput {
  type: BlockType;
  doc: EmailDocument;
}

/** Generate a block id of the given type that does not collide with the doc. */
export function generateUniqueBlockId({ type, doc }: GenerateUniqueBlockIdInput): BlockId {
  let id = generateBlockId(type);
  while (doc[id] !== undefined) {
    id = generateBlockId(type);
  }
  return id;
}

export interface CreateDefaultLeafBlockInput {
  type: LeafBlockType;
  id: BlockId;
  /** The section or column the block will be inserted into. */
  parentId: BlockId;
  /** The current document — image defaults derive from its resolved globals. */
  doc: EmailDocument;
}

/** Build a fully-formed leaf block with sensible default properties. */
export function createDefaultLeafBlock({
  type,
  id,
  parentId,
  doc,
}: CreateDefaultLeafBlockInput): Block {
  switch (type) {
    case "text":
      return {
        id,
        type: "text",
        parentId,
        childrenIds: [],
        properties: {
          text: createTextDoc("New text block"),
          paddingTop: 8,
          paddingBottom: 8,
        },
      };
    case "button":
      return {
        id,
        type: "button",
        parentId,
        childrenIds: [],
        properties: {
          label: "Click me",
          href: "https://example.com",
          align: "center",
          paddingTop: 8,
          paddingBottom: 8,
        },
      };
    case "image":
      return {
        id,
        type: "image",
        parentId,
        childrenIds: [],
        properties: {
          src: DEFAULT_IMAGE_SRC,
          alt: "Placeholder image",
          align: "center",
          width: getDefaultImageWidth(doc),
          paddingTop: DEFAULT_IMAGE_PADDING_PX,
          paddingBottom: DEFAULT_IMAGE_PADDING_PX,
          paddingLeft: DEFAULT_IMAGE_PADDING_PX,
          paddingRight: DEFAULT_IMAGE_PADDING_PX,
        },
      };
    case "divider":
      return {
        id,
        type: "divider",
        parentId,
        childrenIds: [],
        properties: { paddingTop: 12, paddingBottom: 12 },
      };
  }
}

/** Build an empty section block ready for addSection under the root. */
export function createDefaultSection(id: BlockId): SectionBlock {
  return {
    id,
    type: "section",
    parentId: ROOT_BLOCK_ID,
    childrenIds: [],
    properties: { paddingTop: 16, paddingBottom: 16 },
  };
}
