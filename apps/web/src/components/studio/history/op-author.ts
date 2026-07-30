import { parseBlockId, type BlockType, type Operation } from "@tandem/email-sdk";
import { deriveIdentity } from "@/lib/presence";
import type { OperationEntry } from "./history-grouping";

/**
 * Shared identity + human-label helpers for EVERY op-log surface (History
 * panel, op inspector, time-travel replay) — the single source of truth for
 * presenting ops to users. Given an op-log row's `author`/`authorId`, derive
 * who made it and what color represents them; given an op payload, derive a
 * plain-English label ("Updated background color · Button") that names the
 * block TYPE — never an internal op name, never a block id.
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

/**
 * Property key → human phrase for "Updated {phrase} · {Block type}" labels.
 * Anything unmapped falls back to the camelCase splitter below, so an
 * internal-looking key can never leak verbatim.
 */
const PROPERTY_PHRASES: Record<string, string> = {
  backgroundColor: "background color",
  color: "text color",
  textColor: "text color",
  borderColor: "border color",
  borderRadius: "corner radius",
  borderSize: "border size",
  paddingTop: "padding",
  paddingBottom: "padding",
  paddingLeft: "padding",
  paddingRight: "padding",
  horizontalPadding: "padding",
  verticalPadding: "padding",
  innerBackgroundColor: "inner background",
  outerBackgroundColor: "outer background",
  emailBackgroundColor: "email background",
  contentBackgroundColor: "content background",
  href: "link",
  src: "image source",
  alt: "alt text",
  label: "label",
  align: "alignment",
  textAlign: "text alignment",
  verticalAlign: "vertical alignment",
  fontFamily: "font",
  width: "width",
  widthPercent: "width",
  contentWidth: "content width",
  thickness: "thickness",
  linkTextColor: "link color",
  dividerColor: "divider color",
  baseSpacing: "spacing",
  buttonBackgroundColor: "button background",
  buttonTextColor: "button text color",
  buttonBorderColor: "button border color",
  buttonBorderRadius: "button corner radius",
  buttonBorderSize: "button border size",
  buttonHorizontalPadding: "button padding",
  buttonVerticalPadding: "button padding",
  buttonFontFamily: "button font",
};

/** "borderRadius" → "corner radius"; unmapped keys → "heading 1 text align". */
function humanizePropertyKey(key: string): string {
  return (
    PROPERTY_PHRASES[key] ??
    key
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Za-z])(\d)/g, "$1 $2")
      .toLowerCase()
  );
}

function capitalizeFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function withIndefiniteArticle(noun: string): string {
  return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
}

/** The target block's human noun, from its id prefix — never the id itself. */
function getBlockNoun(blockId: string | undefined): string | null {
  if (blockId === undefined) {
    return null;
  }
  const parsed = parseBlockId(blockId);
  return parsed === null ? null : BLOCK_TYPE_NOUNS[parsed.type];
}

/** " · Button" suffix for a label, or "" when the target is unknown. */
function formatBlockSuffix(noun: string | null): string {
  return noun === null ? "" : ` · ${capitalizeFirst(noun)}`;
}

/**
 * "Updated corner radius · Button" / "Updated padding and label · Button" /
 * "Updated 4 styles · Button" — up to two property phrases spelled out
 * (deduped: paddingTop+paddingBottom read as one "padding"), a count beyond.
 */
function describePropertyUpdate({
  properties,
  noun,
}: {
  properties: Record<string, unknown>;
  noun: string | null;
}): string {
  const phrases = [...new Set(Object.keys(properties).map(humanizePropertyKey))];
  const suffix = formatBlockSuffix(noun);
  if (phrases.length === 0) {
    return `Updated styles${suffix}`;
  }
  if (phrases.length === 1) {
    return `Updated ${phrases[0]}${suffix}`;
  }
  if (phrases.length === 2) {
    return `Updated ${phrases[0]} and ${phrases[1]}${suffix}`;
  }
  return `Updated ${phrases.length} styles${suffix}`;
}

