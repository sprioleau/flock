import type { JSONContent } from "@tiptap/core";
import type {
  HeadingNode,
  InlineNode,
  ParagraphNode,
  TextAlign,
  TextBlockNode,
  TextDoc,
  TextMark,
} from "@tandem/email-sdk";

/**
 * Editor JSON → SDK text-doc normalization.
 *
 * The SDK's `textDocSchema` is STRICT: unknown node types, unknown mark
 * types, and unknown/extra attributes all fail validation. The reduced
 * StarterKit (text-block-extensions.ts) already keeps the editor's node
 * vocabulary aligned with the SDK's (paragraph/heading/text/hardBreak,
 * bold/italic/underline/strike/link — same names on both sides), so
 * normalization is about stripping the editor's extras:
 *
 * - link marks: Tiptap's Link mark carries `target`, `rel`, and `class`
 *   attrs (and `openOnClick` UI state) — only `href` survives; empty-href
 *   links are dropped entirely.
 * - textStyle marks: Tiptap emits every registered attr with `null` for the
 *   unset ones — only non-empty fontFamily/color/fontSize strings survive; a
 *   textStyle mark with no surviving attrs is dropped entirely (the SDK
 *   schema rejects empty textStyle marks).
 * - highlight marks: only a non-empty `color` survives (multicolor
 *   highlights); a colorless highlight is dropped — the email renderer needs
 *   an explicit background-color.
 * - hardBreak: may carry marks in Tiptap JSON (a break inside a bold run);
 *   the SDK hardBreak is bare.
 * - heading attrs: only `level` (1-3) and a valid `textAlign` survive; any
 *   other level demotes the node to a paragraph (cannot occur with Heading
 *   configured to [1,2,3], but the boundary is defensive).
 * - paragraph/heading `textAlign` attr (the TextAlign extension's per-node
 *   override): only "left" | "center" | "right" survives — Tiptap emits
 *   `textAlign: null` for unaligned nodes (the extension default), which is
 *   normalized away (missing attr = inherit the block's alignment).
 * - empty text runs and unknown nodes/marks are dropped; an emptied doc
 *   becomes one empty paragraph (textDocSchema requires ≥1 block node).
 *
 * Returns a `TextDoc`-shaped value; callers still validate with
 * `textDocSchema` before dispatching (the schema is the boundary authority).
 */
export function normalizeEditorDoc(editorDoc: JSONContent): TextDoc {
  const content = (editorDoc.content ?? [])
    .map(normalizeBlockNode)
    .filter((node): node is TextBlockNode => node !== null);
  return {
    type: "doc",
    content: content.length > 0 ? content : [{ type: "paragraph" }],
  };
}

function normalizeBlockNode(node: JSONContent): TextBlockNode | null {
  if (node.type === "heading") {
    const level = node.attrs?.level;
    if (level === 1 || level === 2 || level === 3) {
      const textAlign = normalizeTextAlign(node.attrs?.textAlign);
      const heading: HeadingNode = {
        type: "heading",
        attrs: { level, ...(textAlign !== undefined ? { textAlign } : {}) },
      };
      const inline = normalizeInlineNodes(node.content);
      return inline.length > 0 ? { ...heading, content: inline } : heading;
    }
    // Unsupported heading level — keep the text, demote to paragraph.
    return normalizeParagraph(node);
  }
  if (node.type === "paragraph") {
    return normalizeParagraph(node);
  }
  return null;
}

/** Only the SDK's alignment vocabulary survives; null/unknown → inherit. */
function normalizeTextAlign(value: unknown): TextAlign | undefined {
  return value === "left" || value === "center" || value === "right" ? value : undefined;
}

function normalizeParagraph(node: JSONContent): ParagraphNode {
  const textAlign = normalizeTextAlign(node.attrs?.textAlign);
  const attrs = textAlign !== undefined ? { attrs: { textAlign } } : {};
  const inline = normalizeInlineNodes(node.content);
  return inline.length > 0
    ? { type: "paragraph", ...attrs, content: inline }
    : { type: "paragraph", ...attrs };
}

function normalizeInlineNodes(nodes: JSONContent[] | undefined): InlineNode[] {
  const normalized: InlineNode[] = [];
  for (const node of nodes ?? []) {
    if (node.type === "text") {
      if (typeof node.text === "string" && node.text.length > 0) {
        const marks = normalizeMarks(node.marks);
        normalized.push(
          marks !== undefined
            ? { type: "text", text: node.text, marks }
            : { type: "text", text: node.text },
        );
      }
    } else if (node.type === "hardBreak") {
      // Bare — Tiptap may attach marks to breaks; the SDK schema forbids them.
      normalized.push({ type: "hardBreak" });
    }
    // Unknown inline node types are dropped.
  }
  return normalized;
}

function normalizeMarks(marks: JSONContent["marks"]): TextMark[] | undefined {
  const normalized: TextMark[] = [];
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case "bold":
      case "italic":
      case "underline":
      case "strike":
        normalized.push({ type: mark.type });
        break;
      case "link": {
        const href = mark.attrs?.href;
        if (typeof href === "string" && href.length > 0) {
          normalized.push({ type: "link", attrs: { href } });
        }
        break;
      }
      case "textStyle": {
        const attrs = normalizeTextStyleAttrs(mark.attrs);
        if (attrs !== null) {
          normalized.push({ type: "textStyle", attrs });
        }
        break;
      }
      case "highlight": {
        const color = mark.attrs?.color;
        if (typeof color === "string" && color.length > 0) {
          normalized.push({ type: "highlight", attrs: { color } });
        }
        break;
      }
      default:
        // Unknown mark types are dropped.
        break;
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}

type TextStyleAttrs = Extract<TextMark, { type: "textStyle" }>["attrs"];

/**
 * Keep only the SDK's textStyle attrs, each a non-empty string; fontSize must
 * be a pixel value (mirrors the schema's regex — the FontSize extension only
 * ever writes px, but the boundary is defensive). Null when nothing survives,
 * so the caller drops the mark instead of emitting an empty textStyle.
 */
function normalizeTextStyleAttrs(attrs: Record<string, unknown> | undefined): TextStyleAttrs | null {
  const fontFamily = attrs?.fontFamily;
  const color = attrs?.color;
  const fontSize = attrs?.fontSize;
  const normalized: TextStyleAttrs = {
    ...(typeof fontFamily === "string" && fontFamily.length > 0 ? { fontFamily } : {}),
    ...(typeof color === "string" && color.length > 0 ? { color } : {}),
    ...(typeof fontSize === "string" && /^\d+px$/.test(fontSize) ? { fontSize } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : null;
}

/** Structural equality for text docs (key-order independent). */
export function isTextDocEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => isTextDocEqual(item, b[index]));
  }
  if (
    typeof a === "object" &&
    typeof b === "object" &&
    a !== null &&
    b !== null &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const aEntries = Object.entries(a).filter(([, value]) => value !== undefined);
    const bEntries = Object.entries(b).filter(([, value]) => value !== undefined);
    if (aEntries.length !== bEntries.length) {
      return false;
    }
    return aEntries.every(([key, value]) =>
      isTextDocEqual(value, (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}
