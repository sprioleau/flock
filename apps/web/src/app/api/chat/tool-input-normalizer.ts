import { blockSchema, LEAF_BLOCK_TYPES } from "@flock/email-sdk";
import type { z } from "zod";

/**
 * Deterministic repair of near-miss model tool inputs, run immediately BEFORE
 * validation (see model-schema.ts) — the same seam as
 * `unwrapStringifiedToolInput`, for a different observed quirk.
 *
 * THE OBSERVED FAILURE (production): the model called `addSection` and sent a
 * text block as
 *
 *   { type: "text", text: <ProseMirror doc>, id: "txt_…", parentId: "sec_…" }
 *
 * which Zod rejected with four issues — a missing `name` discriminator, a
 * missing `childrenIds`, a missing `properties`, and `text` as an
 * unrecognized top-level key. This is a CONFORMANCE miss, not a vocabulary
 * gap: the JSON Schema the model received spells out all five block keys.
 * Every one of those four issues is mechanically closable without asking a
 * model again, so we close them here instead of burning a repair round.
 *
 * WHAT IS REPAIRED (all of it derived from the REAL Zod schemas — nothing
 * about the block vocabulary is written down in this file):
 *
 * 1. A field the schema pins to exactly ONE literal value, ABSENT from the
 *    payload, is filled with that literal. That is the operation `name`
 *    discriminator (a redundant echo of the tool actually being invoked) and
 *    a block's `type` where the position pins it (e.g. addSection's
 *    `section`). Absent only — see "what is refused" below.
 * 2. A LEAF block missing `childrenIds` gets `[]`. Leaf schemas type that
 *    field as `z.array(z.never()).length(0)`, so `[]` is the only value they
 *    can ever hold; we also re-check that against the field schema.
 * 3. Top-level keys on a block that are NOT block keys but ARE valid keys of
 *    that block type's `properties` object are moved under `properties`
 *    (creating it when absent). The property vocabulary is read off the
 *    block variant's own `properties` shape at the schema position being
 *    validated, so a block gaining a property is covered the day it lands.
 *
 * WHAT IS DELIBERATELY REFUSED:
 *
 * - Nothing is ever invented. No heading, URL, colour, label, or height is
 *   synthesized; `childrenIds: []` and an empty `properties` object carry no
 *   content, and hoisting moves a value the model already sent.
 * - A pinned field that is PRESENT but WRONG is left for Zod. Overwriting it
 *   would widen: `updateBlockProperties` and `replaceBlockProperties` have
 *   IDENTICAL shapes apart from the `name` literal, so "correcting" a present
 *   `name` would silently turn a merge into a wholesale replace.
 * - An ambiguous hoist is left for Zod: if the block already carries
 *   `properties.<key>`, a stray top-level `<key>` is NOT moved (nor dropped),
 *   whether or not the two agree. Two values for one property is the model
 *   contradicting itself; guessing which it meant is not repair.
 * - Container blocks missing `childrenIds` are left alone. `[]` is a
 *   meaningful value there ("no children"), and filling it in for, say, a
 *   section whose subtree arrived in addSection's `children` would fabricate
 *   a structurally odd document instead of failing.
 *
 * THE HARD GUARANTEE: a repair is kept only if the ORIGINAL schema then
 * accepts the whole input. If it does not, the untouched input is handed to
 * Zod, so anything this module cannot save fails exactly as it does today,
 * with exactly today's issues. Normalizing an already-valid payload returns
 * it unchanged (by identity).
 */

