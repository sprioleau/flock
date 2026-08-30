import { LEAF_BLOCK_TYPES, type Block, type BlockType, type EmailDocument } from "@flock/email-sdk";
import { serializeBlock } from "@/lib/suggestions/serialize-block";

/*
  Persona watch scope + change hashing (item 27, owner: "allow setting block
  types to watch (or whole document), and if the previous document hash
  hasn't changed since last check, skip the check entirely").

  The scope is PURE REGISTRY DATA: an optional `watch:` frontmatter line in
  the persona markdown — `watch: document` (the default) or a comma list of
  block types (`watch: text, button`). The form editor round-trips unknown
  frontmatter lines verbatim, so no schema or editor work is needed; the
  runner parses it client-side, the same place it already reads
  personaMarkdown.

  The hash is deliberately cheap and deterministic (djb2 over the scope's
  serialization) — it gates whether a persona joins a runner batch at all.
*/

export type PersonaWatchScope =
  | { kind: "document" }
  | { kind: "blockTypes"; blockTypes: BlockType[] };

export const DOCUMENT_WATCH_SCOPE: PersonaWatchScope = { kind: "document" };

/*
  Types a `watch:` list may name (leaves + the structural containers).
*/
const WATCHABLE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  ...LEAF_BLOCK_TYPES,
  "section",
  "row",
  "column",
]);

/*
  Parse the persona's `watch:` frontmatter line. Absent line, `document`,
  or a list with no recognizable block types ⇒ whole-document scope (the
  safe default — never silently narrow a persona on a typo).
*/
export function parsePersonaWatchScope(personaMarkdown: string): PersonaWatchScope {
  const trimmed = personaMarkdown.trim();
  if (!trimmed.startsWith("---")) {
    return DOCUMENT_WATCH_SCOPE;
  }
  const closeIndex = trimmed.indexOf("\n---", 3);
  if (closeIndex === -1) {
    return DOCUMENT_WATCH_SCOPE;
  }
  const frontmatter = trimmed.slice(3, closeIndex);
  const match = frontmatter.match(/^watch:\s*(.+)$/im);
  if (match === null) {
    return DOCUMENT_WATCH_SCOPE;
  }
  const tokens = match[1]
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  if (tokens.includes("document")) {
    return DOCUMENT_WATCH_SCOPE;
  }
  const blockTypes = tokens.filter((token): token is BlockType =>
    WATCHABLE_BLOCK_TYPES.has(token),
  );
  return blockTypes.length === 0
    ? DOCUMENT_WATCH_SCOPE
    : { kind: "blockTypes", blockTypes };
}

/*
  Cheap deterministic string hash (djb2) — not cryptographic.
*/
export function hashStringToUint(text: string): number {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return hash >>> 0;
}

/** {@link hashStringToUint} as a compact storable string. */
export function hashString(text: string): string {
  return hashStringToUint(text).toString(36);
}

/*
  Deterministic per-persona stagger offset (item 27: personas must not all
  come due at the same moment). Hash of the SLUG, so every tab and every
  reload agrees — added to the persona's cooldown when the runner gates
  eligibility. Runs stay BATCHED (one call per trigger window); the offset
  only spreads which personas join a given batch.
*/
export function getPersonaStaggerMs({
  slug,
  windowMs,
}: {
  slug: string;
  windowMs: number;
}): number {
  return windowMs <= 0 ? 0 : hashStringToUint(slug) % windowMs;
}

/*
  The persona's view-of-the-document hash: whole-document scopes hash the
  (already computed) full outline; block-type scopes hash only the watched
  blocks' serializations — so a styling edit to a button never wakes a
  persona watching text.
*/
export function computeWatchScopeHash({
  doc,
  scope,
  documentOutline,
}: {
  doc: EmailDocument;
  scope: PersonaWatchScope;
  /*
    The full outline the caller already generated for the run.
  */
  documentOutline: string;
}): string {
  if (scope.kind === "document") {
    return hashString(documentOutline);
  }
  const watchedTypes = new Set<string>(scope.blockTypes);
  const serialized = Object.values(doc)
    .filter((block): block is Block => watchedTypes.has((block as Block).type))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((block) => serializeBlock(block))
    .join("\n");
  return hashString(serialized);
}
