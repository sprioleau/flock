import { z } from "zod";
import { applyOperation } from "../operations/apply";
import type { Operation, UpdateTextOperation } from "../operations/ops";
import { textBlockIdSchema } from "../schema/ids";
import type {
  InlineNode,
  TextBlockNode,
  TextDoc,
  TextMark,
  TextNode,
} from "../schema/text";
import type { EmailDocument } from "../store/document";
import {
  defineEmailAction,
  type ResolveContentOperationResult,
  type ResolvedOperationError,
} from "./define";

/**
 * `styleTextSpan` — the intent-level span-styling action.
 *
 * THE PRINCIPLE (owner working agreement): LLM-facing tools take SIMPLE
 * intent-level args; ALL complexity lives inside the tool as a deterministic
 * translation. The model says "make 'your partner builds' bold and green" as
 * `{ blockId, find, style }` — it NEVER sees or produces rich-text JSON. This
 * module is that translation: locate the exact text in the block's CURRENT
 * TextDoc, split/merge text nodes, apply or remove marks on exactly that
 * span, and emit ONE canonical `updateText` operation for the history spine.
 *
 * Everything here is pure and deterministic: same doc + same input → same
 * output, no I/O. The Convex mutation (convex/agentText.applyAgentStyleTextSpan)
 * and the editor store's optimistic apply are thin wrappers over
 * {@link resolveStyleTextSpanOperation}.
 */

// ---------------------------------------------------------------------------
// Input schema (what the model sees — refined for LLM clarity)
// ---------------------------------------------------------------------------

/** The style changes for one span. Booleans toggle marks; values set, null removes. */
export const styleTextSpanStyleSchema = z
  .strictObject({
    bold: z
      .boolean()
      .optional()
      .describe("true makes the span bold; false removes bold from it; omit to leave bold unchanged."),
    italic: z
      .boolean()
      .optional()
      .describe("true makes the span italic; false removes italic; omit to leave unchanged."),
    underline: z
      .boolean()
      .optional()
      .describe("true underlines the span; false removes the underline; omit to leave unchanged."),
    strike: z
      .boolean()
      .optional()
      .describe("true strikes the span through; false removes strikethrough; omit to leave unchanged."),
    fontFamily: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "Span-level font override: a CSS stack of email-safe fonts (e.g. \"Georgia, 'Times New Roman', serif\"). Pass null to remove an existing font override; omit to leave unchanged.",
      ),
    textColor: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'Text color for the span as a hex value (e.g. "#c0392b"). Pass null to remove an existing span color; omit to leave unchanged.',
      ),
    fontSizePx: z
      .number()
      .int()
      .min(8)
      .max(96)
      .nullable()
      .optional()
      .describe(
        "Font size for the span in pixels, as a plain number (e.g. 18). Pass null to remove an existing span size; omit to leave unchanged.",
      ),
    highlightColor: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'Background highlight painted behind the span, as a hex value (e.g. "#fff3a3"). Pass null to remove an existing highlight; omit to leave unchanged.',
      ),
    linkHref: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "Turn the span into a hyperlink to this destination: an absolute https:// URL, a mailto: address, or a merge tag like *|UNSUB|*. Pass null to remove an existing link; omit to leave unchanged.",
      ),
  })
  .refine((style) => Object.values(style).some((value) => value !== undefined), {
    message: "style must set at least one property.",
  })
  .describe(
    "The style changes to apply to the span. Booleans: true applies the mark, false removes it. Value fields: a value sets it, null removes it. Omitted fields are left exactly as they are.",
  );

export type StyleTextSpanStyle = z.infer<typeof styleTextSpanStyleSchema>;

/** Which occurrence(s) of `find` to style. */
export const styleTextSpanOccurrenceSchema = z
  .union([
    z
      .number()
      .int()
      .min(1)
      .describe("The 1-based index of the occurrence to style (1 = first match in reading order)."),
    z.literal("all").describe("Style every occurrence of the text."),
  ])
  .describe('Which occurrence of `find` to style: a 1-based index, or "all" for every occurrence.');

export type StyleTextSpanOccurrence = z.infer<typeof styleTextSpanOccurrenceSchema>;

