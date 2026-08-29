import { BLOCK_ANNOTATION_ATTRIBUTE } from "../render/blocks/shared";

/**
 * Turning a position in rendered HTML back into the block that produced it.
 *
 * The compatibility checker (./check-compatibility) receives findings shaped
 * like "the element spanning characters 3537-4243 uses `border-radius`, which
 * Outlook ignores". The findings UI can only point at BLOCKS. This module is
 * the bridge, and it is the part of the feature most able to be quietly
 * wrong, so it is worth being precise about what it does and does not know.
 *
 * WHAT MAKES IT POSSIBLE AT ALL: the checker renders the email a second time
 * with `isBlockAnnotated`, which stamps every block's outermost element with
 * `data-flock-block-id`. Without that the correspondence does not exist in
 * any form — the renderer passes `block.id` as a React `key`, and keys are
 * not attributes (see BLOCK_ANNOTATION_ATTRIBUTE for the full note).
 *
 * WHY A TAG SCANNER AND NOT A PARSER: the answer needs element EXTENTS —
 * where each stamped element opens and where it closes — and a DOM would
 * give them only if there were a DOM to build. `apps/web` pins
 * `environment: "node"` for all of `src/**`, so there is no DOMParser and no
 * jsdom anywhere this can run. A dependency that parses to a node tree
 * (htmlparser2, say) would work, but it would be a second HTML parser in the
 * bundle to answer a question a single forward pass answers exactly: the
 * input is not arbitrary web HTML, it is output React Email just produced, so
 * every tag is well-formed and every non-void element is explicitly closed.
 *
 * WHAT IT SKIPS, AND WHY EACH ONE MATTERS
 *
 *   comments   React Email emits React's own `<!--$-->` boundary markers AND
 *              Outlook conditional comments, in two halves — the opening
 *              `<!--[if mso]><table><tr><td><![endif]-->` and, later, the
 *              matching `<!--[if mso]></td></tr></table><![endif]-->`. The
 *              CLOSING half is what makes this load-bearing: read as markup,
 *              its end tags close real elements, so an enclosing block's
 *              extent stops early and every finding after it moves to the
 *              wrong block. caniemail's parser treats these as comments too,
 *              so no finding ever points inside one.
 *   raw text   `<style>` content is CSS, where `<` is not a tag.
 *   void tags  `<img>`, `<br>`, `<hr>` and friends never close, so pushing
 *              them leaves frames on the stack that no end tag ever removes.
 *
 * HOW MUCH OF THAT IS LOAD-BEARING, measured rather than assumed. The
 * tolerant pop below — an end tag with no matching open element is ignored,
 * and a matching one unwinds to ITS frame rather than blindly to the top — is
 * the primary defence, and it absorbs both stray unclosed tags and stray end
 * tags on its own. Deleting the void-element and raw-text handling does NOT
 * change the output for any React Email document: unmatched frames left by a
 * void tag are cleaned up by the same tolerant pop, and React escapes text
 * content, so no `<` ever reaches a `<style>` or `<title>` body. They are kept
 * because a stack that mirrors the document is a much easier thing to reason
 * about than one that is routinely wrong and repaired, but the tests make no
 * claim they are necessary, because a mutation showed they are not.
 */

/**
 * Elements with no end tag. An email renderer emits a small subset of these,
 * but the cost of listing all of them is nothing and the cost of missing one
 * is every range after it being wrong.
 */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements whose content is text, not markup, and must not be scanned. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style", "title", "textarea"]);

/** One stamped element's extent in the annotated HTML. */
export interface BlockRange {
  blockId: string;
  /** Index of the `<` that opens the element. */
  startIndex: number;
  /** Index one past the `>` that closes it — a half-open range. */
  endIndex: number;
}

interface OpenElement {
  tagName: string;
  startIndex: number;
  blockId: string | undefined;
}

/*
  Read the stamp off a start tag, if it has one.

  The attribute value is a block id — `[A-Za-z0-9_]`, never a quote or an
  angle bracket — so matching to the closing double quote is exact rather than
  merely usually right. The renderer always emits double quotes (React does),
  and a stamp that failed to match would cost attribution, never correctness:
  the finding degrades to document-level.
*/
function readBlockId(startTag: string): string | undefined {
  const marker = `${BLOCK_ANNOTATION_ATTRIBUTE}="`;
  const attributeStart = startTag.indexOf(marker);
  if (attributeStart === -1) {
    return undefined;
  }
  const valueStart = attributeStart + marker.length;
  const valueEnd = startTag.indexOf('"', valueStart);
  if (valueEnd === -1) {
    return undefined;
  }
  return startTag.slice(valueStart, valueEnd);
}

/**
 * Scan annotated HTML once and return the extent of every stamped element.
 *
 * Ranges come back in document order of their OPENING tag, which means a
 * parent always precedes its children — the property {@link findBlockIdAt}
 * relies on to pick the innermost match by scanning for the largest start.
 */
