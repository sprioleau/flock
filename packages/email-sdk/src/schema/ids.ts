import { z } from "zod";

/**
 * Block ID scheme.
 *
 * Every block has a short, human-readable, LLM-addressable id of the form
 * `<prefix>_<4 lowercase alphanumeric>` (e.g. `sec_a1b2`, `btn_x9k3`). The
 * one exception is the document root, whose id is literally `"root"` — there
 * is exactly one per document, so it needs no random suffix.
 *
 * The per-type prefix makes ids self-documenting: a compressed outline view
 * (Phase 3.1) can show `btn_x9k3` and the model immediately knows it is a
 * button without a type lookup.
 */

/** All block types in the document model. */
export const BLOCK_TYPES = [
  "root",
  "section",
  "row",
  "column",
  "text",
  "button",
  "image",
  "divider",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

/** Container block types — blocks that may have children. */
export const CONTAINER_BLOCK_TYPES = ["root", "section", "row", "column"] as const;

export type ContainerBlockType = (typeof CONTAINER_BLOCK_TYPES)[number];

/** Leaf block types — blocks that never have children. */
export const LEAF_BLOCK_TYPES = ["text", "button", "image", "divider"] as const;

export type LeafBlockType = (typeof LEAF_BLOCK_TYPES)[number];

/** The literal id of the single root block in every document. */
export const ROOT_BLOCK_ID = "root" as const;

/** Per-type id prefix map. The root "prefix" is the entire id. */
export const BLOCK_ID_PREFIXES = {
  root: "root",
  section: "sec",
  row: "row",
  column: "col",
  text: "txt",
  button: "btn",
  image: "img",
  divider: "div",
} as const satisfies Record<BlockType, string>;

/** Number of random characters after the prefix and underscore. */
export const BLOCK_ID_SUFFIX_LENGTH = 4;

const ID_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A source of randomness: returns a float in [0, 1).
 * Injectable so tests (and deterministic sample factories) can control ids.
 */
export type RandomFn = () => number;

/**
 * Generate a fresh block id for the given type: `<prefix>_<4 chars>` drawn
 * from [a-z0-9]. `generateBlockId("root")` always returns `"root"`.
 *
 * Uniqueness is NOT guaranteed by this function — callers inserting into a
 * document must retry on collision (36^4 = ~1.7M ids per type, so collisions
 * are rare but possible).
 */
export function generateBlockId(type: BlockType, random: RandomFn = Math.random): string {
  if (type === "root") {
    return ROOT_BLOCK_ID;
  }
  let suffix = "";
  for (let i = 0; i < BLOCK_ID_SUFFIX_LENGTH; i += 1) {
    const index = Math.floor(random() * ID_SUFFIX_ALPHABET.length) % ID_SUFFIX_ALPHABET.length;
    suffix += ID_SUFFIX_ALPHABET[index];
  }
  return `${BLOCK_ID_PREFIXES[type]}_${suffix}`;
}

/** Reverse of BLOCK_ID_PREFIXES: prefix → block type. */
const BLOCK_TYPES_BY_PREFIX = Object.fromEntries(
  Object.entries(BLOCK_ID_PREFIXES).map(([type, prefix]) => [prefix, type as BlockType]),
) as Readonly<Record<string, BlockType>>;

const BLOCK_ID_KEY_PATTERN = new RegExp(`^[a-z0-9]{${BLOCK_ID_SUFFIX_LENGTH}}$`);

/** A block id decomposed into its type and its random key (suffix). */
export interface ParsedBlockId {
  type: BlockType;
  /** The random suffix after the prefix — for root, the literal "root". */
  key: string;
}

/** Input to formatBlockId — the inverse of ParsedBlockId. */
export type FormatBlockIdInput = ParsedBlockId;

/**
 * Parse a block id into `{ type, key }`, or null when the string is not a
 * well-formed block id. The conversion seam between the prefixed id style
 * (`btn_x9k3`) and opaque-id consumers (logs, UI): everything downstream of
 * this pair is independent of the id format.
 *
 * `parseBlockId("root")` → `{ type: "root", key: "root" }` (the root id has
 * no random suffix, so its key is the whole id).
 */
export function parseBlockId(id: string): ParsedBlockId | null {
  if (id === ROOT_BLOCK_ID) {
    return { type: "root", key: ROOT_BLOCK_ID };
  }
  const separatorIndex = id.indexOf("_");
  if (separatorIndex === -1) {
    return null;
  }
  const prefix = id.slice(0, separatorIndex);
  const key = id.slice(separatorIndex + 1);
  const type = BLOCK_TYPES_BY_PREFIX[prefix];
  if (type === undefined || type === "root" || !BLOCK_ID_KEY_PATTERN.test(key)) {
    return null;
  }
  return { type, key };
}

/**
 * Format `{ type, key }` back into a block id string — the exact inverse of
 * parseBlockId. Throws on a malformed key so a bad round-trip fails loudly at
 * the seam instead of producing an invalid id.
 */
export function formatBlockId({ type, key }: FormatBlockIdInput): string {
  if (type === "root") {
    if (key !== ROOT_BLOCK_ID) {
      throw new Error(
        `formatBlockId: the root block id has no random key — expected key "${ROOT_BLOCK_ID}", got "${key}".`,
      );
    }
    return ROOT_BLOCK_ID;
  }
  if (!BLOCK_ID_KEY_PATTERN.test(key)) {
    throw new Error(
      `formatBlockId: invalid key "${key}" — expected exactly ${BLOCK_ID_SUFFIX_LENGTH} lowercase alphanumeric characters.`,
    );
  }
  return `${BLOCK_ID_PREFIXES[type]}_${key}`;
}

function createTypedBlockIdSchema(type: Exclude<BlockType, "root">, noun: string) {
  const prefix = BLOCK_ID_PREFIXES[type];
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}_[a-z0-9]{${BLOCK_ID_SUFFIX_LENGTH}}$`),
      `Expected a ${type} block id of the form "${prefix}_xxxx" (4 lowercase alphanumeric characters)`,
    )
    .describe(
      `Id of a ${noun}: "${prefix}_" followed by ${BLOCK_ID_SUFFIX_LENGTH} lowercase alphanumeric characters, e.g. "${prefix}_a1b2".`,
    );
}

/** Matches the root block id — always the literal string "root". */
export const rootBlockIdSchema = z
  .literal(ROOT_BLOCK_ID)
  .describe('Id of the document root block. Always the literal string "root".');

/** Matches section block ids, e.g. "sec_a1b2". */
export const sectionBlockIdSchema = createTypedBlockIdSchema("section", "section block");

/** Matches row block ids, e.g. "row_a1b2". */
export const rowBlockIdSchema = createTypedBlockIdSchema("row", "row block");

/** Matches column block ids, e.g. "col_a1b2". */
export const columnBlockIdSchema = createTypedBlockIdSchema("column", "column block");

/** Matches text block ids, e.g. "txt_a1b2". */
export const textBlockIdSchema = createTypedBlockIdSchema("text", "text block");

/** Matches button block ids, e.g. "btn_a1b2". */
export const buttonBlockIdSchema = createTypedBlockIdSchema("button", "button block");

/** Matches image block ids, e.g. "img_a1b2". */
export const imageBlockIdSchema = createTypedBlockIdSchema("image", "image block");

/** Matches divider block ids, e.g. "div_a1b2". */
export const dividerBlockIdSchema = createTypedBlockIdSchema("divider", "divider block");

/** Matches the id of any leaf block (text, button, image, divider). */
export const leafBlockIdSchema = z
  .union([textBlockIdSchema, buttonBlockIdSchema, imageBlockIdSchema, dividerBlockIdSchema])
  .describe("Id of a leaf block: text (txt_), button (btn_), image (img_), or divider (div_).");

/** Matches any valid block id, of any block type. */
export const blockIdSchema = z
  .string()
  .regex(
    new RegExp(
      `^(${ROOT_BLOCK_ID}|(sec|row|col|txt|btn|img|div)_[a-z0-9]{${BLOCK_ID_SUFFIX_LENGTH}})$`,
    ),
    'Expected "root" or "<prefix>_xxxx" where prefix is one of sec|row|col|txt|btn|img|div',
  )
  .describe(
    'Id of any block: the literal "root", or a type prefix (sec, row, col, txt, btn, img, div) followed by an underscore and 4 lowercase alphanumeric characters.',
  );

/** Per-type id schema lookup, mirroring BLOCK_ID_PREFIXES. */
export const blockIdSchemasByType = {
  root: rootBlockIdSchema,
  section: sectionBlockIdSchema,
  row: rowBlockIdSchema,
  column: columnBlockIdSchema,
  text: textBlockIdSchema,
  button: buttonBlockIdSchema,
  image: imageBlockIdSchema,
  divider: dividerBlockIdSchema,
} as const;

/** A block id string. See the module doc for the scheme. */
export type BlockId = string;
