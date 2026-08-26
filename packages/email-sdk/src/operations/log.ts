import { z } from "zod";

/**
 * Who authored an operation.
 *
 * All that survives of what was once a client-side "operation log entry"
 * type. THE operation log is the `operations` table in convex/schema.ts, and
 * the only thing that writes a row into it is `commitVersions`
 * (convex/model/emailDocuments.ts), which authors every field itself: the
 * version, the inverse (recomputed against the authoritative pre-op document
 * and re-anchored for updateText), the history `kind`, and the provenance —
 * including `undoOwnerId`, which this package's discarded entry shape could
 * not even express. A second, client-authored representation of that row was
 * a shape nothing ever persisted, so it is gone; `dispatchContentAction`
 * returns the canonical operation plus the provenance it ran under, and the
 * write path is unambiguously the row's author.
 */

/** Who authored an operation: a human user or an AI agent. */
export const OPERATION_AUTHORS = ["user", "agent"] as const;

export const operationAuthorSchema = z
  .enum(OPERATION_AUTHORS)
  .describe('Who authored the operation: "user" (a human edit) or "agent" (an AI edit).');

export type OperationAuthor = z.infer<typeof operationAuthorSchema>;
