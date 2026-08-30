import { google } from "@ai-sdk/google";
import { generateImage } from "ai";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { fetchAuthMutation, fetchAuthQuery } from "@/lib/auth/auth-server";
import { createTraceId, logFailure, logRecord, summarizeError } from "@/lib/observability/log";
import {
  logModelCall,
  logModelFailure,
  type ModelTelemetryContext,
} from "@/lib/observability/model-telemetry";
import {
  GEMINI_IMAGE_MODEL_ID,
  IMAGE_GENERATION_MAX_RETRIES,
  MOCK_IMAGE_MODEL_ENV_VAR,
  MOCK_IMAGE_MODEL_ID,
  type ImageAspectRatio,
} from "./constants";
import { createMockImagePng } from "./mock-image";

/*
  AI image generation for image blocks — the server-only core shared by the
  /api/generate-image route (human path: the panel renders the returned base64
  as an INSTANT data-URI preview, then uploads in the background) and the
  /api/chat generateImage executor (agent path: generate + store server-side,
  no ephemeral phase, then the client commits the property op).

  Follows the send-test-email.ts module conventions: outcome unions instead of
  throws, raw provider errors stay in the server log, callers get one clean
  human sentence, and every generation emits a `flock.image.request` JSON
  cost-log line (the image analogue of `flock.chat.request`).

  ARCHITECTURAL INVARIANT: base64 image data NEVER goes to Convex — not in
  ops, not in block properties. The only durable artifact is the storage
  upload; documents reference it by plain https URL.
*/

/*
  ---------------------------------------------------------------------------
  Alt text derivation (QA personas flag missing alt — always provide one)
  ---------------------------------------------------------------------------
*/

const MAX_ALT_TEXT_LENGTH = 160;

/*
  Collapse whitespace and cap at a word boundary — the prompt IS the alt text.
*/
export function deriveImageAltFromPrompt(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_ALT_TEXT_LENGTH) {
    return collapsed;
  }
  const truncated = collapsed.slice(0, MAX_ALT_TEXT_LENGTH);
  const lastSpaceIndex = truncated.lastIndexOf(" ");
  return (lastSpaceIndex > 0 ? truncated.slice(0, lastSpaceIndex) : truncated).trimEnd();
}

/*
  ---------------------------------------------------------------------------
  Base64 → binary (the upload path POSTs raw bytes, never base64)
  ---------------------------------------------------------------------------
*/

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/*
  Decode base64 into bytes, rejecting malformed input instead of silently truncating.
*/
export function base64ToUint8Array(base64: string): Uint8Array {
  const normalized = base64.trim();
  if (normalized.length === 0 || normalized.length % 4 !== 0 || !BASE64_PATTERN.test(normalized)) {
    throw new Error("base64ToUint8Array: input is not valid base64.");
  }
  return new Uint8Array(Buffer.from(normalized, "base64"));
}

/*
  ---------------------------------------------------------------------------
  Generation
  ---------------------------------------------------------------------------
*/

export type GenerateImageFailureReason =
  | "not_configured"
  | "no_quota"
  | "generation_failed";

export type GenerateEmailImageOutcome =
  | {
      isGenerated: true;
      base64: string;
      mimeType: string;
      /*
        Alt text derived from the prompt — committed alongside src.
      */
      alt: string;
      modelId: string;
    }
  | { isGenerated: false; reason: GenerateImageFailureReason; message: string };

/*
  Map a provider error to one clean human sentence (raw error stays in the log).
*/
function toFriendlyGenerationFailureMessage(error: unknown): {
  reason: GenerateImageFailureReason;
  message: string;
} {
  const errorText = error instanceof Error ? error.message : String(error);
  if (/quota|RESOURCE_EXHAUSTED|rate.?limit|429/i.test(errorText)) {
    return {
      reason: "no_quota",
      message:
        "the image service has no quota for this server's API key — image models need a billing-enabled Gemini key.",
    };
  }
  if (/safety|blocked|prohibited/i.test(errorText)) {
    return {
      reason: "generation_failed",
      message: "the image service declined this prompt — try rephrasing it.",
    };
  }
  if (/fetch|network|ENOTFOUND|ECONN|timeout/i.test(errorText)) {
    return {
      reason: "generation_failed",
      message: "the image service couldn't be reached from this server.",
    };
  }
  return {
    reason: "generation_failed",
    message: "the image service returned an unexpected error.",
  };
}