interface SchemaDef {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Zod v4 exposes each node's definition as `.def`. */
function schemaDef(schema: z.ZodType): SchemaDef {
  return (schema as unknown as { def: SchemaDef }).def;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Wrapper node kinds and the def key holding the wrapped schema. */
const WRAPPED_SCHEMA_KEYS: Readonly<Record<string, string>> = {
  optional: "innerType",
  nullable: "innerType",
  nonoptional: "innerType",
  default: "innerType",
  prefault: "innerType",
  readonly: "innerType",
  catch: "innerType",
  pipe: "in",
};

/** Depth cap: guards a self-referential `lazy` chain from spinning. */
const MAX_UNWRAP_DEPTH = 16;

/** Strip optional/nullable/default/pipe/lazy wrappers down to the real node. */
function unwrapSchema(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const def = schemaDef(current);
    if (def.type === "lazy") {
      current = (def.getter as () => z.ZodType)();
      continue;
    }
    const wrappedKey = WRAPPED_SCHEMA_KEYS[def.type];
    if (wrappedKey === undefined) return current;
    current = def[wrappedKey] as z.ZodType;
  }
  return current;
}

function objectShapeOf(schema: z.ZodType): Record<string, z.ZodType> | undefined {
  const def = schemaDef(schema);
  return def.type === "object" ? (def.shape as Record<string, z.ZodType>) : undefined;
}

function unionOptionsOf(schema: z.ZodType): readonly z.ZodType[] | undefined {
  const def = schemaDef(schema);
  return def.type === "union" ? (def.options as readonly z.ZodType[]) : undefined;
}

/** The single value a schema pins a field to, or undefined if it is not pinned. */
function pinnedLiteralOf(schema: z.ZodType | undefined): { readonly value: unknown } | undefined {
  if (schema === undefined) return undefined;
  const def = schemaDef(unwrapSchema(schema));
  if (def.type !== "literal") return undefined;
  const values = def.values as readonly unknown[];
  return values.length === 1 ? { value: values[0] } : undefined;
}

// ---------------------------------------------------------------------------
// Block variants, read off the SDK's own union
// ---------------------------------------------------------------------------

/**
 * `type` literal → that variant's block-level keys, built from the SDK's
 * `blockSchema` discriminated union. This is the whole of what this module
 * "knows" about blocks, and it is read from the schema at import time.
 */
const BLOCK_KEYS_BY_TYPE: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const byType = new Map<string, ReadonlySet<string>>();
  for (const option of unionOptionsOf(unwrapSchema(blockSchema)) ?? []) {
    const shape = objectShapeOf(unwrapSchema(option));
    if (shape === undefined) continue;
    const typeLiteral = pinnedLiteralOf(shape.type)?.value;
    if (typeof typeLiteral !== "string") continue;
    byType.set(typeLiteral, new Set(Object.keys(shape)));
  }
  return byType;
})();

const LEAF_BLOCK_TYPE_SET: ReadonlySet<string> = new Set<string>(LEAF_BLOCK_TYPES);

/**
 * The block type this schema node describes, or undefined if it is not a
 * block variant. Detection is STRUCTURAL (a `type` literal naming a known
 * block type, plus exactly that variant's key set) rather than by identity,
 * because `.describe()` clones every node it is called on — the schemas
 * reached through the op schemas are never the same objects the SDK exports.
 */
function blockTypeOf(schema: z.ZodType): string | undefined {
  const shape = objectShapeOf(schema);
  if (shape === undefined) return undefined;
  const typeLiteral = pinnedLiteralOf(shape.type)?.value;
  if (typeof typeLiteral !== "string") return undefined;
  const expectedKeys = BLOCK_KEYS_BY_TYPE.get(typeLiteral);
  if (expectedKeys === undefined) return undefined;
  const actualKeys = Object.keys(shape);
  const isSameShape =
    actualKeys.length === expectedKeys.size && actualKeys.every((key) => expectedKeys.has(key));
  return isSameShape ? typeLiteral : undefined;
}

/**
 * Whether any block can appear anywhere beneath this schema. Gates the walk
 * so rich-text docs (a deep recursive union that contains `{ type: "text" }`
 * ProseMirror nodes — which must NEVER be mistaken for text blocks) and every
 * other block-free subtree are skipped outright.
 */
const blocksBearingCache = new WeakMap<z.ZodType, boolean>();

function schemaBearsBlocks(schema: z.ZodType, visiting: Set<z.ZodType>): boolean {
  const resolved = unwrapSchema(schema);
  const cached = blocksBearingCache.get(resolved);
  if (cached !== undefined) return cached;
  if (visiting.has(resolved)) return false; // cycle: no new information on this path
  visiting.add(resolved);

  let bearsBlocks = false;
  if (blockTypeOf(resolved) !== undefined) {
    bearsBlocks = true;
  } else {
    const def = schemaDef(resolved);
    const children: z.ZodType[] =
      def.type === "object"
        ? Object.values(def.shape as Record<string, z.ZodType>)
        : def.type === "union"
          ? [...(def.options as readonly z.ZodType[])]
          : def.type === "array"
            ? [def.element as z.ZodType]
            : def.type === "record"
              ? [def.valueType as z.ZodType]
              : def.type === "tuple"
                ? [...(def.items as readonly z.ZodType[])]
                : [];
    bearsBlocks = children.some((child) => schemaBearsBlocks(child, visiting));
  }

  visiting.delete(resolved);
  blocksBearingCache.set(resolved, bearsBlocks);
  return bearsBlocks;
}

