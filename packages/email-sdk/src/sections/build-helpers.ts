import { z } from "zod";
import type {
  Block,
  ButtonBlock,
  CodeBlock,
  CodeBlockLanguage,
  DividerBlock,
  ImageBlock,
  LeafBlock,
  LinkBlock,
  SectionBlock,
  SpacerBlock,
  TextBlock,
} from "../schema/blocks";
import type { TextAlign } from "../schema/globals";
import { generateBlockId, ROOT_BLOCK_ID, type BlockType, type RandomFn } from "../schema/ids";
import type {
  HeadingNode,
  InlineNode,
  ParagraphNode,
  TextBlockNode,
  TextDoc,
  TextMark,
  TextNode,
} from "../schema/text";
import type { ColumnSpec } from "./build-columns";
import { buildColumns } from "./build-columns";
import type { SectionBuildResult } from "./types";

/*
  Shared building blocks for the section templates: fresh-id allocation,
  rich-text node factories, declarative leaf specs, and a small composer that
  assembles one section subtree in `addSection` payload shape.

  Everything here is pure. Styling discipline: leaf specs expose ONLY
  structural layout knobs (alignment, image display width) — no colors, no
  fonts, no padding — so every emitted block inherits the document's globals
  and stays theme-native.
*/

/*
  ---------------------------------------------------------------------------
  Id allocation
  ---------------------------------------------------------------------------
*/

/*
  Allocate a fresh block id of the given (non-root) type.
*/
export type AllocateBlockId = (type: Exclude<BlockType, "root">) => string;

const MAX_ID_ATTEMPTS = 1000;

/*
  An id allocator that guarantees uniqueness WITHIN one build (two columns of
  the same type must never collide). Uniqueness against the target document is
  the resolver's job (it re-builds on the rare doc collision).
*/
export function createIdAllocator(random: RandomFn = Math.random): AllocateBlockId {
  const usedIds = new Set<string>();
  return (type) => {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = generateBlockId(type, random);
      if (!usedIds.has(id)) {
        usedIds.add(id);
        return id;
      }
    }
    throw new Error(
      `createIdAllocator: could not allocate a fresh ${type} id after ${MAX_ID_ATTEMPTS} attempts — the RandomFn is not producing enough variety.`,
    );
  };
}

/*
  ---------------------------------------------------------------------------
  Rich-text node factories
  ---------------------------------------------------------------------------
*/

/*
  A text run with optional marks — the atom of every text doc we emit.
*/
export function textRun(text: string, marks?: TextMark[]): TextNode {
  return { type: "text", text, ...(marks !== undefined && marks.length > 0 ? { marks } : {}) };
}

export interface HeadingNodeInput {
  level: 1 | 2 | 3;
  /*
    A plain string (one unmarked run) or explicit inline nodes.
  */
  content: string | InlineNode[];
}

export function headingNode({ level, content }: HeadingNodeInput): HeadingNode {
  return {
    type: "heading",
    attrs: { level },
    content: typeof content === "string" ? [textRun(content)] : content,
  };
}

export function paragraphNode(content: string | InlineNode[]): ParagraphNode {
  return {
    type: "paragraph",
    content: typeof content === "string" ? [textRun(content)] : content,
  };
}

export function textDocOf(nodes: TextBlockNode[]): TextDoc {
  return { type: "doc", content: nodes };
}

/*
  ---------------------------------------------------------------------------
  Placeholder imagery
  ---------------------------------------------------------------------------
*/

export interface PlaceholderImageInput {
  width: number;
  height: number;
}

/*
  Every catalog image is a placehold.co PNG with meaningful dimensions — a
  stable absolute https URL (email clients cannot load relative/data URLs).
  The meaning lives in the alt text, which always comes from params.
*/
export function placeholderImageUrl({ width, height }: PlaceholderImageInput): string {
  return `https://placehold.co/${width}x${height}.png`;
}

/*
  The image-source override every image-bearing template accepts, and the ONE
  place its wording lives.

  It is deliberately absent from the model-facing schema (see
  `modelFacingParamsSchema` in ./types): the model writes copy, and a URL
  field would invite it to invent or hotlink an address. The caller this
  exists for is programmatic — the content-ingestion pipeline rehosts a source
  image into our own storage and passes the resulting URL down through a
  createDraft section plan.
*/
export const imageSrcParamSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Absolute https URL of the image to show. Omit for a correctly sized placeholder.",
  );

export interface ResolveImageSrcInput extends PlaceholderImageInput {
  /*
    The caller-supplied source, when there is one.
  */
  src?: string;
}

/*
  A supplied source wins; otherwise the template keeps the exact placeholder
  dimensions it has always emitted. Templates call this instead of
  placeholderImageUrl so the fallback and its size stay one expression.
*/
export function resolveImageSrc({ src, width, height }: ResolveImageSrcInput): string {
  return src ?? placeholderImageUrl({ width, height });
}

/*
  ---------------------------------------------------------------------------
  Declarative leaf specs
  ---------------------------------------------------------------------------
*/