export interface GenerateEmailImageInput {
  prompt: string;
  aspectRatio?: ImageAspectRatio;
  /*
    Force the deterministic mock (route: x-flock-mock header).
  */
  isMockForced?: boolean;
  /*
    Env source, overridable in tests.
  */
  env?: Record<string, string | undefined>;
}

/*
  Generate one image (base64 + mime type + derived alt) from a text prompt.
*/
export async function generateEmailImage({
  prompt,
  aspectRatio,
  isMockForced = false,
  env = process.env,
}: GenerateEmailImageInput): Promise<GenerateEmailImageOutcome> {
  const startMs = performance.now();
  const hasGoogleApiKey = Boolean(env.GOOGLE_GENERATIVE_AI_API_KEY);
  const isUsingMock =
    isMockForced || env[MOCK_IMAGE_MODEL_ENV_VAR] === "1" || !hasGoogleApiKey;
  const modelId = isUsingMock ? MOCK_IMAGE_MODEL_ID : GEMINI_IMAGE_MODEL_ID;
  const alt = deriveImageAltFromPrompt(prompt);
  const traceId = createTraceId();
  const telemetryContext: ModelTelemetryContext = {
    operation: "image.generate",
    traceId,
    isMock: isUsingMock,
  };

  const logRequest = (details: { isOk: boolean; outputBytes?: number; reason?: string }) => {
    logRecord({
      tag: "flock.image.request",
      traceId,
      model: modelId,
      isMock: isUsingMock,
      totalMs: Math.round(performance.now() - startMs),
      /*
        The prompt LENGTH, never the prompt — prompts are user content.
      */
      promptChars: prompt.length,
      ...(aspectRatio === undefined ? {} : { aspectRatio }),
      ...details,
    });
  };

  if (isUsingMock) {
    const mockImage = createMockImagePng({ prompt, ...(aspectRatio === undefined ? {} : { aspectRatio }) });
    logRequest({ isOk: true, outputBytes: Math.round(mockImage.base64.length * 0.75) });
    return {
      isGenerated: true,
      base64: mockImage.base64,
      mimeType: mockImage.mimeType,
      alt,
      modelId,
    };
  }

  const providerCallStartMs = performance.now();
  try {
    const { image } = await generateImage({
      model: google.image(GEMINI_IMAGE_MODEL_ID),
      prompt,
      ...(aspectRatio === undefined ? {} : { aspectRatio }),
      maxRetries: IMAGE_GENERATION_MAX_RETRIES,
    });
    /*
      generateImage is NOT one of the AI SDK's telemetry-instrumented
      operations (no `telemetry` option, no lifecycle callbacks), so this path
      emits the shared flock.model.call record by hand.
    */
    logModelCall(telemetryContext, {
      provider: "google",
      modelId,
      latencyMs: performance.now() - providerCallStartMs,
    });
    logRequest({ isOk: true, outputBytes: Math.round(image.base64.length * 0.75) });
    return {
      isGenerated: true,
      base64: image.base64,
      mimeType: image.mediaType,
      alt,
      modelId,
    };
  } catch (error) {
    /*
      Raw provider error: server log only — never the user-facing outcome.
    */
    logModelFailure(telemetryContext, error);
    const failure = toFriendlyGenerationFailureMessage(error);
    logRequest({ isOk: false, reason: failure.reason });
    return { isGenerated: false, ...failure };
  }
}

/*
  ---------------------------------------------------------------------------
  Storage upload (agent path — the human path uploads client-side)
  ---------------------------------------------------------------------------
*/

export type StoreImageOutcome =
  | { isStored: true; src: string }
  | { isStored: false; message: string };

/*
  Library registration context (Content Studio Stage S).
*/
export interface StoreImageRegistrationInput {
  /*
    The calling browser's anonymous session id — the library owner.
  */
  sessionId: string;
  /*
    The generation prompt (provenance; also seeds the display name).
  */
  prompt?: string;
  /*
    Prompt-derived alt text, stored alongside the asset.
  */
  alt?: string;
}