export const styleTextSpanInputSchema = z
  .strictObject({
    name: z.literal("styleTextSpan").describe("Action discriminator."),
    blockId: textBlockIdSchema.describe(
      'Id of the text block containing the text to style, exactly as it appears in the outline (e.g. "txt_r7s8").',
    ),
    find: z
      .string()
      .min(1)
      .refine((text) => text.trim().length > 0, {
        message: "find must contain non-whitespace text.",
      })
      .describe(
        "The exact text to style, copied from the block's current content (the outline shows it truncated; getBlockDetails has the full text). Case-sensitive; runs of whitespace match flexibly. A span cannot cross a paragraph or heading boundary.",
      ),
    occurrence: styleTextSpanOccurrenceSchema.optional().describe(
      'Which occurrence of `find` to style when the text appears more than once: a 1-based index (1 = first) or "all" for every occurrence. Omit for the first occurrence.',
    ),
    style: styleTextSpanStyleSchema,
  })
  .describe(
    "Styles an exact span of EXISTING text inside one text block: bold/italic/underline/strike, font family, text color, font size, highlight, or a link on just that span. Locates `find` in the block's current text and changes only formatting — the words themselves are never changed. Use updateText instead when the text content must change.",
  );

export type StyleTextSpanInput = z.infer<typeof styleTextSpanInputSchema>;

// ---------------------------------------------------------------------------
// Mark algebra (pure)
// ---------------------------------------------------------------------------

/**
 * A text run's marks flattened into one explicit state record — the closed
 * mark vocabulary makes this lossless, and it gives set/remove semantics a
 * place to operate before the marks are rebuilt in canonical order.
 */
interface SpanMarkState {
  isBold: boolean;
  isItalic: boolean;
  isUnderline: boolean;
  isStrike: boolean;
  linkHref: string | undefined;
  fontFamily: string | undefined;
  color: string | undefined;
  fontSize: string | undefined;
  highlightColor: string | undefined;
}

function readMarkState(marks: readonly TextMark[] | undefined): SpanMarkState {
  const state: SpanMarkState = {
    isBold: false,
    isItalic: false,
    isUnderline: false,
    isStrike: false,
    linkHref: undefined,
    fontFamily: undefined,
    color: undefined,
    fontSize: undefined,
    highlightColor: undefined,
  };
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case "bold":
        state.isBold = true;
        break;
      case "italic":
        state.isItalic = true;
        break;
      case "underline":
        state.isUnderline = true;
        break;
      case "strike":
        state.isStrike = true;
        break;
      case "link":
        state.linkHref = mark.attrs.href;
        break;
      case "textStyle":
        state.fontFamily = mark.attrs.fontFamily;
        state.color = mark.attrs.color;
        state.fontSize = mark.attrs.fontSize;
        break;
      case "highlight":
        state.highlightColor = mark.attrs.color;
        break;
    }
  }
  return state;
}

/** Apply the style's set/remove semantics to a mark state (returns a new state). */
function applyStyleToMarkState(state: SpanMarkState, style: StyleTextSpanStyle): SpanMarkState {
  const next = { ...state };
  if (style.bold !== undefined) next.isBold = style.bold;
  if (style.italic !== undefined) next.isItalic = style.italic;
  if (style.underline !== undefined) next.isUnderline = style.underline;
  if (style.strike !== undefined) next.isStrike = style.strike;
  if (style.linkHref !== undefined) next.linkHref = style.linkHref ?? undefined;
  if (style.fontFamily !== undefined) next.fontFamily = style.fontFamily ?? undefined;
  if (style.textColor !== undefined) next.color = style.textColor ?? undefined;
  if (style.fontSizePx !== undefined) {
    next.fontSize = style.fontSizePx === null ? undefined : `${style.fontSizePx}px`;
  }
  if (style.highlightColor !== undefined) {
    next.highlightColor = style.highlightColor ?? undefined;
  }
  return next;
}

/**
 * Rebuild a schema-valid mark array from a state, in the canonical order
 * (the textMarkSchema union order). Returns undefined for an unmarked run —
 * the schema-preferred spelling over an empty array. An empty textStyle mark
 * is never emitted (the schema requires at least one attribute).
 */
