import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";
import { textDocSchema } from "@tandem/email-sdk";
import { v } from "convex/values";
import { normalizeEditorDoc } from "../apps/web/src/components/studio/text-editor/normalize-editor-doc";
import {
  buildEditorSchema,
  Transform,
} from "../apps/web/src/lib/editorSchema";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";
import { assertBlockSyncAccess, findLiveBlockRows } from "./model/textBlockSync";

/**
 * Phase 5.2 — one synced ProseMirror doc per TEXT block, keyed by the SDK
 * block id ("txt_ab12cd34"). The sync doc mounts only while a user is editing
 * that block; the op log stays the history spine (session op + mirror
 * architecture decision):
 *
 *   - client keystrokes flow through the component's OT pipeline
 *     (submitSteps/getSteps below);
 *   - `onSnapshot` mirrors debounced snapshots into the block row's
 *     properties.text (see mirrorSnapshotIntoBlock for why that write
 *     deliberately bypasses applyOperations);
 *   - one `updateText` op per editing session / agent action is dispatched
 *     elsewhere, keeping undo/version history at session granularity.
 */

const prosemirrorSync = new ProsemirrorSync(components.prosemirrorSync);

export const {
  getSnapshot,
  submitSnapshot,
  latestVersion,
  getSteps,
  submitSteps,
} = prosemirrorSync.syncApi<DataModel>({
  // Existence gating ONLY (these hooks receive nothing but the sync doc id):
  // the id must resolve to a live block row. Session-capability checks are
  // deferred to Phase 6.1 (no-auth demo-first; capability URLs).
  checkRead: async (ctx, id) => {
    await assertBlockSyncAccess(ctx, id);
  },
  checkWrite: async (ctx, id) => {
    await assertBlockSyncAccess(ctx, id);
  },
  onSnapshot: async (ctx, id, snapshot) => {
    await mirrorSnapshotIntoBlock({ ctx, id, snapshot });
  },
});

/**
 * Ensure the per-block sync doc exists before a user starts editing a text
 * block. The client calls this every time a text block is opened for editing;
 * it is idempotent (a no-op when the sync doc already exists).
 *
 * Throws for unknown block ids and for non-text blocks.
 */
export const ensureBlockDoc = mutation({
  args: { blockId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { rows, hasAmbiguousMatches } = await findLiveBlockRows(ctx, args.blockId);
    if (rows.length === 0) {
      throw new Error(`Block ${args.blockId} does not exist (or its document is gone).`);
    }
    const row = rows[0]!;
    if (row.type !== "text") {
      throw new Error(
        `Block ${args.blockId} is a "${row.type}" block; only text blocks have sync docs.`,
      );
    }
    // Idempotency guard. prosemirrorSync.create is submitSnapshot@v1 under
    // the hood and THROWS if the doc exists with different content, so "check
    // then create" (serializable within this mutation) is the safe pattern.
    const existingVersion = await ctx.runQuery(components.prosemirrorSync.lib.latestVersion, {
      id: args.blockId,
    });
    if (existingVersion !== null) {
      return null;
    }
    if (hasAmbiguousMatches) {
      // Colliding block ids (sample/fork docs) share one sync doc; seeding
      // from the first row is arbitrary but unavoidable under bare-id keying.
      console.warn(
        `[prosemirror] block id ${args.blockId} matches multiple documents; seeding sync doc from document ${row.documentId}.`,
      );
    }
    // Blocks store SDK TextDoc JSON, which is Tiptap/PM-compatible doc JSON —
    // usable as-is for the initial ProseMirror content.
    const initialText = textDocSchema.safeParse(row.properties.text);
    if (!initialText.success) {
      throw new Error(
        `Block ${args.blockId} has no valid properties.text to seed the sync doc from.`,
      );
    }
    await prosemirrorSync.create(ctx, args.blockId, initialText.data);
    return null;
  },
});

/**
 * Snapshot mirror — a DOCUMENTED exception to the one-history-spine rule.
 *
 * This writes block properties directly (NOT via dispatch → applyOperations),
 * like the existing `agentName` derived field. Why the bypass is deliberate:
 * while a text block is being edited, the ProseMirror sync doc owns live text
 * truth (per-keystroke OT steps); the op log captures text at session/agent-
 * action granularity via `updateText` ops dispatched elsewhere. Mirroring the
 * component's debounced snapshots (~1s — that IS the designed debounce) into
 * properties.text keeps renderers, the outline, and AI context fresh without
 * them needing live sync state, at zero cost to undo/version history: no op
 * row is written here, so the mirror never becomes an undo target.
 */
