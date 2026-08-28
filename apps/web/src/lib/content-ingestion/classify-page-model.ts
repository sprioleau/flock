import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import { createTraceId } from "@/lib/observability/log";
import { modelTelemetryFor } from "@/lib/observability/model-telemetry";
import { pageClassificationSchema, type ClassifyFn } from "./classify-page";

/**
 * The one real model call in the page pipeline, kept apart from the classifier
 * itself so that module has no provider dependency and stays exercisable
 * without a key, a network, or quota.
 *
 * This is not a new cost category. Four other side-callers already spend a
 * one-shot structured call on the same model — brand-kit extraction, the
 * personas runner, saved-section enrichment, and the (off by default) public
 * web search that used to run inside the person pipeline. This is a sixth
 * consumer of a bucket that was already shared five ways, not a first
 * intruder.
 *
 * On the arithmetic: today a wrong reading costs one call, PLUS the user's
 * retry, PLUS an email in the canvas that has to be undone. A right reading
 * here costs two calls and no undo, so it breaks even around a 50% failure
 * rate on the old path. The failure rate on the case that prompted this work
 * was 100%.
 */

const CLASSIFICATION_MODEL_ID = "gemini-3.5-flash-lite";

/*
  Matched to brand-kit's measured budget. Reading a page is not a reasoning
  task, and default thinking pushed flash-lite past the latency budget there.
  (thinkingBudget: 0 is rejected by the 3.x models — use levels.)
*/
const CLASSIFICATION_TIMEOUT_MS = 30_000;

/**
 * A classifier, or null when there should not be one.
 *
 * Null on a mock run and null with no API key, and both cases matter for the
 * same reason: the caller's deterministic floor is a real, honest answer, so
 * declining to call is always safe. A mock run must cost no quota AND
 * fabricate nothing — inventing a plausible reading offline is exactly the
 * failure this whole pipeline was rebuilt to stop.
 */
export function createPageClassifier({ isMockRun }: { isMockRun: boolean }): ClassifyFn | null {
  if (isMockRun) {
    return null;
  }
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return null;
  }
  return async ({ prompt }) => {
    const { object } = await generateObject({
      model: google(CLASSIFICATION_MODEL_ID),
      schema: pageClassificationSchema,
      prompt,
      abortSignal: AbortSignal.timeout(CLASSIFICATION_TIMEOUT_MS),
      telemetry: modelTelemetryFor({
        operation: "ingest.classifyPage",
        traceId: createTraceId(),
        isMock: false,
      }),
      /*
        One retry only — the free-tier quota is small and shared with the chat
        agent, so a quota failure would otherwise be retried into the ground.
      */
      maxRetries: 1,
      providerOptions: {
        google: { thinkingConfig: { thinkingLevel: "minimal" } },
      },
    });
    return object;
  };
}