function buildMarks(state: SpanMarkState): TextMark[] | undefined {
  const marks: TextMark[] = [];
  if (state.isBold) marks.push({ type: "bold" });
  if (state.isItalic) marks.push({ type: "italic" });
  if (state.isUnderline) marks.push({ type: "underline" });
  if (state.isStrike) marks.push({ type: "strike" });
  if (state.linkHref !== undefined) marks.push({ type: "link", attrs: { href: state.linkHref } });
  if (state.fontFamily !== undefined || state.color !== undefined || state.fontSize !== undefined) {
    marks.push({
      type: "textStyle",
      attrs: {
        ...(state.fontFamily !== undefined ? { fontFamily: state.fontFamily } : {}),
        ...(state.color !== undefined ? { color: state.color } : {}),
        ...(state.fontSize !== undefined ? { fontSize: state.fontSize } : {}),
      },
    });
  }
  if (state.highlightColor !== undefined) {
    marks.push({ type: "highlight", attrs: { color: state.highlightColor } });
  }
  return marks.length > 0 ? marks : undefined;
}

/** Order-insensitive identity of a mark set, for adjacent-run merging. */
function markSetKey(marks: readonly TextMark[] | undefined): string {
  const keys = (marks ?? []).map((mark) => {
    if (mark.type === "textStyle") {
      const { fontFamily, color, fontSize } = mark.attrs;
      return `textStyle:${JSON.stringify([fontFamily ?? null, color ?? null, fontSize ?? null])}`;
    }
    if (mark.type === "link") return `link:${JSON.stringify(mark.attrs.href)}`;
    if (mark.type === "highlight") return `highlight:${JSON.stringify(mark.attrs.color)}`;
    return mark.type;
  });
  return keys.sort().join("|");
}

// ---------------------------------------------------------------------------
// Span location & application (pure)
// ---------------------------------------------------------------------------

/** One resolved match: char range [start, end) in a block node's flat text. */
interface SpanMatch {
  nodeIndex: number;
  start: number;
  end: number;
}

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * `find` as a regex: exact text, but any whitespace run in `find` matches any
 * whitespace run in the doc (spaces, hard breaks) — "normalize whitespace
 * sensibly" without ever editing the doc's actual characters.
 */
function buildFindPattern(find: string): RegExp {
  const escaped = find.trim().replace(REGEXP_SPECIALS, "\\$&");
  return new RegExp(escaped.replace(/\s+/g, "\\s+"), "g");
}

/**
 * A block node's inline content flattened to one string: text runs verbatim,
 * each hard break as "\n" (one char, so offsets map 1:1 back to inline nodes;
 * "\n" also lets the flexible-whitespace pattern match across breaks).
 */
function flattenNodeText(node: TextBlockNode): string {
  let text = "";
  for (const inline of node.content ?? []) {
    text += inline.type === "hardBreak" ? "\n" : inline.text;
  }
  return text;
}

/** All matches of the pattern across the doc, in reading order. */
function findMatches(doc: TextDoc, find: string): SpanMatch[] {
  const matches: SpanMatch[] = [];
  for (const [nodeIndex, node] of doc.content.entries()) {
    const flatText = flattenNodeText(node);
    const pattern = buildFindPattern(find);
    for (const match of flatText.matchAll(pattern)) {
      if (match[0].length > 0) {
        matches.push({ nodeIndex, start: match.index, end: match.index + match[0].length });
      }
    }
  }
  return matches;
}

/** Coalesce adjacent text runs whose (order-insensitive) mark sets are identical. */
function mergeAdjacentTextNodes(content: InlineNode[]): InlineNode[] {
  const merged: InlineNode[] = [];
  for (const inline of content) {
    const previous = merged[merged.length - 1];
    if (
      inline.type === "text" &&
      previous !== undefined &&
      previous.type === "text" &&
      markSetKey(previous.marks) === markSetKey(inline.marks)
    ) {
      merged[merged.length - 1] = { ...previous, text: previous.text + inline.text };
      continue;
    }
    merged.push(inline);
  }
  return merged;
}

/** Build the styled text run, omitting `marks` entirely for an unmarked run. */
function buildTextNode(text: string, marks: TextMark[] | undefined): TextNode {
  return { type: "text", text, ...(marks !== undefined ? { marks } : {}) };
}

/**
 * Rebuild one block node's inline content with the style applied to the given
 * char ranges: text runs are split at range boundaries, covered pieces get
 * the transformed marks, hard breaks pass through untouched, and adjacent
 * identical-mark runs are re-merged so the output stays canonical.
 */