async function mirrorSnapshotIntoBlock({
  ctx,
  id,
  snapshot,
}: {
  ctx: MutationCtx;
  id: string;
  snapshot: string;
}): Promise<void> {
  let editorDoc: Parameters<typeof normalizeEditorDoc>[0];
  try {
    editorDoc = JSON.parse(snapshot);
  } catch {
    console.warn(`[prosemirror] snapshot for block ${id} is not valid JSON; skipping mirror.`);
    return;
  }
  // Editor JSON → strict SDK TextDoc; never write an invalid TextDoc.
  const validation = textDocSchema.safeParse(normalizeEditorDoc(editorDoc));
  if (!validation.success) {
    console.warn(
      `[prosemirror] snapshot for block ${id} failed textDocSchema after normalization; skipping mirror: ${validation.error.message}`,
    );
    return;
  }
  const { rows, hasAmbiguousMatches } = await findLiveBlockRows(ctx, id);
  if (rows.length === 0) {
    // Block was removed while a sync session was still flushing; nothing to
    // mirror into (the removal path cleans up the sync doc).
    return;
  }
  if (hasAmbiguousMatches) {
    // Never guess on writes: colliding block ids (sample/fork docs) would
    // make this patch an arbitrary document's block. The session-end
    // updateText op still lands via the normal dispatch path.
    console.warn(
      `[prosemirror] block id ${id} matches multiple documents; skipping snapshot mirror.`,
    );
    return;
  }
  const row = rows[0]!;
  if (row.type !== "text") {
    return;
  }
  // Patch ONLY the text property: `properties` is replaced wholesale by
  // ctx.db.patch, so spread the row read in THIS transaction — Convex
  // mutations are serializable, so concurrent updates to other properties
  // cannot be clobbered.
  await ctx.db.patch(row._id, {
    properties: { ...row.properties, text: validation.data },
  });
}

/**
 * THE key probe for Phase 5 (the AI-edit path): server-side transform.
 *
 * SPIKE LEFTOVER — Wave 2 (Phase 5.3) replaces this with the real AI
 * transform path and makes it internal; kept public until then.
 *
 * Finds every occurrence of a target word (default "bold") in the synced doc
 * and applies the bold mark. Falls back to bolding the first word if the
 * target isn't found. The transform merges through the same OT pipeline as
 * client keystrokes: the component rebases and re-invokes the callback if the
 * doc changed concurrently, so the callback must be idempotent.
 */
export const boldWord = mutation({
  args: {
    id: v.string(),
    word: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const schema = buildEditorSchema();
    const boldMarkType = schema.marks.bold ?? schema.marks.strong;
    const targetWord = (args.word ?? "bold").toLowerCase();

    await prosemirrorSync.transform(ctx, args.id, schema, (doc) => {
      // Collect target ranges in doc coordinates.
      const ranges: Array<{ from: number; to: number }> = [];
      doc.descendants((node, pos) => {
        if (!node.isText || !node.text) return true;
        const text = node.text.toLowerCase();
        let searchFromIndex = 0;
        for (;;) {
          const matchIndex = text.indexOf(targetWord, searchFromIndex);
          if (matchIndex === -1) break;
          ranges.push({
            from: pos + matchIndex,
            to: pos + matchIndex + targetWord.length,
          });
          searchFromIndex = matchIndex + targetWord.length;
        }
        return true;
      });

      // Fallback: bold the first word in the doc.
      if (ranges.length === 0) {
        let hasFoundFirstWord = false;
        doc.descendants((node, pos) => {
          if (hasFoundFirstWord || !node.isText || !node.text) return true;
          const match = node.text.match(/\S+/);
          if (match && match.index !== undefined) {
            ranges.push({
              from: pos + match.index,
              to: pos + match.index + match[0].length,
            });
            hasFoundFirstWord = true;
          }
          return !hasFoundFirstWord;
        });
      }

      // Returning null aborts the transform (no-op).
      if (ranges.length === 0) return null;

      const tr = new Transform(doc);
      for (const { from, to } of ranges) {
        tr.addMark(from, to, boldMarkType.create());
      }
      return tr;
    });

    return null;
  },
});
