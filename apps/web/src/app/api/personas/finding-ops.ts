import {
  applyOperations,
  createTextDoc,
  updateBlockPropertiesOperationSchema,
  updateTextOperationSchema,
  type Block,
  type EmailDocument,
  type Operation,
  type TextBlockNode,
  type TextNode,
} from "@flock/email-sdk";
import type { z } from "zod";
import { stableStringify } from "@/lib/suggestions/serialize-block";
import type { proposedCopyEditSchema, proposedEditSchema } from "./finding-schema";

/*
  Intent-level proposed edits → real, dry-run-validated operations.

  This is the deterministic half of the persona contract (finding-schema.ts
  holds the model-facing half). The model never emits an operation: it emits
  scalar property values and plain-text rewrites, and everything structural —
  grouping edits per block, coercing "24" to 24, rebuilding a rich-text doc —
  happens here, against THIS run's document, where it can be checked.

  The failure mode is uniform and deliberate: every function that cannot
  compose a faithful op returns null, the route drops the finding's ops
  entirely, and the finding surfaces as informational with its chat handoff.
  A persona never half-applies a fix.
*/

type ProposedEdit = z.infer<typeof proposedEditSchema>;
type ProposedCopyEdit = z.infer<typeof proposedCopyEditSchema>;

/*
  Runaway-rewrite guard. A copy edit's text is written into the user's email,
  so it is refused rather than truncated when it is absurd (finding-schema.ts
  explains why truncation is wrong here). The bound is generous — an entire
  long email body block is well under it — because its job is to catch a model
  that has started generating a document, not to police word count.
*/
const MAX_COPY_EDIT_CHARS = 2_000;

/*
  Sanity bound on how many paragraphs one rewrite may produce. A text block in
  this product is a heading plus a paragraph or two; a rewrite that claims
  twenty is a model that has misunderstood the field, not a copy fix.
*/
const MAX_COPY_EDIT_LINES = 12;

/** Deterministic coercion of the model's string values to property scalars. */
function coercePropertyValue(raw: string): string | number | boolean {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

/*
  The model is asked for one line per block-level node, newline separated.

  THE ` | ` FALLBACK is a deliberate near-miss repair (the same posture as
  api/chat/tool-input-normalizer.ts): the outline the persona reads renders a
  text block's nodes joined with " | ", so a model that echoes that separator
  back instead of a newline has understood the instruction perfectly and typed
  the wrong character. It is only tried when newlines produced a single line
  for a multi-node block — never as the primary split — so ordinary copy that
  happens to contain a pipe is untouched.
*/
function splitRewriteLines({ text, nodeCount }: { text: string; nodeCount: number }): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 1 && nodeCount > 1) {
    const pipeSeparated = lines[0]!
      .split(/\s+\|\s+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (pipeSeparated.length > 1) {
      return pipeSeparated;
    }
  }
  return lines;
}

/*
  Rewrite ONE existing node's words while keeping everything about it that the
  model was never asked about: whether it is a heading or a paragraph, its
  heading level, its per-node alignment override.

  MARKS ARE THE HARD CASE. A whole-doc replacement cannot preserve inline
  formatting positionally — the words the marks covered no longer exist. Where
  a node is formatted UNIFORMLY (every run carrying the identical mark set:
  the footer's 12px small print, a paragraph that is entirely one link) the
  rewrite simply wears the same marks and nothing is lost. Where the node's
  formatting VARIES from run to run, there is no honest answer, and the answer
  this returns is null — because the alternative is a "copy fix" that silently
  strips two hyperlinks out of a footer. Refusing costs the user nothing: the
  finding still describes the rewrite and still offers the chat handoff, which
  can do what a whole-doc replacement cannot.
*/
function composeRewrittenNode({
  existingNode,
  line,
}: {
  existingNode: TextBlockNode;
  line: string;
}): TextBlockNode | null {
  const runs = (existingNode.content ?? []).filter(
    (node): node is TextNode => node.type === "text",
  );
  const markSignatures = new Set(runs.map((run) => stableStringify(run.marks ?? [])));
  if (markSignatures.size > 1) {
    return null;
  }
  const marks = runs[0]?.marks;
  return {
    ...existingNode,
    content: [{ type: "text", text: line, ...(marks !== undefined ? { marks } : {}) }],
  };
}

