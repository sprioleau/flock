import { parseBlockId, type BlockType, type Operation } from "@tandem/email-sdk";
import { deriveIdentity } from "@/lib/presence";
import type { OperationEntry } from "./history-grouping";

/**
 * Shared identity + human-label helpers for op-log surfaces (op inspector,
 * time-travel replay). Purely presentational: given an op-log row's
 * `author`/`authorId`, derive who made it and what color represents them;
 * given an op payload, derive a human row label that names the block TYPE,
 * never the block id ("updateText · text block").
 *
 * Author derivation is prefix-based, matching the provenance conventions the
 * backend already writes:
 * - `author: "agent"` → the AI agent (violet), or the demo agent when the
 *   authorId carries the demo prefix.
 * - `authorId: "suggestions:<sessionId>"` → an applied suggestion.
 * - `authorId: "demo-ghost…"` → the demo ghost typist (impersonates a human,
 *   so it gets a derived presence identity like any user).
 * - everything else → a human session; name + hue via `deriveIdentity`, the
 *   same hash presence uses, so colors line up with the facepile.
 */

export type OpAuthorKind = "agent" | "demo-agent" | "suggestion" | "ghost" | "you" | "user";

export interface OpAuthorIdentity {
  kind: OpAuthorKind;
  /** Short display name ("Agent", "You", "Brisk Otter"). */
  label: string;
  /** CSS color for dots/borders/labels. */
  color: string;
}

/** Violet, matching the existing Agent badge language in the History panel. */
const AGENT_COLOR = "hsl(262 68% 52%)";
/** Magenta — visibly agent-family but distinct from the real agent. */
const DEMO_AGENT_COLOR = "hsl(310 62% 48%)";
/** Amber — the quiet suggestion accent. */
const SUGGESTION_COLOR = "hsl(35 85% 40%)";

/** Who authored an op-log row, with a stable display color. */
export function deriveOpAuthor({
  author,
  authorId,
  viewerAuthorId,
}: {
  author: string;
  authorId: string;
  viewerAuthorId: string | null;
}): OpAuthorIdentity {
  if (author === "agent") {
    const isDemoAgent = authorId === "demo-agent" || authorId.startsWith("demo");
    return isDemoAgent
      ? { kind: "demo-agent", label: "Demo agent", color: DEMO_AGENT_COLOR }
      : { kind: "agent", label: "Agent", color: AGENT_COLOR };
  }
  if (authorId.startsWith("suggestions:") || authorId.startsWith("suggestion:")) {
    return { kind: "suggestion", label: "Suggestion", color: SUGGESTION_COLOR };
  }
  const identity = deriveIdentity(authorId);
  if (authorId.startsWith("demo-ghost")) {
    return { kind: "ghost", label: `${identity.name} (ghost)`, color: identity.color };
  }
  if (viewerAuthorId !== null && authorId === viewerAuthorId) {
    return { kind: "you", label: "You", color: identity.color };
  }
  return { kind: "user", label: identity.name, color: identity.color };
}

/** Human noun per block type for row labels. */
const BLOCK_TYPE_NOUNS: Record<BlockType, string> = {
  root: "document",
  section: "section",
  row: "row",
  column: "column",
  text: "text block",
  button: "button",
  image: "image",
  divider: "divider",
};

/** Op names that always target the document as a whole. */
const DOCUMENT_LEVEL_OP_NAMES = new Set(["updateDocumentSettings", "applyTheme"]);

/**
 * The block id an op targets, if any — mirrors the extraction in
 * `describeOperation` plus the container-targeting ops.
 */
function extractTargetBlockId(rawOp: unknown): string | undefined {
  const op = rawOp as Operation & {
    blockId?: string;
    parentId?: string;
    section?: { id?: string };
    block?: { id?: string };
    blocks?: Array<{ id?: string }>;
  };
  if (typeof op.blockId === "string") {
    return op.blockId;
  }
  return op.section?.id ?? op.block?.id ?? op.blocks?.[0]?.id ?? op.parentId;
}

/**
 * Human one-liner for an op payload: the op name plus the target block's
 * TYPE (never its id) — "updateText · text block", "applyTheme · document".
 */
export function describeOperationHuman(rawOp: unknown): string {
  const op = rawOp as Operation;
  if (DOCUMENT_LEVEL_OP_NAMES.has(op.name)) {
    return `${op.name} · document`;
  }
  const targetBlockId = extractTargetBlockId(rawOp);
  if (targetBlockId === undefined) {
    return op.name;
  }
  const parsed = parseBlockId(targetBlockId);
  return parsed === null ? op.name : `${op.name} · ${BLOCK_TYPE_NOUNS[parsed.type]}`;
}

/**
 * Human one-liner for a full op-log entry: undo/redo rows get called out
 * distinctly; edits fall through to `describeOperationHuman`.
 */
export function describeEntryHuman(entry: OperationEntry): string {
  if (entry.kind === "undo") {
    return entry.undoesVersion !== undefined ? `undo · v${entry.undoesVersion}` : "undo";
  }
  if (entry.kind === "redo") {
    return entry.redoesVersion !== undefined ? `redo · v${entry.redoesVersion}` : "redo";
  }
  return describeOperationHuman(entry.op);
}
