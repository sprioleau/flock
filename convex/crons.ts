import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/*
  Phase 6.1 (plan §6.1d) — daily cleanup of unclaimed-session demo data:
  documents with no activity for 30 days are deleted along with their
  blocks, operations, snapshots, per-text-block ProseMirror sync docs,
  uploaded storage files, and (when emptied) their canvases and the owning
  session's brand kit / asset library / saved sections / persona copies. The
  mutation is internally bounded and self-continuing, so one tick per day
  suffices.

  "Unclaimed" is now a test the mutation actually applies rather than an
  assumption about the product: a document whose owner has a claimed Better
  Auth account is exempt (convex/model/cleanup.ts classifyDocumentOwner). It
  was not, for the two weeks between Better Auth shipping and this being fixed.
*/
const crons = cronJobs();

crons.daily(
  "cleanup stale unclaimed documents",
  /*
    08:47 UTC — an off-peak, non-round time to avoid thundering-herd slots.
  */
  { hourUTC: 8, minuteUTC: 47 },
  internal.cleanup.cleanupStaleDocuments,
  {},
);

export default crons;
