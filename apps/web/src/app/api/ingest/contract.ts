import { z } from "zod";

/**
 * Wire contract for POST /api/ingest — the Phase 7.4 web-content ingestion
 * pipeline as an HTTP surface (plan §7.4 calls for a "server-side
 * fetch/search/parse pipeline (Convex action or route handler)"; §9.3's
 * end-state is the same actions mounted over HTTP/MCP).
 *
 * The chat tools do NOT go through this route — they call the same
 * lib/content-ingestion functions in-process, so there is exactly one
 * pipeline and no self-fetch hop. This route exists so the pipeline is
 * reachable, testable, and reusable (recurring digests, §10 row 13) without
 * going through the agent.
 */

export const INGEST_KINDS = ["article", "person"] as const;

export type IngestKind = (typeof INGEST_KINDS)[number];

export const ingestRequestBodySchema = z.object({
  kind: z.enum(INGEST_KINDS),
  url: z.string().min(1).max(2048),
  /** Person mode only: the name the caller believes the profile belongs to. */
  personName: z.string().min(1).max(120).optional(),
});

export type IngestRequestBody = z.infer<typeof ingestRequestBodySchema>;