function applyStyleToNodeContent({
  content,
  ranges,
  style,
}: {
  content: readonly InlineNode[];
  ranges: readonly SpanMatch[];
  style: StyleTextSpanStyle;
}): InlineNode[] {
  const rebuilt: InlineNode[] = [];
  let offset = 0;
  for (const inline of content) {
    if (inline.type === "hardBreak") {
      rebuilt.push(inline);
      offset += 1;
      continue;
    }
    const nodeStart = offset;
    const nodeEnd = offset + inline.text.length;
    const cutPoints = new Set<number>([nodeStart, nodeEnd]);
    for (const range of ranges) {
      if (range.start > nodeStart && range.start < nodeEnd) cutPoints.add(range.start);
      if (range.end > nodeStart && range.end < nodeEnd) cutPoints.add(range.end);
    }
    const boundaries = [...cutPoints].sort((a, b) => a - b);
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const segmentStart = boundaries[index]!;
      const segmentEnd = boundaries[index + 1]!;
      const segmentText = inline.text.slice(segmentStart - nodeStart, segmentEnd - nodeStart);
      if (segmentText.length === 0) continue;
      const isCovered = ranges.some(
        (range) => segmentStart >= range.start && segmentEnd <= range.end,
      );
      if (isCovered) {
        const marks = buildMarks(applyStyleToMarkState(readMarkState(inline.marks), style));
        rebuilt.push(buildTextNode(segmentText, marks));
      } else {
        rebuilt.push(buildTextNode(segmentText, inline.marks));
      }
    }
    offset = nodeEnd;
  }
  return mergeAdjacentTextNodes(rebuilt);
}

// ---------------------------------------------------------------------------
// The pure translation
// ---------------------------------------------------------------------------

export interface ApplySpanStyleInput {
  /** The text block's CURRENT rich-text doc. Never mutated. */
  text: TextDoc;
  /** The exact text to locate (whitespace runs match flexibly). */
  find: string;
  /** 1-based occurrence index or "all". Defaults to 1. */
  occurrence?: StyleTextSpanOccurrence;
  style: StyleTextSpanStyle;
}

export type ApplySpanStyleResult =
  | {
      isOk: true;
      /** The resulting doc with marks applied to exactly the located span(s). */
      text: TextDoc;
      /** Total occurrences of `find` in the doc (styled: 1, or all of them). */
      matchCount: number;
    }
  | {
      isOk: false;
      reason: "span_not_found" | "occurrence_out_of_range";
      /** Total occurrences found (0 for span_not_found). */
      matchCount: number;
    };

/**
 * The pure span-styling translation: locate `find` in the doc, apply the
 * style to exactly that span (splitting/merging text runs as needed), return
 * the new doc. Deterministic; the input doc is never mutated.
 */
export function applySpanStyle({
  text,
  find,
  occurrence = 1,
  style,
}: ApplySpanStyleInput): ApplySpanStyleResult {
  const matches = findMatches(text, find);
  if (matches.length === 0) {
    return { isOk: false, reason: "span_not_found", matchCount: 0 };
  }
  let selectedMatches: SpanMatch[];
  if (occurrence === "all") {
    selectedMatches = matches;
  } else {
    const match = matches[occurrence - 1];
    if (match === undefined) {
      return { isOk: false, reason: "occurrence_out_of_range", matchCount: matches.length };
    }
    selectedMatches = [match];
  }

  const rangesByNodeIndex = new Map<number, SpanMatch[]>();
  for (const match of selectedMatches) {
    const nodeRanges = rangesByNodeIndex.get(match.nodeIndex) ?? [];
    nodeRanges.push(match);
    rangesByNodeIndex.set(match.nodeIndex, nodeRanges);
  }

  const content = text.content.map((node, nodeIndex): TextBlockNode => {
    const ranges = rangesByNodeIndex.get(nodeIndex);
    if (ranges === undefined || node.content === undefined) {
      return node;
    }
    return { ...node, content: applyStyleToNodeContent({ content: node.content, ranges, style }) };
  });

  return { isOk: true, text: { ...text, content }, matchCount: matches.length };
}

// ---------------------------------------------------------------------------
// Intent → canonical operation resolution
// ---------------------------------------------------------------------------