export function indexBlockRanges(html: string): BlockRange[] {
  const ranges: BlockRange[] = [];
  const stack: OpenElement[] = [];
  let cursor = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart === -1) {
      break;
    }

    /* Comments and doctype/CDATA-ish declarations: skip wholesale. */
    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      cursor = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }
    if (html.startsWith("<!", tagStart)) {
      const declarationEnd = html.indexOf(">", tagStart);
      cursor = declarationEnd === -1 ? html.length : declarationEnd + 1;
      continue;
    }

    const tagEnd = html.indexOf(">", tagStart);
    if (tagEnd === -1) {
      break;
    }
    const isEndTag = html.startsWith("</", tagStart);
    const nameStart = tagStart + (isEndTag ? 2 : 1);
    const nameMatch = /^[A-Za-z][A-Za-z0-9-]*/.exec(html.slice(nameStart, tagEnd));
    if (nameMatch === null) {
      cursor = tagEnd + 1;
      continue;
    }
    const tagName = nameMatch[0].toLowerCase();

    if (isEndTag) {
      /*
        Pop to the matching open element. `lastIndexOf` rather than a bare
        pop, because a stray unmatched end tag must not unwind an ancestor:
        with no match the tag is ignored, which loses one range at worst.
      */
      const openIndex = stack.map((element) => element.tagName).lastIndexOf(tagName);
      if (openIndex !== -1) {
        for (let index = stack.length - 1; index >= openIndex; index -= 1) {
          const element = stack[index];
          if (element !== undefined && element.blockId !== undefined) {
            ranges.push({
              blockId: element.blockId,
              startIndex: element.startIndex,
              endIndex: tagEnd + 1,
            });
          }
        }
        stack.length = openIndex;
      }
      cursor = tagEnd + 1;
      continue;
    }

    const isSelfClosing = html[tagEnd - 1] === "/";
    if (!isSelfClosing && !VOID_ELEMENTS.has(tagName)) {
      if (RAW_TEXT_ELEMENTS.has(tagName)) {
        /* Jump the whole element: its content is text, not markup. */
        const closing = html.indexOf(`</${tagName}`, tagEnd + 1);
        cursor = closing === -1 ? html.length : closing;
        continue;
      }
      stack.push({
        tagName,
        startIndex: tagStart,
        blockId: readBlockId(html.slice(tagStart, tagEnd + 1)),
      });
    }
    cursor = tagEnd + 1;
  }

  /*
    Ranges are emitted when an element CLOSES, so the array is in closing
    order — innermost first. Sorting by opening index restores document
    order, which is what makes "largest start that still contains the span"
    equal to "innermost enclosing block".
  */
  return ranges.sort((left, right) => left.startIndex - right.startIndex);
}

/**
 * The block that owns a span of the annotated HTML, or undefined when the
 * span belongs to markup no block produced.
 *
 * `undefined` is a real answer, not a failure: the `<html>`, `<head>` and
 * `<body>` elements come from the document root's own rendering, and a
 * finding about them is honestly document-level. Attaching it to whichever
 * block happened to be nearby is the one outcome worth avoiding.
 *
 * Containment is STRICT — the block's range must cover the whole span, not
 * merely overlap it. An overlapping-but-not-containing span cannot come from
 * a block's own subtree in well-formed HTML, so treating overlap as a match
 * could only ever invent an attribution.
 */
export function findBlockIdAt({
  ranges,
  startIndex,
  endIndex,
}: {
  ranges: readonly BlockRange[];
  startIndex: number;
  endIndex: number;
}): string | undefined {
  let match: string | undefined;
  for (const range of ranges) {
    if (range.startIndex > startIndex) {
      /* Sorted by start: nothing further can open at or before the span. */
      break;
    }
    if (range.endIndex >= endIndex) {
      match = range.blockId;
    }
  }
  return match;
}

/**
 * Convert caniemail's 1-based line/column position into a half-open index
 * range over the same string.
 *
 * caniemail reports an element's FULL extent (verified against its output,
 * not assumed): start at the `<` and end at the final `>` INCLUSIVE, which is
 * why the end index adds the column rather than one less than it. Emails are
 * rendered unprettified and therefore usually a single line, but the line
 * table costs one pass and removes the need to rely on that.
 */
export function toIndexRange({
  html,
  start,
  end,
}: {
  html: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
}): { startIndex: number; endIndex: number } {
  const lineStarts: number[] = [0];
  for (let index = 0; index < html.length; index += 1) {
    if (html[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }
  const offsetOf = (line: number) => lineStarts[Math.min(Math.max(line, 1), lineStarts.length) - 1] ?? 0;
  return {
    startIndex: offsetOf(start.line) + start.column - 1,
    endIndex: offsetOf(end.line) + end.column,
  };
}
