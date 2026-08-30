import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";
import {
  applyOperation,
  resolveStyleTextSpanOperation,
  styleTextSpanInputSchema,
  updateTextOperationSchema,
  type TextDoc,
  type UpdateTextOperation,
} from "@flock/email-sdk";
import { v } from "convex/values";
import {
  buildEditorSchema,
  Transform,
} from "../apps/web/src/lib/editorSchema";
import { components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";
import {
  applyContextValidator,
  commitVersions,
  loadDocumentState,
  operationErrorValidator,
  toTransportErrors,
  type ApplyContext,
} from "./model/emailDocuments";
import {
  AI_AGENT_CLIENT_ID,
  buildSyncDocId,
  type SyncDocKey,
} from "./model/textBlockSync";
import { markAgentEditing } from "./presence";

/*
  Phase 5.3 — the AI text-edit path ("session op + mirror", agent half).

  Agent `updateText` ops route here instead of documents.applyOperations
  (see editor-store.ts sendPendingOp). One mutation does BOTH halves
  atomically:

   1. records exactly one standard `updateText` op on the op log through the
      same model-level machinery as every other op (loadDocumentState → SDK
      applyOperation → commitVersions), with agent authorship and the turn's
      batchId — so provenance chips, revertBatch, undo, and the history
      panel work with zero changes; and
   2. if the block has a live ProseMirror sync doc, MERGES the agent's edit
      into it via prosemirror-sync's server-side transform (clientId =
      AI_AGENT_CLIENT_ID) as a minimal targeted replace, so concurrent human
      keystrokes rebase against the agent edit instead of being clobbered.

  All LLM work happened before this mutation (the chat route streams
  validated ops); everything here is cheap, deterministic, and idempotent —
  the transform callback is re-invoked against the freshest doc on conflict
  (Spike B retry semantics), so it recomputes anchors from the live doc
  argument on every invocation and never reuses positions across retries.
*/

const prosemirrorSync = new ProsemirrorSync(components.prosemirrorSync);

/*
  ProseMirror types, derived from the shared schema module so this file needs
  no @tiptap/pm import (unresolvable from the repo-root convex/ dir).
*/
type EditorSchema = ReturnType<typeof buildEditorSchema>;
type PmNode = ReturnType<EditorSchema["nodeFromJSON"]>;
type PmSlice = ReturnType<PmNode["slice"]>;

/*
  Same result shape as documents.applyOperations, so the store's shared ack handler works unchanged.
*/
const applyAgentTextEditResultValidator = v.union(
  v.object({
    isOk: v.literal(true),
    headVersion: v.number(),
    /*
      One version per applied op — always exactly one here.
    */
    appliedVersions: v.array(v.number()),
  }),
  v.object({
    isOk: v.literal(false),
    /*
      Always 0 (single-op mutation); kept for shape parity with applyOperations.
    */
    failedOperationIndex: v.number(),
    errors: v.array(operationErrorValidator),
  }),
);

export const applyAgentTextEdit = mutation({
  args: {
    documentId: v.id("documents"),
    /*
      One UpdateTextOperation JSON payload; SDK-validated before any write.
    */
    op: v.any(),
    /*
      Agent provenance: author "agent", authorId = chat id, the turn's batchId.
    */
    context: applyContextValidator,
  },
  returns: applyAgentTextEditResultValidator,
  handler: async (ctx, args) => {
    const parsedOp = updateTextOperationSchema.safeParse(args.op);
    if (!parsedOp.success) {
      return {
        isOk: false as const,
        failedOperationIndex: 0,
        errors: [
          {
            code: "op_validation_failed",
            message: `Operation failed validation: ${parsedOp.error.issues
              .map((issue) => issue.message)
              .join("; ")}`,
          },
        ],
      };
    }
    const op = parsedOp.data;

    const state = await loadDocumentState(ctx, args.documentId);
    if (state === null) {
      return documentNotFoundResult(args.documentId);
    }

    return await commitAgentUpdateText({ ctx, documentId: args.documentId, state, op, context: args.context });
  },
});

/*
  Phase "styleTextSpan" — the intent-level span-styling path, sibling to
  applyAgentTextEdit. The tool's args are SIMPLE intent (blockId + find +
  occurrence + style); this mutation is the thin server-side wrapper around
  the SDK's pure deterministic translation:

   1. resolveStyleTextSpanOperation locates `find` in the block's CURRENT
      properties.text (the authoritative doc, not the client's snapshot) and
      computes ONE canonical `updateText` op with marks applied to exactly
      that span. Not-found / out-of-range come back as structured retryable
      errors quoting the block's actual text — the model's repair loop hint.
   2. the resolved op then rides the exact applyAgentTextEdit path: one
      standard op row on the history spine (agent author/batchId — provenance
      chips, revertBatch, undo all unchanged) plus the content-anchored
      ProseMirror sync-doc transform for live editors.
*/
export const applyAgentStyleTextSpan = mutation({
  args: {
    documentId: v.id("documents"),
    /*
      One styleTextSpan intent payload; SDK-validated before any write.
    */
    input: v.any(),
    /*
      Agent provenance: author "agent", authorId = chat id, the turn's batchId.
    */
    context: applyContextValidator,
  },
  returns: applyAgentTextEditResultValidator,
  handler: async (ctx, args) => {
    const parsedInput = styleTextSpanInputSchema.safeParse(args.input);
    if (!parsedInput.success) {
      return {
        isOk: false as const,
        failedOperationIndex: 0,
        errors: [
          {
            code: "op_validation_failed",
            message: `styleTextSpan input failed validation: ${parsedInput.error.issues
              .map((issue) => issue.message)
              .join("; ")}`,
          },
        ],
      };
    }

    const state = await loadDocumentState(ctx, args.documentId);
    if (state === null) {
      return documentNotFoundResult(args.documentId);
    }

    /*
      The deterministic intent→operation translation, against the server's doc.
    */
    const resolved = resolveStyleTextSpanOperation({ doc: state.doc, input: parsedInput.data });
    if (!resolved.isOk) {
      return {
        isOk: false as const,
        failedOperationIndex: 0,
        errors: resolved.errors.map((error) => ({
          code: error.code,
          message: error.message,
          ...(error.blockId !== undefined ? { blockId: error.blockId as string } : {}),
          ...(error.relatedBlockId !== undefined
            ? { relatedBlockId: error.relatedBlockId as string }
            : {}),
        })),
      };
    }

    return await commitAgentUpdateText({
      ctx,
      documentId: args.documentId,
      state,
      op: resolved.op,
      context: args.context,
    });
  },
});

function documentNotFoundResult(documentId: Id<"documents">) {
  return {
    isOk: false as const,
    failedOperationIndex: 0,
    errors: [{ code: "target_not_found", message: `Document ${documentId} does not exist.` }],
  };
}

/*
  The shared agent-text commit core ("session op + mirror", both halves):
  apply one updateText op through the SDK engine, record it on the history
  spine with the agent's provenance, pulse agent presence, and merge the edit
  into the block's live ProseMirror sync doc.
*/
async function commitAgentUpdateText({
  ctx,
  documentId,
  state,
  op,
  context,
}: {
  ctx: MutationCtx;
  documentId: Id<"documents">;
  state: NonNullable<Awaited<ReturnType<typeof loadDocumentState>>>;
  op: UpdateTextOperation;
  context: ApplyContext;
}) {
  /*
    The SDK apply engine re-validates the resulting document (schema +
    referential integrity); on failure nothing is written and the errors go
    back to the model's repair loop, exactly like applyOperations.
  */
  const result = applyOperation(state.doc, op);
  if (!result.isOk) {
    return {
      isOk: false as const,
      failedOperationIndex: 0,
      errors: toTransportErrors(result.errors),
    };
  }

  /*
    History-spine half: one standard op row (kind "edit", agent context).
  */
  const commit = await commitVersions({
    ctx,
    state,
    newDoc: result.doc,
    entries: [{ op, inverse: result.inverse, kind: "edit" as const }],
    context,
  });

  /*
    Phase 6.2a agent presence: surface the agent in the document's presence
    room with editingBlockId = this op's block (the "agent is editing…"
    indicator); a scheduled follow-up clears it ~2s later so it pulses.
  */
  await markAgentEditing({ ctx, documentId, blockId: op.blockId });

  /*
    Live-doc half. The inverse of updateText carries the block's previous
    TextDoc (properties.text as of this mutation) — the diff baseline.
  */
  const previousText = result.inverse.name === "updateText" ? result.inverse.text : null;
  await mergeAgentTextIntoSyncDoc({
    ctx,
    key: { documentId, blockId: op.blockId },
    previousText,
    targetText: op.text,
  });

  return { isOk: true as const, ...commit };
}

/*
  Merge an agent text edit into the block's synced ProseMirror doc — a no-op
  when the sync doc does not exist (never-edited block: the op row alone is
  correct, and ensureBlockDoc seeds from properties.text on the next edit).

  The transform runs under AI_AGENT_CLIENT_ID so the UI / Phase 6.2 presence
  can attribute the steps to the agent.
*/
async function mergeAgentTextIntoSyncDoc({
  ctx,
  key,
  previousText,
  targetText,
}: {
  ctx: MutationCtx;
  key: SyncDocKey;
  previousText: TextDoc | null;
  targetText: TextDoc;
}): Promise<void> {
  const syncDocId = buildSyncDocId(key);
  const existingVersion = await ctx.runQuery(components.prosemirrorSync.lib.latestVersion, {
    id: syncDocId,
  });
  if (existingVersion === null) {
    return;
  }
  const schema = buildEditorSchema();
  const targetDoc = schema.nodeFromJSON(targetText);
  let oldDoc: PmNode | null = null;
  if (previousText !== null) {
    try {
      oldDoc = schema.nodeFromJSON(previousText);
    } catch (error) {
      /*
        A pre-schema-era properties.text; the whole-doc fallback covers it.
      */
      console.warn(
        `[agentText] previous text of ${syncDocId} does not parse against the editor schema; merge will use the whole-doc fallback:`,
        error,
      );
    }
  }
  await prosemirrorSync.transform(
    ctx,
    syncDocId,
    schema,
    (liveDoc) => buildAgentMergeTransform({ liveDoc, oldDoc, targetDoc, syncDocId }),
    { clientId: AI_AGENT_CLIENT_ID },
  );
}

/**
 * The transform callback body (idempotent; re-invoked against the freshest
 * doc on rebase). Strategy, in order:
 *
 *  1. live already equals the target → null (nothing to do; also makes
 *     retries cheap no-ops once converged).
 *  2. minimal targeted replace: the old→target diff (common prefix/suffix in
 *     node space) re-anchored against the LIVE doc (see
 *     {@link anchorAgentRangeInLiveDoc}).
 *  3. whole-doc replace with the target — the authoritative-rewrite fallback
 *     for when no sane anchor exists. Always logged, never silent.
 */
function buildAgentMergeTransform({
  liveDoc,
  oldDoc,
  targetDoc,
  syncDocId,
}: {
  liveDoc: PmNode;
  oldDoc: PmNode | null;
  targetDoc: PmNode;
  syncDocId: string;
}): Transform | null {
  if (liveDoc.content.eq(targetDoc.content)) {
    return null;
  }
  if (oldDoc !== null) {
    const agentChange = findMinimalChange({ oldDoc, targetDoc });
    if (agentChange === null) {
      /*
        The op did not change the text (old == target): nothing to merge.
      */
      return null;
    }
    const liveRange = anchorAgentRangeInLiveDoc({ liveDoc, oldDoc, agentChange, syncDocId });
    /*
      Merge trace (log level): one line per transform attempt, invaluable when
      diagnosing anchor choices against the step log (Phase 5.4 will care).
    */
    console.log(
      `[agentText] merge trace ${syncDocId}: agentChange=[${agentChange.from},${agentChange.to}] liveRange=${liveRange === null ? "null" : `[${liveRange.from},${liveRange.to}]`} oldSize=${oldDoc.content.size} liveSize=${liveDoc.content.size} userDiffStart=${String(oldDoc.content.findDiffStart(liveDoc.content))}`,
    );
    if (liveRange !== null) {
      try {
        const tr = new Transform(liveDoc);
        tr.replace(liveRange.from, liveRange.to, agentChange.slice);
        return tr.docChanged ? tr : null;
      } catch (error) {
        console.warn(
          `[agentText] targeted replace [${liveRange.from}, ${liveRange.to}] failed for ${syncDocId}; falling back to whole-doc replace:`,
          error,
        );
      }
    }
  }
  console.warn(
    `[agentText] applying agent edit to ${syncDocId} as a whole-doc replace (no minimal anchor was applicable).`,
  );
  const tr = new Transform(liveDoc);
  tr.replaceWith(0, liveDoc.content.size, targetDoc.content);
  return tr.docChanged ? tr : null;
}

/*
  The agent's edit as a single replace, in OLD-doc coordinates.
*/
interface AgentChange {
  from: number;
  to: number;
  /*
    Replacement content, cut from the target doc (carries marks/structure).
  */
  slice: PmSlice;
}

/*
  Common-prefix/common-suffix diff between the block's previous doc and the
  agent's target doc, via ProseMirror's own findDiffStart/findDiffEnd (which
  also catch mark-only changes). Null when the docs are identical.
*/
function findMinimalChange({
  oldDoc,
  targetDoc,
}: {
  oldDoc: PmNode;
  targetDoc: PmNode;
}): AgentChange | null {
  const diffStart = oldDoc.content.findDiffStart(targetDoc.content);
  if (diffStart === null) {
    return null;
  }
  const diffEnd = oldDoc.content.findDiffEnd(targetDoc.content);
  if (diffEnd === null) {
    return null;
  }
  let endInOld = diffEnd.a;
  let endInTarget = diffEnd.b;
  /*
    Repeated content can make the common prefix and suffix overlap; shift the
    end boundaries right so from <= to on both sides (the standard clamp).
  */
  const overlap = diffStart - Math.min(endInOld, endInTarget);
  if (overlap > 0) {
    endInOld += overlap;
    endInTarget += overlap;
  }
  return { from: diffStart, to: endInOld, slice: targetDoc.slice(diffStart, endInTarget) };
}

/*
  Re-anchor the agent's old-coordinate change range onto the live doc. All
  checks recompute from the live doc — nothing carries over between retries.

   - live == old → positions transfer verbatim.
   - Every concurrent edit sits AFTER the agent range (the docs' first
     divergence is at/after the range end) → positions transfer verbatim.
   - Every concurrent edit sits BEFORE the agent range (the range lies in the
     docs' common suffix) → shift by the size delta.
   - Concurrent edits overlap the range → drift policy (Spike B Q4 owner
     default): APPLY anyway on the best content anchor, found by searching
     the live doc's flattened text for the changed segment and/or its
     surrounding context. Logged.
   - No sane anchor → null (caller falls back to whole-doc replace).
*/
function anchorAgentRangeInLiveDoc({
  liveDoc,
  oldDoc,
  agentChange,
  syncDocId,
}: {
  liveDoc: PmNode;
  oldDoc: PmNode;
  agentChange: AgentChange;
  syncDocId: string;
}): { from: number; to: number } | null {
  if (liveDoc.content.eq(oldDoc.content)) {
    return { from: agentChange.from, to: agentChange.to };
  }
  const userDiffStart = oldDoc.content.findDiffStart(liveDoc.content);
  if (userDiffStart !== null && userDiffStart >= agentChange.to) {
    /*
      The common prefix covers the whole agent range: live[from..to] is
      byte-identical to old[from..to].
    */
    return { from: agentChange.from, to: agentChange.to };
  }
  const userDiffEnd = oldDoc.content.findDiffEnd(liveDoc.content);
  const sizeDelta = liveDoc.content.size - oldDoc.content.size;
  if (userDiffEnd !== null && userDiffEnd.a <= agentChange.from) {
    /*
      The common suffix covers the whole agent range: same content, shifted.
    */
    return { from: agentChange.from + sizeDelta, to: agentChange.to + sizeDelta };
  }
  const contentAnchor = findContentAnchor({ liveDoc, oldDoc, agentChange });
  if (contentAnchor !== null) {
    console.warn(
      `[agentText] concurrent edits overlap the agent edit in ${syncDocId}; applying anyway on content anchor [${contentAnchor.from}, ${contentAnchor.to}] (Spike B Q4 drift policy).`,
    );
    return contentAnchor;
  }
  return null;
}

/*
  A doc's text flattened to one string, with a char-index → PM-position map.
*/
interface FlatDocText {
  text: string;
  positionsByCharIndex: number[];
}

const BLOCK_SEPARATOR = "\n";
const LEAF_PLACEHOLDER = "￼";
/*
  Context window (chars) used to locate the changed segment in the live doc.
*/
const ANCHOR_CONTEXT_CHARS = 16;
/*
  Below this length a bare (context-free) match is too spurious to trust.
*/
const MIN_BARE_MATCH_CHARS = 4;

function flattenDocText(doc: PmNode): FlatDocText {
  let text = "";
  const positionsByCharIndex: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text !== undefined) {
      for (let charIndex = 0; charIndex < node.text.length; charIndex += 1) {
        positionsByCharIndex.push(pos + charIndex);
      }
      text += node.text;
    } else if (node.isLeaf) {
      positionsByCharIndex.push(pos);
      text += LEAF_PLACEHOLDER;
    } else if (node.isBlock && text.length > 0) {
      /*
        Boundary between blocks — prevents cross-paragraph false matches.
      */
      positionsByCharIndex.push(pos);
      text += BLOCK_SEPARATOR;
    }
    return true;
  });
  return { text, positionsByCharIndex };
}

