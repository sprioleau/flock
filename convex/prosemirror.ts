import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";
import { v } from "convex/values";
import {
  buildEditorSchema,
  Transform,
} from "../apps/web/src/lib/editorSchema";
import { components } from "./_generated/api";
import { mutation } from "./_generated/server";

const prosemirrorSync = new ProsemirrorSync(components.prosemirrorSync);

// SPIKE ONLY: checkRead/checkWrite are permit-all. Phase 5 must gate these on
// the caller's session/identity and the block's parent document ownership.
export const {
  getSnapshot,
  submitSnapshot,
  latestVersion,
  getSteps,
  submitSteps,
} = prosemirrorSync.syncApi({
  checkRead: async (_ctx, _id) => {
    // permit-all for the spike
  },
  checkWrite: async (_ctx, _id) => {
    // permit-all for the spike
  },
});

/**
 * THE key probe for Phase 5 (the AI-edit path): server-side transform.
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