// ---------------------------------------------------------------------------
// Repair 1 — fields the schema pins to a single literal
// ---------------------------------------------------------------------------

function collectObjectShapes(schema: z.ZodType, into: Record<string, z.ZodType>[]): void {
  const resolved = unwrapSchema(schema);
  const shape = objectShapeOf(resolved);
  if (shape !== undefined) {
    into.push(shape);
    return;
  }
  for (const option of unionOptionsOf(resolved) ?? []) {
    collectObjectShapes(option, into);
  }
}

/**
 * Fields every branch of `schema` pins to the SAME single literal. A union
 * whose branches disagree (scaffoldSection's `templateId`, placeBlockBeside
 * content's `kind`) yields nothing — those carry real information, unlike the
 * `name` echo, and picking one would be a guess.
 */
function commonPinnedLiterals(schema: z.ZodType): ReadonlyMap<string, unknown> {
  const shapes: Record<string, z.ZodType>[] = [];
  collectObjectShapes(schema, shapes);
  const [firstShape, ...otherShapes] = shapes;
  if (firstShape === undefined) return new Map();

  const pinned = new Map<string, unknown>();
  for (const [key, fieldSchema] of Object.entries(firstShape)) {
    const literal = pinnedLiteralOf(fieldSchema);
    if (literal !== undefined) pinned.set(key, literal.value);
  }
  for (const shape of otherShapes) {
    for (const [key, expected] of [...pinned]) {
      const fieldSchema = shape[key];
      const literal = fieldSchema === undefined ? undefined : pinnedLiteralOf(fieldSchema);
      if (literal === undefined || !Object.is(literal.value, expected)) pinned.delete(key);
    }
  }
  return pinned;
}

