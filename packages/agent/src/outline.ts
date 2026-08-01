import {
  DEFAULT_GLOBAL_STYLES,
  ROOT_BLOCK_ID,
  type Block,
  type BlockId,
  type EmailDocument,
  type GlobalStyles,
  type TextDoc,
} from "@flock/email-sdk";

/**
 * Compressed document view (plan §3.1) — THE token-efficiency lever.
 *
 * Renders the flat document as a terse, deterministic, reading-order outline:
 * one globals summary line (non-default values only), then sections → rows →
 * columns → leaf blocks, one line per block, indented by nesting depth. Each
 * line carries the block's typed id (the prefix doubles as the type label for
 * the model) and only the few most-edited props per type.
 *
 * Determinism: traversal follows `childrenIds` order exactly; globals follow
 * DEFAULT_GLOBAL_STYLES key order; "full"-depth extras are sorted by key.
 * Same document in → byte-identical outline out.
 */

/** How much of the tree the outline descends into / how verbose each line is. */
export type OutlineDepth = "sections" | "blocks" | "full";

export interface DocumentOutlineOptions {
  /**
   * "sections": one line per section with a child count — cheapest skim.
   * "blocks" (default): every block with its most-edited props.
   * "full": every block, plus every other explicitly-set property as key=value.
   */
  depth?: OutlineDepth;
  /** Max characters of extracted plain text shown per text block. Default 60. */
  maxTextChars?: number;
}

export interface GenerateDocumentOutlineInput {
  doc: EmailDocument;
  options?: DocumentOutlineOptions;
}

const DEFAULT_MAX_TEXT_CHARS = 60;
const INDENT = "  ";

// ---------------------------------------------------------------------------
// Globals summary
// ---------------------------------------------------------------------------

