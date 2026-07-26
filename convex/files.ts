import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Image upload support for the editor (Phase 2.3), following the upload-URL
 * pattern from docs/uploading-storing-files-convex.md:
 *
 * 1. `generateUploadUrl` mutation → short-lived URL (expires in 1 hour).
 * 2. Client POSTs the file bytes to that URL → `{ storageId }`.
 * 3. `getFileUrl` query resolves the storage id to a serving URL, which the
 *    client stores as a plain string in the image block's `src` — blocks keep
 *    plain URLs so the email SDK has no Convex coupling.
 */

export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const getFileUrl = query({
  args: { storageId: v.id("_storage") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});