/*
  One plain-text rewrite → one `updateText` operation carrying a complete,
  schema-valid rich-text doc.

  THE STRUCTURE COMES FROM THE BLOCK, NOT THE MODEL. Line i replaces node i's
  words in place, so an h1 stays an h1 at its level and a centred paragraph
  stays centred — the model is never asked to describe (and so can never get
  wrong) anything but the words. Lines beyond the block's existing nodes land
  as plain paragraphs built by the SDK's own createTextDoc, the same helper
  the starter document and the block defaults use to make text from a string.

  A rewrite with FEWER lines than the block has nodes is REFUSED rather than
  applied: dropping the trailing nodes would delete a paragraph the persona
  said nothing about, and "the fix deleted my copy" is a far worse outcome
  than "the fix was offered as a chat prompt instead".
*/
function composeCopyEditOp({
  doc,
  copyEdit,
}: {
  doc: EmailDocument;
  copyEdit: ProposedCopyEdit;
}): Operation | null {
  const block: Block | undefined = doc[copyEdit.blockId];
  if (block === undefined || block.type !== "text") {
    return null;
  }
  const existingNodes = block.properties.text.content;
  const lines = splitRewriteLines({ text: copyEdit.text, nodeCount: existingNodes.length });
  if (
    lines.length < existingNodes.length ||
    lines.length > MAX_COPY_EDIT_LINES ||
    lines.join("").length > MAX_COPY_EDIT_CHARS
  ) {
    return null;
  }
  const content: TextBlockNode[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const existingNode = existingNodes[lineIndex];
    if (existingNode === undefined) {
      content.push(...createTextDoc(line).content);
      continue;
    }
    const rewritten = composeRewrittenNode({ existingNode, line });
    if (rewritten === null) {
      return null;
    }
    content.push(rewritten);
  }
  const parsed = updateTextOperationSchema.safeParse({
    name: "updateText",
    blockId: copyEdit.blockId,
    text: { type: "doc", content },
  });
  return parsed.success ? parsed.data : null;
}

/** Property edits for ONE block, merged into a single validated op. */
function composePropertyOps({ proposedEdits }: { proposedEdits: readonly ProposedEdit[] }):
  | Operation[]
  | null {
  const propertiesByBlockId = new Map<string, Record<string, unknown>>();
  for (const edit of proposedEdits) {
    const properties = propertiesByBlockId.get(edit.blockId) ?? {};
    properties[edit.property] = coercePropertyValue(edit.value);
    propertiesByBlockId.set(edit.blockId, properties);
  }
  const ops: Operation[] = [];
  for (const [blockId, properties] of propertiesByBlockId) {
    const parsed = updateBlockPropertiesOperationSchema.safeParse({
      name: "updateBlockProperties",
      blockId,
      properties,
    });
    if (!parsed.success) {
      return null;
    }
    ops.push(parsed.data);
  }
  return ops;
}

/*
  A finding's proposed edits → the batch a human's one Apply press dispatches.

  Both halves of the union compose into ONE batch, dry-run together against
  this run's document: a finding that recolors a button and rewrites the
  paragraph above it applies in one press and reverts in one press. Null when
  anything fails to compose or the batch does not apply — the finding then
  surfaces as informational instead of carrying broken ops. An empty array
  (nothing proposed) is a legal, non-null answer: an informational finding.
*/
export function composeFindingOps({
  doc,
  proposedEdits = [],
  proposedCopyEdits = [],
}: {
  doc: EmailDocument;
  proposedEdits?: readonly ProposedEdit[];
  proposedCopyEdits?: readonly ProposedCopyEdit[];
}): Operation[] | null {
  const propertyOps = composePropertyOps({ proposedEdits });
  if (propertyOps === null) {
    return null;
  }
  const ops = [...propertyOps];
  for (const copyEdit of proposedCopyEdits) {
    const op = composeCopyEditOp({ doc, copyEdit });
    if (op === null) {
      return null;
    }
    ops.push(op);
  }
  if (ops.length === 0) {
    return [];
  }
  return applyOperations(doc, ops).isOk ? ops : null;
}