/** One line listing only the globals that differ from the renderer defaults. */
function summarizeGlobals(doc: EmailDocument): string {
  const root = doc[ROOT_BLOCK_ID];
  const globals: GlobalStyles =
    root !== undefined && root.type === "root" ? (root.properties.globals ?? {}) : {};
  const parts: string[] = [];
  // DEFAULT_GLOBAL_STYLES key order keeps the line deterministic regardless of
  // the order keys were written into the document.
  for (const key of Object.keys(DEFAULT_GLOBAL_STYLES) as (keyof GlobalStyles)[]) {
    const value = globals[key];
    if (value !== undefined && value !== DEFAULT_GLOBAL_STYLES[key]) {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.length > 0 ? `globals: ${parts.join(", ")}` : "globals: (all defaults)";
}

// ---------------------------------------------------------------------------
// Per-type line summaries
// ---------------------------------------------------------------------------

interface TextDocSummary {
  /** Block-node kinds in order, e.g. ["h1", "p"]. */
  nodeKinds: string[];
  /** All plain text, node boundaries joined with " | ", hard breaks as spaces. */
  plainText: string;
  /**
   * Compact span-mark summary, e.g. " +bold+link+color(#16a34a)" — "" when
   * the block has no inline marks. Presence badges in a fixed order; the
   * value-carrying kinds (font/color/size/highlight) show their value only
   * when it is the SAME everywhere in the block (else the bare badge — call
   * getBlockDetails for per-span values). Keeps the outline terse while
   * letting the model see existing span styling before styleTextSpan edits.
   */
  marksSummary: string;
}

/** Badge render order — fixed for determinism. */
const MARK_BADGES = ["bold", "italic", "underline", "strike", "link", "font", "color", "size", "highlight"] as const;

type MarkBadge = (typeof MARK_BADGES)[number];

/** First font family of a CSS stack, unquoted — "Georgia, serif" → "Georgia". */
function firstFontFamily(fontFamily: string): string {
  return (fontFamily.split(",")[0] ?? fontFamily).trim().replace(/^['"]|['"]$/g, "");
}

function formatMarksSummary(valuesByBadge: Map<MarkBadge, Set<string>>): string {
  const badges: string[] = [];
  for (const badge of MARK_BADGES) {
    const values = valuesByBadge.get(badge);
    if (values === undefined) {
      continue;
    }
    const [onlyValue] = values;
    badges.push(values.size === 1 && onlyValue !== "" ? `${badge}(${onlyValue})` : badge);
  }
  return badges.length > 0 ? ` +${badges.join("+")}` : "";
}

function summarizeTextDoc(textDoc: TextDoc): TextDocSummary {
  const nodeKinds: string[] = [];
  const nodeTexts: string[] = [];
  // badge → distinct values seen ("" for the valueless boolean/link kinds).
  const valuesByBadge = new Map<MarkBadge, Set<string>>();
  const recordBadge = (badge: MarkBadge, value = ""): void => {
    const values = valuesByBadge.get(badge) ?? new Set<string>();
    values.add(value);
    valuesByBadge.set(badge, values);
  };
  for (const node of textDoc.content) {
    nodeKinds.push(node.type === "heading" ? `h${node.attrs.level}` : "p");
    const inlineParts: string[] = [];
    for (const inline of node.content ?? []) {
      if (inline.type === "hardBreak") {
        inlineParts.push(" ");
        continue;
      }
      inlineParts.push(inline.text);
      for (const mark of inline.marks ?? []) {
        switch (mark.type) {
          case "bold":
          case "italic":
          case "underline":
          case "strike":
          case "link":
            recordBadge(mark.type);
            break;
          case "textStyle":
            if (mark.attrs.fontFamily !== undefined) recordBadge("font", firstFontFamily(mark.attrs.fontFamily));
            if (mark.attrs.color !== undefined) recordBadge("color", mark.attrs.color);
            if (mark.attrs.fontSize !== undefined) recordBadge("size", mark.attrs.fontSize);
            break;
          case "highlight":
            recordBadge("highlight", mark.attrs.color);
            break;
        }
      }
    }
    nodeTexts.push(inlineParts.join(""));
  }
  return {
    nodeKinds,
    plainText: nodeTexts.join(" | "),
    marksSummary: formatMarksSummary(valuesByBadge),
  };
}

interface TruncateInput {
  text: string;
  maxChars: number;
}

function truncate({ text, maxChars }: TruncateInput): string {
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
}

/**
 * Host portion of a URL, without pulling the full URL into the outline
 * (image srcs are long and rarely what the model needs at skim depth).
 * Non-URL strings (merge tags, mailto:) fall back to a short raw slice.
 */
function extractUrlHost(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
  return match?.[1] ?? truncate({ text: url, maxChars: 30 });
}

/** Property keys already surfaced in the terse line, per type — excluded from "full" extras. */
const SUMMARIZED_PROPERTY_KEYS: Readonly<Partial<Record<Block["type"], readonly string[]>>> = {
  root: ["globals"],
  column: ["widthPercent"],
  text: ["text"],
  button: ["label", "href"],
  image: ["src", "alt", "width"],
  link: ["text", "href"],
  code: ["code", "language"],
  spacer: ["height"],
};

/** "full" depth: every other explicitly-set scalar property, sorted by key. */
function formatExtraProperties(block: Block): string {
  const excludedKeys = SUMMARIZED_PROPERTY_KEYS[block.type] ?? [];
  const parts: string[] = [];
  const properties = block.properties as Record<string, unknown>;
  for (const key of Object.keys(properties).sort()) {
    const value = properties[key];
    if (excludedKeys.includes(key) || value === undefined || typeof value === "object") {
      continue;
    }
    parts.push(`${key}=${String(value)}`);
  }
  return parts.length > 0 ? ` [${parts.join(" ")}]` : "";
}

interface SummarizeBlockInput {
  block: Block;
  maxTextChars: number;
}

/** The type-specific tail of a block line (everything after "<id> <type>"). */
function summarizeBlockProps({ block, maxTextChars }: SummarizeBlockInput): string {
  switch (block.type) {
    case "section":
      return "";
    case "row":
      return ` (${block.childrenIds.length} col)`;
    case "column":
      return block.properties.widthPercent !== undefined
        ? ` ${block.properties.widthPercent}%`
        : "";
    case "text": {
      const summary = summarizeTextDoc(block.properties.text);
      const kinds = summary.nodeKinds.join(",");
      const text = truncate({ text: summary.plainText, maxChars: maxTextChars });
      return ` ${kinds} "${text}"${summary.marksSummary}`;
    }
    case "button":
      return ` "${block.properties.label}" href=${block.properties.href}`;
    case "image": {
      const width =
        block.properties.width !== undefined ? ` w=${block.properties.width}` : "";
      return ` alt="${block.properties.alt}"${width} src=${extractUrlHost(block.properties.src)}`;
    }
    case "link": {
      const text = truncate({ text: block.properties.text, maxChars: maxTextChars });
      return ` "${text}" href=${block.properties.href}`;
    }
    case "code": {
      // First line only — code bodies are long and rarely what the model
      // needs at skim depth (getBlockDetails returns the full snippet).
      const [firstLine = ""] = block.properties.code.split("\n");
      const snippet = truncate({ text: firstLine, maxChars: maxTextChars });
      return ` ${block.properties.language} "${snippet}"`;
    }
    case "spacer":
      return ` h=${block.properties.height}`;
    case "divider":
    case "root":
      return "";
  }
}

// ---------------------------------------------------------------------------
// Outline generation
// ---------------------------------------------------------------------------

interface WalkState {
  doc: EmailDocument;
  lines: string[];
  depth: OutlineDepth;
  maxTextChars: number;
}

interface VisitInput {
  state: WalkState;
  blockId: BlockId;
  indentLevel: number;
}

function visitBlock({ state, blockId, indentLevel }: VisitInput): void {
  const indent = INDENT.repeat(indentLevel);
  const block = state.doc[blockId];
  if (block === undefined) {
    state.lines.push(`${indent}${blockId} (missing)`);
    return;
  }
  if (state.depth === "sections" && block.type === "section") {
    state.lines.push(`${indent}${blockId} section (${block.childrenIds.length} children)`);
    return;
  }
  const props = summarizeBlockProps({ block, maxTextChars: state.maxTextChars });
  const extras = state.depth === "full" ? formatExtraProperties(block) : "";
  state.lines.push(`${indent}${blockId} ${block.type}${props}${extras}`);
  for (const childId of block.childrenIds) {
    visitBlock({ state, blockId: childId, indentLevel: indentLevel + 1 });
  }
}

/**
 * Generate the compressed, reading-order outline of an email document for the
 * model. Plain text, one line per block, deterministic. This is the
 * per-request "fresh tokens" view — regenerate it on every turn (see
 * prompts/document-context.ts for where it sits in the prompt stack).
 */
export function generateDocumentOutline({
  doc,
  options = {},
}: GenerateDocumentOutlineInput): string {
  const { depth = "blocks", maxTextChars = DEFAULT_MAX_TEXT_CHARS } = options;
  const state: WalkState = { doc, lines: [summarizeGlobals(doc)], depth, maxTextChars };
  const root = doc[ROOT_BLOCK_ID];
  const sectionIds = root !== undefined && root.type === "root" ? root.childrenIds : [];
  for (const sectionId of sectionIds) {
    visitBlock({ state, blockId: sectionId, indentLevel: 0 });
  }
  if (sectionIds.length === 0) {
    state.lines.push("(no sections)");
  }
  return state.lines.join("\n");
}
