import {
  buildColumns,
  createTextDoc,
  generateBlockId,
  resolveGlobalStyles,
  ROOT_BLOCK_ID,
  type Block,
  type BlockId,
  type BlockType,
  type BuildColumnsInput,
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

/**
 * The Logo preset's stand-in when the brand kit has no CONFIRMED logo yet
 * (owner decision 4: unconfirmed suggestions never enter documents — the
 * placeholder nudges the user toward the Brand kit panel's confirm flow).
 */
export const DEFAULT_LOGO_PLACEHOLDER_SRC = "https://placehold.co/240x80?text=Your+logo";

/** New images default to this share of the email's content width (owner default, 2026-07-31). */
export const DEFAULT_IMAGE_WIDTH_RATIO = 0.6;

/** Logo-preset images default to this share of the content width (wordmark-sized, not hero-sized). */
export const DEFAULT_LOGO_WIDTH_RATIO = 0.3;

/** New images default to this outer padding on all four sides (px). */
export const DEFAULT_IMAGE_PADDING_PX = 12;

/** New dividers default to this padding above and below the line (px). */
export const DEFAULT_DIVIDER_PADDING_PX = 24;

/** New spacers default to this height (px) — also the columns presets' seed content. */
export const DEFAULT_SPACER_HEIGHT_PX = 24;

/** The document's raw root globals (undefined when the doc has no root yet). */
function getDocumentGlobals(doc: EmailDocument) {
  const root = doc[ROOT_BLOCK_ID];
  return root !== undefined && root.type === "root" ? root.properties.globals : undefined;
}

/**
 * Default width for a new image block: 60% of the document's resolved
 * contentWidth (root.properties.globals.contentWidth, falling back to the
 * SDK default), stored as an ABSOLUTE pixel value computed at creation time.
 */
export function getDefaultImageWidth(doc: EmailDocument): number {
  return Math.round(
    resolveGlobalStyles(getDocumentGlobals(doc)).contentWidth * DEFAULT_IMAGE_WIDTH_RATIO,
  );
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

/**
 * Content presets: palette items that insert an EXISTING block type with
 * non-default content. "heading" is the owner-decided shape of the palette's
 * Heading tile (2026-07-31): a regular TEXT block whose doc is a single
 * heading node — no separate heading block type, so inline editing, sync,
 * outline handling, and the agent surface all come along for free.
 * "logo" follows the same stance (brand-kit architecture §7: a role-marked
 * IMAGE block, not a logo block type): it inherits the whole image pipeline
 * and brand propagation re-sources it via its `role: "logo"` marker.
 */
export type LeafBlockVariant = "heading" | "logo";

/** What the Logo preset sources: the brand kit's CONFIRMED logo, or null. */
export interface BrandLogoSource {
  /** Durable Convex-storage serving URL (already passed the confirmed gate). */
  src: string;
  /** Accessible name, e.g. "Acme logo". */
  alt: string;
}

/** The default heading level for the palette's Heading preset. */
export const DEFAULT_HEADING_LEVEL = 2;

export interface CreateDefaultLeafBlockInput {
  type: LeafBlockType;
  /** Optional content preset ("heading" on text blocks, "logo" on images). */
  variant?: LeafBlockVariant;
  id: BlockId;
  /** The section or column the block will be inserted into. */
  parentId: BlockId;
  /** The current document — image defaults derive from its resolved globals. */
  doc: EmailDocument;
  /**
   * The brand kit's CONFIRMED logo, for the "logo" variant. Null/omitted =
   * no confirmed logo — the preset inserts the placeholder instead
   * (unconfirmed suggestions may never enter documents, owner decision 4).
   */
  brandLogo?: BrandLogoSource | null;
}

/** Build a fully-formed leaf block with sensible default properties. */
export function createDefaultLeafBlock({
  type,
  variant,
  id,
  parentId,
  doc,
  brandLogo,
}: CreateDefaultLeafBlockInput): Block {
  switch (type) {
    case "text":
      if (variant === "heading") {
        return {
          id,
          type: "text",
          parentId,
          childrenIds: [],
          properties: {
            text: {
              type: "doc",
              content: [
                {
                  type: "heading",
                  attrs: { level: DEFAULT_HEADING_LEVEL },
                  content: [{ type: "text", text: "New heading" }],
                },
              ],
            },
            paddingTop: 8,
            paddingBottom: 8,
          },
        };
      }
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
      if (variant === "logo") {
        // Brand-kit architecture §7.2: to the user this is a "Logo block";
        // architecturally it's an image with a role marker — propagation
        // re-sources it, and the whole image pipeline comes along for free.
        return {
          id,
          type: "image",
          parentId,
          childrenIds: [],
          properties: {
            src: brandLogo?.src ?? DEFAULT_LOGO_PLACEHOLDER_SRC,
            alt: brandLogo?.alt ?? "Brand logo",
            role: "logo",
            align: "left",
            width: Math.round(
              resolveGlobalStyles(getDocumentGlobals(doc)).contentWidth * DEFAULT_LOGO_WIDTH_RATIO,
            ),
            paddingTop: DEFAULT_IMAGE_PADDING_PX,
            paddingBottom: DEFAULT_IMAGE_PADDING_PX,
            paddingLeft: DEFAULT_IMAGE_PADDING_PX,
            paddingRight: DEFAULT_IMAGE_PADDING_PX,
          },
        };
      }
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
        properties: {
          paddingTop: DEFAULT_DIVIDER_PADDING_PX,
          paddingBottom: DEFAULT_DIVIDER_PADDING_PX,
        },
      };
    case "link":
      return {
        id,
        type: "link",
        parentId,
        childrenIds: [],
        properties: {
          text: "New link",
          href: "https://example.com",
          paddingTop: 8,
          paddingBottom: 8,
        },
      };
    case "code":
      return {
        id,
        type: "code",
        parentId,
        childrenIds: [],
        properties: {
          code: 'console.log("Hello from Tandem");',
          language: "javascript",
          paddingTop: 8,
          paddingBottom: 8,
        },
      };
    case "spacer":
      return {
        id,
        type: "spacer",
        parentId,
        childrenIds: [],
        properties: { height: DEFAULT_SPACER_HEIGHT_PX },
      };
  }
}

export interface CreateDefaultColumnsPresetInput {
  /** How many equal columns the new row holds (rows cap at 4). */
  columnCount: 2 | 3 | 4;
  /** The section the new row will be inserted into. */
  sectionId: BlockId;
  /** The current document — ids are generated collision-free against it. */
  doc: EmailDocument;
}

export interface DefaultColumnsPreset {
  /** The new row's id — the subtree root (select it after insertion). */
  rowId: BlockId;
  /** Row first, then columns — exactly the restoreBlocks `blocks` contract. */
  blocks: Block[];
}

/**
 * Build the layout-palette columns preset: one row of N equal-width columns,
 * each seeded with ONE default spacer, assembled by the SDK's shared
 * `buildColumns` (the same row/column assembler every section template uses,
 * so width arithmetic can never drift). The spacer seeds are load-bearing:
 * the document auto-removes empty columns/rows (removeBlock's
 * empty-ancestor cascade), so a spacer makes each fresh column COUNT AS
 * CONTENT — the layout sticks around until the user deletes the spacers,
 * and deleting a column's last block collapses just that column (the last
 * column takes the whole row with it), with width re-equalization. Insert
 * with ONE `restoreBlocks` op ("valid to call directly" per its contract —
 * the duplicate button uses the same pattern), giving a single undo step.
 */
export function createDefaultColumnsPreset({
  columnCount,
  sectionId,
  doc,
}: CreateDefaultColumnsPresetInput): DefaultColumnsPreset {
  const usedIds = new Set<string>(Object.keys(doc));
  const allocateId: BuildColumnsInput["allocateId"] = (type) => {
    let id: string = generateBlockId(type);
    while (usedIds.has(id)) {
      id = generateBlockId(type);
    }
    usedIds.add(id);
    return id;
  };
  const { rowId, blocks } = buildColumns({
    sectionId,
    columns: Array.from({ length: columnCount }, () => ({
      leaves: [{ kind: "spacer" as const, height: DEFAULT_SPACER_HEIGHT_PX }],
    })),
    allocateId,
  });
  return { rowId: rowId as BlockId, blocks };
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
