/**
 * /api/chat configuration constants — the ONE place model ids and pipeline
 * flags live.
 */

/**
 * Default Gemini model for the chat pipeline.
 *
 * Fast tier (flash-class) per the Phase 3.2 latency budget. `gemini-3.6-flash`
 * is the newest stable flash id in the installed @ai-sdk/google@4.0.27 typed
 * model union (newer than 3.5-flash; the 3.1-flash-* ids are preview-only).
 * Verified against a real streamed tool-call request on 2026-07-29.
 */
export const DEFAULT_GEMINI_MODEL_ID = "gemini-3.6-flash";

/** Model id reported in logs when the deterministic mock model is used. */
export const MOCK_MODEL_ID = "flock-mock-chat-model";

/**
 * A/B seam (Phase 3.2): the pipeline variant behind the flag.
 *
 * - "single-pass"    — one streamText call with the full registry toolset
 *   (IMPLEMENTED — the current default).
 * - "triage-execute" — two-step: a cheap triage call picks the relevant block
 *   types / actions, then an execute call receives only those schemas
 *   (NOT built yet — `runTriageExecutePipeline` in pipeline.ts throws; drop
 *   the implementation in there and flip this env var to compare).
 *
 * Select with the FLOCK_PIPELINE_VARIANT env var; unknown values fall back
 * to "single-pass".
 */
export const PIPELINE_VARIANTS = ["single-pass", "triage-execute"] as const;

export type PipelineVariant = (typeof PIPELINE_VARIANTS)[number];

function resolvePipelineVariant(rawValue: string | undefined): PipelineVariant {
  const isKnownVariant = (PIPELINE_VARIANTS as readonly string[]).includes(rawValue ?? "");
  return isKnownVariant ? (rawValue as PipelineVariant) : "single-pass";
}

export const PIPELINE_VARIANT: PipelineVariant = resolvePipelineVariant(
  process.env.FLOCK_PIPELINE_VARIANT,
);

/**
 * Validation gate (Phase 3.3): at most ONE server-side repair round-trip per
 * failed tool call. After that the failure surfaces to the client.
 */
export const MAX_REPAIR_ATTEMPTS_PER_TOOL_CALL = 1;

/**
 * Multi-step ceiling for one turn. Content ops have no execute() so the loop
 * naturally stops when they are emitted; the headroom lets the model confirm
 * editor-action results ("Switched to mobile preview.") in a follow-up step.
 */
export const MAX_STEP_COUNT = 4;
