import { z } from "zod";

/*
  Wire contract for POST /api/ingest — the page-reading pipeline as an HTTP
  surface (plan §7.4 calls for a "server-side fetch/search/parse pipeline";
  §9.3's end-state is the same actions mounted over HTTP/MCP).

  The chat tools do NOT go through this route — they call the same
  lib/content-ingestion functions in-process, so there is exactly one pipeline
  and no self-fetch hop. This route exists so the pipeline is reachable,
  testable, and reusable (recurring digests, §10 row 13) without going through
  the agent.
*/

/*
  `kind` used to be a REQUIRED discriminator selecting an article pipeline or a
  person pipeline. There is now one pipeline, because choosing between them
  meant classifying a page before it had been fetched.

  It stays accepted, and ignored, for one release. A caller still sending
  `kind: "article"` gets a page read rather than a 400 — turning a field's
  removal into a hard failure for existing callers is a worse outcome than
  carrying a dead field for a version. The response shape necessarily changed,
  so this buys those callers a clear read, not silence.
*/
export const ingestRequestBodySchema = z.object({
  kind: z.string().optional(),
  url: z.string().min(1).max(2048),
  /*
    Accepted and ignored, as `kind` is.
  */
  personName: z.string().min(1).max(120).optional(),
});

export type IngestRequestBody = z.infer<typeof ingestRequestBodySchema>;