/*
  First char index whose PM position is >= `position` (binary search).
*/
function charIndexAtOrAfterPosition({
  flat,
  position,
}: {
  flat: FlatDocText;
  position: number;
}): number {
  const { positionsByCharIndex } = flat;
  let low = 0;
  let high = positionsByCharIndex.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (positionsByCharIndex[mid]! < position) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/*
  Map a char-index range back to PM positions; null when unmappable.
*/
function charRangeToPositions({
  flat,
  startChar,
  endChar,
}: {
  flat: FlatDocText;
  startChar: number;
  endChar: number;
}): { from: number; to: number } | null {
  const { positionsByCharIndex } = flat;
  if (startChar > endChar || endChar > positionsByCharIndex.length) {
    return null;
  }
  if (positionsByCharIndex.length === 0) {
    return null;
  }
  const from =
    startChar < positionsByCharIndex.length
      ? positionsByCharIndex[startChar]!
      : positionsByCharIndex[positionsByCharIndex.length - 1]! + 1;
  const to = endChar === startChar ? from : positionsByCharIndex[endChar - 1]! + 1;
  return from <= to ? { from, to } : null;
}

/*
  The occurrence of `needle` in `haystack` nearest to `preferredIndex`.
*/
function findNearestOccurrence({
  haystack,
  needle,
  preferredIndex,
}: {
  haystack: string;
  needle: string;
  preferredIndex: number;
}): number | null {
  let bestIndex: number | null = null;
  let searchFrom = 0;
  for (;;) {
    const matchIndex = haystack.indexOf(needle, searchFrom);
    if (matchIndex === -1) {
      break;
    }
    if (bestIndex === null || Math.abs(matchIndex - preferredIndex) < Math.abs(bestIndex - preferredIndex)) {
      bestIndex = matchIndex;
    }
    searchFrom = matchIndex + 1;
  }
  return bestIndex;
}

/*
  Content-anchored fallback for overlapping concurrent edits: flatten both
  docs to text, then locate the changed segment in the live doc —

   1. exact segment with surrounding context (covers "user edited elsewhere,
      but on both sides of the agent range");
   2. segment with one-sided context;
   3. bare segment (long enough to be unambiguous);
   4. BRACKET anchor: the unchanged context found on each side, replacing
      whatever now sits between them (covers "user typed inside the phrase
      the agent rewrote" — their inside-edit is superseded by design).
*/
function findContentAnchor({
  liveDoc,
  oldDoc,
  agentChange,
}: {
  liveDoc: PmNode;
  oldDoc: PmNode;
  agentChange: AgentChange;
}): { from: number; to: number } | null {
  const oldFlat = flattenDocText(oldDoc);
  const liveFlat = flattenDocText(liveDoc);
  const changedStartChar = charIndexAtOrAfterPosition({ flat: oldFlat, position: agentChange.from });
  const changedEndChar = charIndexAtOrAfterPosition({ flat: oldFlat, position: agentChange.to });
  const changedText = oldFlat.text.slice(changedStartChar, changedEndChar);
  const contextBefore = oldFlat.text.slice(
    Math.max(0, changedStartChar - ANCHOR_CONTEXT_CHARS),
    changedStartChar,
  );
  const contextAfter = oldFlat.text.slice(changedEndChar, changedEndChar + ANCHOR_CONTEXT_CHARS);

  const candidates: { searchText: string; changedOffset: number }[] = [
    { searchText: contextBefore + changedText + contextAfter, changedOffset: contextBefore.length },
    { searchText: contextBefore + changedText, changedOffset: contextBefore.length },
    { searchText: changedText + contextAfter, changedOffset: 0 },
  ];
  if (changedText.length >= MIN_BARE_MATCH_CHARS) {
    candidates.push({ searchText: changedText, changedOffset: 0 });
  }
  const attemptedSearchTexts = new Set<string>();
  for (const { searchText, changedOffset } of candidates) {
    if (searchText.length === 0 || attemptedSearchTexts.has(searchText)) {
      continue;
    }
    attemptedSearchTexts.add(searchText);
    const matchIndex = findNearestOccurrence({
      haystack: liveFlat.text,
      needle: searchText,
      preferredIndex: changedStartChar - changedOffset,
    });
    if (matchIndex === null) {
      continue;
    }
    const startChar = matchIndex + changedOffset;
    return charRangeToPositions({
      flat: liveFlat,
      startChar,
      endChar: startChar + changedText.length,
    });
  }

  /*
    Bracket anchor. Each side needs either real context or a hard doc edge.
  */
  const hasStartAnchor = contextBefore.length > 0 || changedStartChar === 0;
  const hasEndAnchor = contextAfter.length > 0 || changedEndChar === oldFlat.text.length;
  if (!hasStartAnchor || !hasEndAnchor) {
    return null;
  }
  let startChar = 0;
  if (contextBefore.length > 0) {
    const beforeIndex = findNearestOccurrence({
      haystack: liveFlat.text,
      needle: contextBefore,
      preferredIndex: changedStartChar - contextBefore.length,
    });
    if (beforeIndex === null) {
      return null;
    }
    startChar = beforeIndex + contextBefore.length;
  }
  let endChar = liveFlat.text.length;
  if (contextAfter.length > 0) {
    const afterIndex = liveFlat.text.indexOf(contextAfter, startChar);
    if (afterIndex === -1) {
      return null;
    }
    endChar = afterIndex;
  }
  return charRangeToPositions({ flat: liveFlat, startChar, endChar });
}
