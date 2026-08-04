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

/**
 * Default OpenRouter model, used when OPENROUTER_MODEL_ID is unset.
 *
 * OpenRouter exists here as the pressure valve for Gemini's ~20-requests/DAY
 * free tier (see lib/chat-provider.ts), so the default has to be free too.
 *
 * Verified 2026-08-04 against the public catalog at
 * https://openrouter.ai/api/v1/models (no key required — re-check with
 * `curl -s https://openrouter.ai/api/v1/models`):
 *
 * - listed as "OpenAI: gpt-oss-20b (free)"
 * - pricing.prompt "0", pricing.completion "0" — genuinely free tier
 * - context_length 131072
 * - supported_parameters includes BOTH "tools" and "tool_choice" — the
 *   property that actually matters, since this pipeline is tool-driven and a
 *   model without tool-calling would fail every turn rather than degrade
 *
 * NOT verified: that it completes a real tool-calling turn against THIS
 * pipeline's toolset. Every prompt and eval here was tuned against Gemini,
 * which is why Gemini remains DEFAULT_CHAT_PROVIDER_ID.
 */
export const DEFAULT_OPENROUTER_MODEL_ID = "openai/gpt-oss-20b:free";

/** Model id reported in logs when the deterministic mock model is used. */
export const MOCK_MODEL_ID = "flock-mock-chat-model";

/**
 * Provider selection env vars (all read in ./provider.ts, which is the ONE
 * place the choice is made):
 *
 * - FLOCK_CHAT_PROVIDER          "gemini" | "openrouter" — the deployment
 *                                default. Unset/unknown → "gemini".
 * - GOOGLE_GENERATIVE_AI_API_KEY Gemini's key. Unset → Gemini unavailable.
 * - OPENROUTER_API_KEY           OpenRouter's key. Unset → unavailable.
 * - OPENROUTER_MODEL_ID          Overrides DEFAULT_OPENROUTER_MODEL_ID.
 *
 * No key of either kind → every turn runs the deterministic mock, which is
 * how CI, the unit suite, and a fresh clone all behave.
 */

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