/**
 * The block id an op targets, if any — for the unknown-op fallback below.
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
 * Human one-liner for an op payload — an action phrase plus the target
 * block's TYPE: "Updated background color · Button", "Edited text · Text
 * block", "Added a section", "Applied theme". Never the internal op name,
 * never a block id (owner rule: those are not user-facing anywhere).
 */
export function describeOperationHuman(rawOp: unknown): string {
  const op = rawOp as Operation;
  switch (op.name) {
    case "updateBlockProperties":
      return describePropertyUpdate({
        properties: op.properties,
        noun: getBlockNoun(op.blockId),
      });
    case "replaceBlockProperties":
      return `Updated styles${formatBlockSuffix(getBlockNoun(op.blockId))}`;
    case "updateDocumentSettings":
      return "Changed email styles";
    case "applyTheme":
      return "Applied theme";
    case "addBlock":
      return `Added ${withIndefiniteArticle(BLOCK_TYPE_NOUNS[op.block.type])}`;
    case "addSection":
      return "Added a section";
    case "restoreBlocks": {
      const noun = op.blocks[0] !== undefined ? BLOCK_TYPE_NOUNS[op.blocks[0].type] : null;
      return noun === null ? "Restored blocks" : `Restored ${withIndefiniteArticle(noun)}`;
    }
    case "removeBlock": {
      const noun = getBlockNoun(op.blockId);
      return `Removed ${withIndefiniteArticle(noun ?? "block")}`;
    }
    case "moveBlock": {
      const noun = getBlockNoun(op.blockId);
      return `Moved ${withIndefiniteArticle(noun ?? "block")}`;
    }
    case "reorderChildren":
      return `Reordered blocks${formatBlockSuffix(getBlockNoun(op.parentId))}`;
    case "updateText":
      return `Edited text${formatBlockSuffix(getBlockNoun(op.blockId))}`;
    default: {
      // A future/unknown op kind must still never leak its internal name.
      const noun = getBlockNoun(extractTargetBlockId(rawOp));
      return noun === null ? "Made an edit" : `Edited ${withIndefiniteArticle(noun)}`;
    }
  }
}

export interface DescribeEntryContext {
  /**
   * Resolve another log entry by version, so undo/redo rows can name what
   * they undid ("Undid: Updated background color · Button"). Surfaces that
   * hold the operations list pass their lookup; without one (or when the
   * target version isn't loaded) the label falls back to "Undid a change".
   */
  getEntryByVersion?: (version: number) => OperationEntry | undefined;
}

/** The human label of the op recorded at `version`, if that entry is loaded. */
function resolveVersionLabel(
  version: number | undefined,
  context: DescribeEntryContext,
): string | null {
  if (version === undefined || context.getEntryByVersion === undefined) {
    return null;
  }
  const targetEntry = context.getEntryByVersion(version);
  return targetEntry === undefined ? null : describeOperationHuman(targetEntry.op);
}

/**
 * Human one-liner for a full op-log entry: undo/redo rows wrap the label of
 * the change they target; edits fall through to `describeOperationHuman`.
 */
export function describeEntryHuman(
  entry: OperationEntry,
  context: DescribeEntryContext = {},
): string {
  if (entry.kind === "undo") {
    const targetLabel = resolveVersionLabel(entry.undoesVersion, context);
    return targetLabel === null ? "Undid a change" : `Undid: ${targetLabel}`;
  }
  if (entry.kind === "redo") {
    // redoesVersion points at the undo entry; the original edit whose effect
    // came back is behind THAT entry's undoesVersion.
    const undoEntry =
      entry.redoesVersion !== undefined
        ? context.getEntryByVersion?.(entry.redoesVersion)
        : undefined;
    const targetLabel = resolveVersionLabel(
      undoEntry?.kind === "undo" ? undoEntry.undoesVersion : undefined,
      context,
    );
    return targetLabel === null ? "Redid a change" : `Redid: ${targetLabel}`;
  }
  return describeOperationHuman(entry.op);
}
