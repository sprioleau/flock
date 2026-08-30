import type { Operation } from "../operations/ops";
import { ROOT_BLOCK_ID, type BlockId } from "../schema/ids";
import type { TextBlockNode, TextDoc } from "../schema/text";
import type { EmailDocument } from "../store/document";

/*
  `clearContent` — turn a designed email into a reusable skeleton.

  One click strips the WORDS and the PICTURES and leaves everything else
  standing: the layout, the theme, every block's own styling, and the brand
  logo. What comes back is the same email with placeholder copy in it, ready
  to be re-written.

  Deterministic and offline by construction: this module is a pure function of
  the document. It makes no model call and no network call — it only decides
  WHICH existing operations to emit, and the caller applies them through the
  ordinary op path (dispatch → applyOperation → the op log), so the clear
  lands in version history and is revertable like any other edit.

  WHAT IS TOUCHED (one row per block type in the schema union):

    root      — untouched. `properties.globals` IS the theme.
    section   — untouched. Structure and background/padding survive.
    row       — untouched.
    column    — untouched. Widths and alignment survive.
    text      — rewritten NODE BY NODE (a text block's doc may mix a heading
                and several paragraphs): every heading becomes
                "Add heading here" at its ORIGINAL level, every paragraph
                becomes "Add paragraph text here". Per-node `attrs`
                (heading level, the textAlign override) are preserved
                verbatim; inline marks go, because they belonged to words
                that no longer exist. Block properties (alignment, colours,
                padding) are never in the doc, so they survive untouched.
    button    — `label` only. `href` is KEPT (see the note below).
    image     — `src` + `alt`, UNLESS the image is the brand logo, which is
                left exactly as it is (see isBrandLogoBlock).
    divider   — untouched. It carries no content, only a line style.
    link      — `text` only. `href` is KEPT.
    code      — `code` only. Language, theme and line-number setting survive.
    spacer    — untouched. It carries no content, only a height.

  WHY `href` SURVIVES: the owner's ask is to strip the words and the imagery
  and keep the look — a destination is neither. It is wiring, in the same
  family as the layout and the theme this deliberately preserves, and unlike
  copy it cannot be re-derived by looking at the email. A blanked href is also
  not expressible: the schema requires a non-empty string, so "clearing" one
  really means inventing a fake destination, which trades a real link for a
  broken one. Everything visible is replaced; the plumbing stays connected.

  IDEMPOTENT — and a NO-OP the second time: every replacement is skipped when
  the block already carries exactly the placeholder it would be given, so
  running this on an already-cleared document returns an EMPTY operation list
  (no history entry, nothing to undo). Running it twice therefore produces the
  same document as running it once.
*/

/*
  ---------------------------------------------------------------------------
  The placeholders
  ---------------------------------------------------------------------------
*/

/*
  Every heading, at whatever level it already was.
*/
export const CLEARED_HEADING_TEXT = "Add heading here";

/*
  Every paragraph.
*/
export const CLEARED_PARAGRAPH_TEXT = "Add paragraph text here";

/*
  Every button label.
*/
export const CLEARED_BUTTON_LABEL = "Add button text here";

/*
  Every standalone link's visible text.
*/
export const CLEARED_LINK_TEXT = "Add link text here";

/*
  Every code snippet.
*/
export const CLEARED_CODE = "// Add your code here";

/*
  Every non-logo image. The house placeholder host (same generator as the
  section catalog's `placeholderImageUrl`, at its 3:2 default size) — an
  absolute https URL, which is the only kind email clients load.
*/
export const CLEARED_IMAGE_SRC = "https://placehold.co/600x400.png";

/*
  Alt text for a cleared image: honest about being a stand-in.
*/
export const CLEARED_IMAGE_ALT = "Placeholder image";

/*
  ---------------------------------------------------------------------------
  The logo rule
  ---------------------------------------------------------------------------
*/

/*
  Is this image block the brand logo — the one image a clear leaves alone?

  THE RULE: `properties.role === "logo"`, and nothing else.

  That marker is the codebase's own definition of "this image is the logo",
  not an inference: the schema calls it "a semantic marker, not a visual
  property" (schema/blocks.ts), the Blocks panel's Logo preset is literally an
  image block with `role: "logo"` set on it (the web app's block-defaults),
  and brand propagation re-sources images by exactly this test —
  `block.type === "image" && block.properties.role === "logo"` — when a brand
  kit is applied.

  Alt text is deliberately NOT part of the rule. The `"<Brand> logo"` alt
  convention exists (brand propagation WRITES it, and the draft-composition
  clue reader reads it), but it is a downstream label, not the marker: it is
  user-editable free text, it is absent from logos added before a brand kit
  exists, and matching on it would make an ordinary photo captioned "our new
  logo" survive a clear.
*/
export function isBrandLogoBlock(block: EmailDocument[BlockId]): boolean {
  return block.type === "image" && block.properties.role === "logo";
}

/*
  ---------------------------------------------------------------------------
  Text: node-by-node
  ---------------------------------------------------------------------------
*/