/** Fill ABSENT pinned-literal fields. Present-but-wrong is left for Zod. */
function fillPinnedLiterals(schema: z.ZodType, value: Record<string, unknown>): Record<string, unknown> {
  let next = value;
  for (const [key, literal] of commonPinnedLiterals(schema)) {
    if (next[key] !== undefined) continue;
    if (next === value) next = { ...value };
    next[key] = literal;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Repairs 2 & 3 — one block
// ---------------------------------------------------------------------------

interface NormalizeBlockInput {
  readonly variantSchema: z.ZodType;
  readonly blockType: string;
  readonly value: Record<string, unknown>;
}

function normalizeBlock({ variantSchema, blockType, value }: NormalizeBlockInput): unknown {
  // A stated type that disagrees with the position's type is the model
  // sending the wrong block, not a near miss — repairing it against the wrong
  // property vocabulary would be nonsense. Leave it for Zod.
  if (typeof value.type === "string" && value.type !== blockType) return value;

  const shape = objectShapeOf(variantSchema);
  if (shape === undefined) return value;

  const filled = fillPinnedLiterals(variantSchema, value);
  let next = filled;
  const cloneOnce = (): Record<string, unknown> => {
    if (next === value) next = { ...value };
    return next;
  };

  // Leaf `childrenIds` is `z.array(z.never()).length(0)` — `[]` is the only
  // value it can ever hold, so supplying it invents nothing.
  const childrenIdsSchema = shape.childrenIds;
  if (
    next.childrenIds === undefined &&
    LEAF_BLOCK_TYPE_SET.has(blockType) &&
    childrenIdsSchema !== undefined &&
    childrenIdsSchema.safeParse([]).success
  ) {
    cloneOnce().childrenIds = [];
  }

  const propertiesSchema = shape.properties === undefined ? undefined : unwrapSchema(shape.properties);
  const propertiesShape = propertiesSchema === undefined ? undefined : objectShapeOf(propertiesSchema);
  if (propertiesShape === undefined) return next;

  const propertyKeys = new Set(Object.keys(propertiesShape));
  const blockKeys = new Set(Object.keys(shape));
  const rawProperties = next.properties;
  const existingProperties = isJsonObject(rawProperties) ? rawProperties : undefined;
  // A non-object `properties` is a different mistake; leave it for Zod.
  if (rawProperties !== undefined && existingProperties === undefined) return next;

  const hoisted: Record<string, unknown> = {};
  for (const key of Object.keys(next)) {
    if (blockKeys.has(key)) continue;
    if (!propertyKeys.has(key)) continue; // not a property either — Zod's to reject
    if (existingProperties !== undefined && key in existingProperties) continue; // ambiguous
    hoisted[key] = next[key];
  }

  const hoistedKeys = Object.keys(hoisted);
  if (hoistedKeys.length === 0 && rawProperties !== undefined) return next;

  const withProperties = cloneOnce();
  withProperties.properties = { ...(existingProperties ?? {}), ...hoisted };
  for (const key of hoistedKeys) delete withProperties[key];
  return withProperties;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

function normalizeAgainstSchema(schema: z.ZodType, value: unknown): unknown {
  const resolved = unwrapSchema(schema);
  if (!schemaBearsBlocks(resolved, new Set())) return value;

  const blockType = blockTypeOf(resolved);
  if (blockType !== undefined) {
    return isJsonObject(value) ? normalizeBlock({ variantSchema: resolved, blockType, value }) : value;
  }

  const def = schemaDef(resolved);

  if (def.type === "object" && isJsonObject(value)) {
    const shape = def.shape as Record<string, z.ZodType>;
    let next = value;
    for (const [key, fieldSchema] of Object.entries(shape)) {
      if (!(key in value)) continue;
      const normalizedField = normalizeAgainstSchema(fieldSchema, value[key]);
      if (normalizedField === value[key]) continue;
      if (next === value) next = { ...value };
      next[key] = normalizedField;
    }
    return next;
  }

  if (def.type === "array" && Array.isArray(value)) {
    const elementSchema = def.element as z.ZodType;
    let next = value;
    for (const [index, item] of value.entries()) {
      const normalizedItem = normalizeAgainstSchema(elementSchema, item);
      if (normalizedItem === item) continue;
      if (next === value) next = [...value];
      next[index] = normalizedItem;
    }
    return next;
  }

  if (def.type === "union") {
    const options = def.options as readonly z.ZodType[];
    const discriminator = def.discriminator;
    if (typeof discriminator === "string" && isJsonObject(value)) {
      // Discriminated: the branch is not a guess — Zod picks the same one.
      const matching = options.filter((option) => {
        const optionShape = objectShapeOf(unwrapSchema(option));
        const discriminatorSchema = optionShape?.[discriminator];
        return discriminatorSchema?.safeParse(value[discriminator]).success === true;
      });
      const [onlyMatch, ...extraMatches] = matching;
      if (onlyMatch === undefined || extraMatches.length > 0) return value;
      return normalizeAgainstSchema(onlyMatch, value);
    }
    // Undiscriminated: repair only if EXACTLY ONE branch both changes the
    // value and then accepts it. Anything else is ambiguous — leave it.
    const repaired = options
      .map((option) => ({ option, candidate: normalizeAgainstSchema(option, value) }))
      .filter(({ option, candidate }) => candidate !== value && option.safeParse(candidate).success);
    const [onlyRepair, ...extraRepairs] = repaired;
    return onlyRepair !== undefined && extraRepairs.length === 0 ? onlyRepair.candidate : value;
  }

  if (def.type === "record" && isJsonObject(value)) {
    const valueSchema = def.valueType as z.ZodType;
    let next = value;
    for (const [key, entry] of Object.entries(value)) {
      const normalizedEntry = normalizeAgainstSchema(valueSchema, entry);
      if (normalizedEntry === entry) continue;
      if (next === value) next = { ...value };
      next[key] = normalizedEntry;
    }
    return next;
  }

  return value;
}

/**
 * Repair a model-produced tool input against the tool's own Zod schema.
 *
 * Returns the input UNCHANGED (by identity) when there is nothing mechanical
 * to close, when a repair would be a guess, or when the repaired input still
 * does not validate — in that last case the caller hands Zod the original, so
 * the rejection it reports is exactly the one it reports today.
 */
export function normalizeToolInput(schema: z.ZodType, value: unknown): unknown {
  if (!isJsonObject(value)) return value;

  const withPinnedLiterals = fillPinnedLiterals(schema, value);
  const normalized = normalizeAgainstSchema(schema, withPinnedLiterals);
  if (normalized === value) return value;

  return schema.safeParse(normalized).success ? normalized : value;
}
