import {
  createTextDoc,
  generateBlockId,
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
 */

export const DEFAULT_IMAGE_SRC =
  "https://cdn-images.mailchimp.com/template_images/email/default_image_placeholder.png";

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
}

/** Build a fully-formed leaf block with sensible default properties. */
export function createDefaultLeafBlock({
  type,
  id,
  parentId,
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
          paddingTop: 8,
          paddingBottom: 8,
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