/*
  The placeholder a given rich-text node is replaced by.
*/
function getPlaceholderForNode(node: TextBlockNode): string {
  return node.type === "heading" ? CLEARED_HEADING_TEXT : CLEARED_PARAGRAPH_TEXT;
}

/*
  One rich-text node, cleared: same node type, same `attrs` (heading level and
  the per-node alignment override both ride along), a single unformatted run
  of placeholder text as its content.
*/
function clearTextNode(node: TextBlockNode): TextBlockNode {
  const content: TextBlockNode["content"] = [
    { type: "text", text: getPlaceholderForNode(node) },
  ];
  if (node.type === "heading") {
    return { type: "heading", attrs: structuredClone(node.attrs), content };
  }
  return {
    type: "paragraph",
    ...(node.attrs === undefined ? {} : { attrs: structuredClone(node.attrs) }),
    content,
  };
}

/*
  Already exactly this node's placeholder — one unmarked run, nothing else?
*/
function isNodeAlreadyCleared(node: TextBlockNode): boolean {
  const [only] = node.content ?? [];
  return (
    node.content?.length === 1 &&
    only?.type === "text" &&
    only.text === getPlaceholderForNode(node) &&
    only.marks === undefined
  );
}

/*
  The whole doc, cleared node by node.
*/
function clearTextDoc(doc: TextDoc): TextDoc {
  return { type: "doc", content: doc.content.map(clearTextNode) };
}

/*
  ---------------------------------------------------------------------------
  The transform
  ---------------------------------------------------------------------------
*/

/*
  Every block id reachable from the root, in reading order (root, then each
  section and everything beneath it, depth-first). Reading order rather than
  object-key order so the emitted operations — and therefore the history they
  produce — line up with the email as the user sees it. Cycle-safe, though the
  integrity checker already rules cycles out.
*/
function getBlockIdsInReadingOrder(document: EmailDocument): BlockId[] {
  const ordered: BlockId[] = [];
  const visited = new Set<BlockId>();
  const walk = (blockId: BlockId): void => {
    const block = document[blockId];
    if (block === undefined || visited.has(blockId)) {
      return;
    }
    visited.add(blockId);
    ordered.push(blockId);
    for (const childId of block.childrenIds as BlockId[]) {
      walk(childId);
    }
  };
  walk(ROOT_BLOCK_ID);
  return ordered;
}

/*
  Plan a clear: the operations that replace this document's copy and imagery
  with placeholders, in reading order.

  Pure — the document is not touched. An EMPTY array means there is nothing to
  clear (an already-cleared or contentless document); callers should treat
  that as "no change", not as a failure, and dispatch nothing.

  Emits only ordinary operations — `updateText` for rich text and
  `updateBlockProperties` for the single content property of a button, image,
  link or code block — so nothing here needs special handling anywhere in the
  apply engine, the op log, or version history. Property updates name ONLY the
  content keys, and `updateBlockProperties` merges, so every other property on
  a touched block (alignment, colours, widths, padding, borders, the image's
  href, the code block's language) survives.
*/
export function buildClearContentOperations(document: EmailDocument): Operation[] {
  const operations: Operation[] = [];
  for (const blockId of getBlockIdsInReadingOrder(document)) {
    const block = document[blockId];
    if (block === undefined) {
      continue;
    }
    switch (block.type) {
      /*
        Containers and content-free leaves: the structure and the look.
      */
      case "root":
      case "section":
      case "row":
      case "column":
      case "divider":
      case "spacer":
        break;
      case "text": {
        if (block.properties.text.content.every(isNodeAlreadyCleared)) {
          break;
        }
        operations.push({
          name: "updateText",
          blockId: block.id,
          text: clearTextDoc(block.properties.text),
        });
        break;
      }
      case "button": {
        if (block.properties.label === CLEARED_BUTTON_LABEL) {
          break;
        }
        operations.push({
          name: "updateBlockProperties",
          blockId: block.id,
          properties: { label: CLEARED_BUTTON_LABEL },
        });
        break;
      }
      case "image": {
        /*
          The one image a clear never touches.
        */
        if (isBrandLogoBlock(block)) {
          break;
        }
        if (
          block.properties.src === CLEARED_IMAGE_SRC &&
          block.properties.alt === CLEARED_IMAGE_ALT
        ) {
          break;
        }
        operations.push({
          name: "updateBlockProperties",
          blockId: block.id,
          properties: { src: CLEARED_IMAGE_SRC, alt: CLEARED_IMAGE_ALT },
        });
        break;
      }
      case "link": {
        if (block.properties.text === CLEARED_LINK_TEXT) {
          break;
        }
        operations.push({
          name: "updateBlockProperties",
          blockId: block.id,
          properties: { text: CLEARED_LINK_TEXT },
        });
        break;
      }
      case "code": {
        if (block.properties.code === CLEARED_CODE) {
          break;
        }
        operations.push({
          name: "updateBlockProperties",
          blockId: block.id,
          properties: { code: CLEARED_CODE },
        });
        break;
      }
    }
  }
  return operations;
}