export interface StoreImageInConvexInput {
  base64: string;
  mimeType: string;
  /*
    When present, the upload is REGISTERED in the session's asset library
    (kind "generated") — registration subsumes the getFileUrl step. Absent
    (no session cookie on the request) falls back to the bare
    upload-and-resolve path with a server log, so generation still works.
  */
  registration?: StoreImageRegistrationInput;
}

/*
  Upload generated image bytes to Convex storage, register them in the
  calling session's asset library (Content Studio Stage S — EVERY successful
  generation registers unconditionally, per binding owner decision), and
  resolve the serving URL — the server-side mirror of the human path's
  upload flow. Goes through the AUTHENTICATED helpers (auth-server.ts), not a
  bare client: `assets.register` is keyed by resolveOwnerId.
*/
export async function storeImageInConvex({
  base64,
  mimeType,
  registration,
}: StoreImageInConvexInput): Promise<StoreImageOutcome> {
  try {
    const bytes = base64ToUint8Array(base64);
    /*
      Authenticated: `assets.register` below is keyed by resolveOwnerId, so a
      generated image filed by a bare client would never reach the browser's
      library once identity exists.
    */
    const postUrl = await fetchAuthMutation(api.files.generateUploadUrl, {});
    const response = await fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type": mimeType },
      /*
        base64ToUint8Array returns a fresh, exact-length buffer — safe to wrap.
      */
      body: new Blob([bytes.buffer as ArrayBuffer], { type: mimeType }),
    });
    if (!response.ok) {
      throw new Error(`Storage upload failed with status ${response.status}`);
    }
    const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
    if (registration !== undefined) {
      const { url } = await fetchAuthMutation(api.assets.register, {
        sessionId: registration.sessionId,
        storageId,
        kind: "generated",
        ...(registration.prompt === undefined ? {} : { prompt: registration.prompt }),
        ...(registration.alt === undefined ? {} : { alt: registration.alt }),
      });
      return { isStored: true, src: url };
    }
    /*
      No session context: keep the pre-registry behavior (the file is a
      legacy unregistered upload) and leave a trace for the Stage M backfill.
    */
    logRecord({
      tag: "flock.image.storedUnregistered",
      message: "no session id on the request — the upload joined storage but not a library",
    });
    const src = await fetchAuthQuery(api.files.getFileUrl, { storageId });
    if (src === null) {
      throw new Error("Uploaded image has no serving URL");
    }
    return { isStored: true, src };
  } catch (error) {
    const summary = summarizeError(error);
    logFailure({
      tag: "flock.image.storeFailed",
      errorCode: summary.code,
      errorName: summary.name,
      statusCode: summary.statusCode,
      message: summary.message,
    });
    return { isStored: false, message: "the generated image couldn't be saved to storage." };
  }
}

/*
  ---------------------------------------------------------------------------
  Agent-path convenience: generate + store in one call
  ---------------------------------------------------------------------------
*/

export type GenerateAndStoreImageOutcome =
  | { isOk: true; src: string; alt: string }
  | { isOk: false; message: string };

export interface GenerateAndStoreImageInput {
  prompt: string;
  /*
    The calling browser's anonymous session id (or null when the request
    carried no session cookie) — the library the generation registers under.
  */
  sessionId: string | null;
  aspectRatio?: ImageAspectRatio;
  isMockForced?: boolean;
}

/*
  The agent executor's one-shot: model → storage + library registration → durable https URL + alt.
*/
export async function generateAndStoreImage({
  prompt,
  sessionId,
  aspectRatio,
  isMockForced,
}: GenerateAndStoreImageInput): Promise<GenerateAndStoreImageOutcome> {
  const generation = await generateEmailImage({
    prompt,
    ...(aspectRatio === undefined ? {} : { aspectRatio }),
    ...(isMockForced === undefined ? {} : { isMockForced }),
  });
  if (!generation.isGenerated) {
    return { isOk: false, message: generation.message };
  }
  const storage = await storeImageInConvex({
    base64: generation.base64,
    mimeType: generation.mimeType,
    ...(sessionId === null
      ? {}
      : { registration: { sessionId, prompt, alt: generation.alt } }),
  });
  if (!storage.isStored) {
    return { isOk: false, message: storage.message };
  }
  return { isOk: true, src: storage.src, alt: generation.alt };
}
