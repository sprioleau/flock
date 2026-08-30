/*
  /api/generate-image configuration constants — the ONE place the image model
  id lives (mirrors the chat pipeline's constants.ts).
*/

/*
  Gemini image model for block image generation.

  `gemini-2.5-flash-image` is the cheapest GA (non-preview) image id in the
  installed @ai-sdk/google@4.0.27 typed model union (flash tier; the imagen-4.0
  family is a dedicated `:predict` API and `imagen-4.0-fast` is retired for new
  users; the 3.1-flash image ids are preview-only in the union). The live API
  also serves `gemini-3.1-flash-image` / `gemini-3.1-flash-lite-image` (GA,
  untyped) — candidates to re-evaluate once the key has image quota.

  NOTE (2026-07-31): the project's GOOGLE_GENERATIVE_AI_API_KEY is free-tier,
  and EVERY image model returns 429 "free tier limit: 0" — image generation on
  the Gemini API needs a billing-enabled key. Text models are unaffected. The
  route surfaces this as a clean "no image quota" error; the deterministic
  mock (x-flock-mock header or FLOCK_MOCK_IMAGE_MODEL=1) covers development
  and CI until billing is enabled.
*/
export const GEMINI_IMAGE_MODEL_ID = "gemini-2.5-flash-image";

/*
  Model id reported in logs when the deterministic mock generator is used.
*/
export const MOCK_IMAGE_MODEL_ID = "flock-mock-image-model";

/*
  Env switch that forces the mock generator server-wide (dev/CI without quota).
*/
export const MOCK_IMAGE_MODEL_ENV_VAR = "FLOCK_MOCK_IMAGE_MODEL";

/*
  Aspect ratios accepted by the route and passed through to the model —
  exactly the set the installed google provider supports for image models.
*/
export const IMAGE_ASPECT_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"] as const;

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

/*
  One in-flight generation per server at a time is plenty for a single-user
  editor; the model call itself is the latency floor (~5-15s). Keep retries
  low so failures surface fast instead of stacking provider backoff.
*/
export const IMAGE_GENERATION_MAX_RETRIES = 1;