/*
  A leaf block, declaratively — id/parentId are the composer's business.
  Only structural knobs are expressible; theme-owned styling is not.
*/
export type LeafSpec =
  | { kind: "text"; text: TextDoc; textAlign?: TextAlign }
  | { kind: "button"; label: string; href: string; align?: TextAlign }
  | {
      kind: "image";
      src: string;
      alt: string;
      width?: number;
      href?: string;
      align?: TextAlign;
    }
  | { kind: "divider" }
  | {
      kind: "link";
      text: string;
      href: string;
      align?: TextAlign;
      /*
        Font size in px — structural small print (12 for footer meta), like textStyle fontSize marks.
      */
      fontSize?: number;
    }
  | { kind: "code"; code: string; language: CodeBlockLanguage }
  | { kind: "spacer"; height: number };

export interface BuildLeafBlockInput {
  spec: LeafSpec;
  /*
    Id of the section or column this leaf belongs to.
  */
  parentId: string;
  allocateId: AllocateBlockId;
}

/*
  Materialize one leaf spec into a schema-shaped leaf block.
*/
export function buildLeafBlock({ spec, parentId, allocateId }: BuildLeafBlockInput): LeafBlock {
  switch (spec.kind) {
    case "text": {
      const block: TextBlock = {
        id: allocateId("text"),
        type: "text",
        parentId,
        childrenIds: [],
        properties: {
          text: spec.text,
          ...(spec.textAlign !== undefined ? { textAlign: spec.textAlign } : {}),
        },
      };
      return block;
    }
    case "button": {
      const block: ButtonBlock = {
        id: allocateId("button"),
        type: "button",
        parentId,
        childrenIds: [],
        properties: {
          label: spec.label,
          href: spec.href,
          ...(spec.align !== undefined ? { align: spec.align } : {}),
        },
      };
      return block;
    }
    case "image": {
      const block: ImageBlock = {
        id: allocateId("image"),
        type: "image",
        parentId,
        childrenIds: [],
        properties: {
          src: spec.src,
          alt: spec.alt,
          ...(spec.width !== undefined ? { width: spec.width } : {}),
          ...(spec.href !== undefined ? { href: spec.href } : {}),
          ...(spec.align !== undefined ? { align: spec.align } : {}),
        },
      };
      return block;
    }
    case "divider": {
      const block: DividerBlock = {
        id: allocateId("divider"),
        type: "divider",
        parentId,
        childrenIds: [],
        properties: {},
      };
      return block;
    }
    case "link": {
      const block: LinkBlock = {
        id: allocateId("link"),
        type: "link",
        parentId,
        childrenIds: [],
        properties: {
          text: spec.text,
          href: spec.href,
          ...(spec.align !== undefined ? { align: spec.align } : {}),
          ...(spec.fontSize !== undefined ? { fontSize: spec.fontSize } : {}),
        },
      };
      return block;
    }
    case "code": {
      const block: CodeBlock = {
        id: allocateId("code"),
        type: "code",
        parentId,
        childrenIds: [],
        properties: {
          code: spec.code,
          language: spec.language,
        },
      };
      return block;
    }
    case "spacer": {
      const block: SpacerBlock = {
        id: allocateId("spacer"),
        type: "spacer",
        parentId,
        childrenIds: [],
        properties: { height: spec.height },
      };
      return block;
    }
  }
}

/*
  ---------------------------------------------------------------------------
  The section composer
  ---------------------------------------------------------------------------
*/

/*
  Assembles one section subtree top to bottom: direct leaves and/or column
  rows, ids and parentIds wired, in the exact `addSection` payload shape.
*/
export interface SectionComposer {
  /*
    The new section's id (useful for cross-references while composing).
  */
  sectionId: string;
  /*
    Append one leaf directly under the section.
  */
  addLeaf(spec: LeafSpec): void;
  /*
    Append one row of side-by-side columns under the section.
  */
  addColumns(columns: ColumnSpec[]): void;
  /*
    Finish composing: the exact `{ section, children }` addSection payload.
  */
  finish(): SectionBuildResult;
}

export function createSectionComposer(random: RandomFn = Math.random): SectionComposer {
  const allocateId = createIdAllocator(random);
  const sectionId = allocateId("section");
  const childrenIds: string[] = [];
  const children: Block[] = [];

  return {
    sectionId,
    addLeaf: (spec) => {
      const leaf = buildLeafBlock({ spec, parentId: sectionId, allocateId });
      childrenIds.push(leaf.id);
      children.push(leaf);
    },
    addColumns: (columns) => {
      const { rowId, blocks } = buildColumns({ sectionId, columns, allocateId });
      childrenIds.push(rowId);
      children.push(...blocks);
    },
    finish: () => {
      const section: SectionBlock = {
        id: sectionId,
        type: "section",
        parentId: ROOT_BLOCK_ID,
        childrenIds,
        properties: {},
      };
      return { section, children };
    },
  };
}
