import { google } from "@ai-sdk/google";
import { generateDocumentOutline } from "@flock/agent";
import type { Block } from "@flock/email-sdk";
import { generateObject } from "ai";
import { z } from "zod";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { MOCK_MODEL_HEADER } from "@/lib/chat-contract";
import { buildStandaloneSectionDoc } from "@/lib/saved-sections";
import { getSessionIdFromCookieHeader } from "@/lib/session-cookie";
import { fetchAuthMutation, fetchAuthQuery } from "@/lib/auth/auth-server";
import { chargeCreditForRequest } from "@/lib/auth/credits";
import {
  buildDeterministicEnrichment,
  buildEnrichmentPrompt,
  savedSectionEnrichmentSchema,
  type SavedSectionEnrichment,
} from "../enrichment";

/**
 * POST /api/saved-sections/enrich — the ASYNC, fails-soft tail of a
 * saved-section save (owner V2 item 2): author `useWhen` + `description`
 * onto the row so the compose agent can pick saved sections by FIT, not by
 * the user's label. Fired fire-and-forget by the save affordance; the save
 * UX never waits on this, and every failure here degrades to "the row just
 * has no enrichment yet".
 *
 * Model: gemini-3.5-flash-lite (the personas bucket — one small one-shot
 * call over the section's compact outline). The deterministic structural
 * analyzer (enrichment.ts) serves the mock header, the no-API-key case, AND
 * any model failure — the row is still enriched, just without LLM prose.
 */

const ENRICHMENT_MODEL_ID = "gemini-3.5-flash-lite";
const GENERATION_TIMEOUT_MS = 30_000;

const requestBodySchema = z.object({ savedSectionId: z.string().min(1) });

interface EnrichmentOutcome {
  enrichment: SavedSectionEnrichment;
  source: "model" | "deterministic";
}

async function generateEnrichment({
  name,
  blocks,
  isDeterministicForced,
}: {
  name: string;
  blocks: Block[];
  isDeterministicForced: boolean;
}): Promise<EnrichmentOutcome> {
  const hasGoogleApiKey = Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
  if (!isDeterministicForced && hasGoogleApiKey) {
    try {
      const previewDoc = buildStandaloneSectionDoc({ blocks });
      if (previewDoc !== null) {
        const outline = generateDocumentOutline({ doc: previewDoc });
        const { object } = await generateObject({
          model: google(ENRICHMENT_MODEL_ID),
          schema: savedSectionEnrichmentSchema,
          prompt: buildEnrichmentPrompt({ name, outline }),
          abortSignal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
        });
        return { enrichment: object, source: "model" };
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          tag: "flock.savedSections.enrichModelFailed",
          message: error instanceof Error ? error.message.slice(0, 300) : String(error),
        }),
      );
      // fall through to the deterministic floor
    }
  }
  return { enrichment: buildDeterministicEnrichment(blocks), source: "deterministic" };
}

export async function POST(request: Request): Promise<Response> {
  const sessionId = getSessionIdFromCookieHeader(request.headers.get("cookie"));
  if (sessionId === null) {
    return Response.json({ isEnriched: false }, { status: 401 });
  }
  const parsedBody = requestBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    return Response.json({ isEnriched: false }, { status: 400 });
  }
  const savedSectionId = parsedBody.data.savedSectionId as Id<"savedSections">;

  try {
    // Authenticated: savedSections is keyed by resolveOwnerId, so the
    // ownership check below only means anything with the caller's token.
    const row = await fetchAuthQuery(api.savedSections.getForSession, {
      sessionId,
      savedSectionId,
    });
    if (row === null) {
      return Response.json({ isEnriched: false }, { status: 404 });
    }

    // Charged AFTER the ownership check (a 404 must not bill) and before the
    // model call. Deterministic runs — forced, or no API key — reach only the
    // deterministic floor below, spend no provider quota, and are free.
    const isDeterministicForced = request.headers.get(MOCK_MODEL_HEADER) !== null;
    const charge = await chargeCreditForRequest({
      request,
      isMockRun: isDeterministicForced || !process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    });
    if (!charge.isAllowed) {
      return Response.json({ isEnriched: false, message: charge.message }, { status: 429 });
    }

    const { enrichment, source } = await generateEnrichment({
      name: row.name,
      blocks: row.blocks as Block[],
      isDeterministicForced,
    });
    await fetchAuthMutation(api.savedSections.applyEnrichment, {
      sessionId,
      savedSectionId,
      useWhen: enrichment.useWhen,
      description: enrichment.description,
    });
    console.log(
      JSON.stringify({ tag: "flock.savedSections.enriched", savedSectionId, source }),
    );
    return Response.json({ isEnriched: true, source });
  } catch (error) {
    console.error(
      JSON.stringify({
        tag: "flock.savedSections.enrichFailed",
        message: error instanceof Error ? error.message.slice(0, 300) : String(error),
      }),
    );
    return Response.json({ isEnriched: false }, { status: 500 });
  }
}