/** Plain-text view of a doc for error messages — mirrors the outline's format. */
function toPlainText(text: TextDoc): string {
  return text.content
    .map((node) =>
      (node.content ?? []).map((inline) => (inline.type === "hardBreak" ? " " : inline.text)).join(""),
    )
    .join(" | ");
}

const ERROR_SNIPPET_MAX_CHARS = 200;

function truncateSnippet(text: string): string {
  return text.length > ERROR_SNIPPET_MAX_CHARS
    ? `${text.slice(0, ERROR_SNIPPET_MAX_CHARS).trimEnd()}…`
    : text;
}

export type ResolveStyleTextSpanResult =
  | { isOk: true; op: UpdateTextOperation }
  | { isOk: false; errors: ResolvedOperationError[] };

export interface ResolveStyleTextSpanOperationInput {
  /** The document holding the target block's CURRENT text. Never mutated. */
  doc: EmailDocument;
  /** Validated styleTextSpan input. */
  input: StyleTextSpanInput;
}

/**
 * The deterministic intent→operation translation: resolve a styleTextSpan
 * input against a document into ONE canonical `updateText` operation (the op
 * that goes on the history spine). Every failure is a structured, retryable
 * repair hint — a not-found error names the block's ACTUAL current text so
 * the model can copy it verbatim and self-correct.
 */
export function resolveStyleTextSpanOperation({
  doc,
  input,
}: ResolveStyleTextSpanOperationInput): ResolveStyleTextSpanResult {
  const block = doc[input.blockId];
  if (block === undefined) {
    return {
      isOk: false,
      errors: [
        {
          code: "target_not_found",
          message: `No block "${input.blockId}" exists in the document. Use a text block id exactly as it appears in the document outline.`,
          blockId: input.blockId,
        },
      ],
    };
  }
  if (block.type !== "text") {
    return {
      isOk: false,
      errors: [
        {
          code: "wrong_block_type",
          message: `Block "${input.blockId}" is a ${block.type} block; styleTextSpan only styles text blocks.`,
          blockId: input.blockId,
        },
      ],
    };
  }
  const result = applySpanStyle({
    text: block.properties.text,
    find: input.find,
    occurrence: input.occurrence,
    style: input.style,
  });
  if (!result.isOk) {
    const message =
      result.reason === "span_not_found"
        ? `The text "${input.find}" was not found in text block ${input.blockId}. The block currently reads: "${truncateSnippet(toPlainText(block.properties.text))}". Copy \`find\` exactly from this current text (a span cannot cross a paragraph or heading boundary).`
        : `Only ${result.matchCount} occurrence(s) of "${input.find}" exist in text block ${input.blockId}, so occurrence ${String(input.occurrence)} is out of range. Use an index between 1 and ${result.matchCount}, or "all".`;
    return {
      isOk: false,
      errors: [{ code: "span_not_found", message, blockId: input.blockId }],
    };
  }
  return {
    isOk: true,
    op: { name: "updateText", blockId: input.blockId, text: result.text },
  };
}

// ---------------------------------------------------------------------------
// The action definition
// ---------------------------------------------------------------------------

/**
 * The styleTextSpan content action. `resolveOperation` is the intent→op
 * translation above; per the dispatch contract (see dispatchContentAction),
 * `run` therefore receives the RESOLVED `updateText` operation — the op log,
 * undo/redo, and AI-batch revert only ever see a standard replayable op.
 */
export const styleTextSpanAction = defineEmailAction({
  name: "styleTextSpan",
  description:
    "Style an exact span of text INSIDE a text block without rewriting it: bold, italic, underline, strike, font family, text color, font size, highlight color, or a link on just that span. Give the exact text to find (as it appears in the block), which occurrence, and only the style properties to change. Use this for styling and emphasis of existing text; use updateText only when the words themselves change.",
  kind: "content",
  schema: styleTextSpanInputSchema,
  readOnly: false,
  parallelSafe: true, // span styles on distinct blocks are independent (updateText rationale)
  needsApproval: false,
  resolveOperation: (doc, input) => resolveStyleTextSpanOperation({ doc, input }),
  // dispatchContentAction calls run with the RESOLVED updateText operation
  // (never the raw intent input), hence the cast.
  run: (doc, input) => applyOperation(doc, input as unknown as Operation),
});
