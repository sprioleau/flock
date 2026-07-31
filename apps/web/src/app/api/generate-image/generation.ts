import { google } from "@ai-sdk/google";
import { generateImage } from "ai";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  GEMINI_IMAGE_MODEL_ID,
  IMAGE_GENERATION_MAX_RETRIES,
  MOCK_IMAGE_MODEL_ENV_VAR,
  MOCK_IMAGE_MODEL_ID,
  type ImageAspectRatio,
} from "./constants";
import { createMockImagePng } from "./mock-image";

/**
 * AI image generation for image blocks — the server-only core shared by the
 * /api/generate-image route (human path: the panel renders the returned base64
 * as an INSTANT data-URI preview, then uploads in the background) and the
 * /api/chat generateImage executor (agent path: generate + store server-side,
 * no ephemeral phase, then the client commits the property op).
 *
 * Follows the send-test-email.ts module conventions: outcome unions instead of
 * throws, raw provider errors stay in the server log, callers get one clean
 * human sentence, and every generation emits a `tandem.image.request` JSON
 * cost-log line (the image analogue of `tandem.chat.request`).
 *
 * ARCHITECTURAL INVARIANT: base64 image data NEVER goes to Convex — not in
 * ops, not in block properties. The only durable artifact is the storage
 * upload; documents reference it by plain https URL.
 */

// ---------------------------------------------------------------------------
// Alt text derivation (QA personas flag missing alt — always provide one)
// ---------------------------------------------------------------------------

const MAX_ALT_TEXT_LENGTH = 160;

/** Collapse whitespace and cap at a word boundary — the prompt IS the alt text. */
export function deriveImageAltFromPrompt(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_ALT_TEXT_LENGTH) {
    return collapsed;
  }
  const truncated = collapsed.slice(0, MAX_ALT_TEXT_LENGTH);
  const lastSpaceIndex = truncated.lastIndexOf(" ");
  return (lastSpaceIndex > 0 ? truncated.slice(0, lastSpaceIndex) : truncated).trimEnd();
}

// ---------------------------------------------------------------------------
// Base64 → binary (the upload path POSTs raw bytes, never base64)
// ---------------------------------------------------------------------------

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decode base64 into bytes, rejecting malformed input instead of silently truncating. */
export function base64ToUint8Array(base64: string): Uint8Array {
  const normalized = base64.trim();
  if (normalized.length === 0 || normalized.length % 4 !== 0 || !BASE64_PATTERN.test(normalized)) {
    throw new Error("base64ToUint8Array: input is not valid base64.");
  }
  return new Uint8Array(Buffer.from(normalized, "base64"));
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export type GenerateImageFailureReason =
  | "not_configured"
  | "no_quota"
  | "generation_failed";

export type GenerateEmailImageOutcome =
  | {
      isGenerated: true;
      base64: string;
      mimeType: string;
      /** Alt text derived from the prompt — committed alongside src. */
      alt: string;
      modelId: string;
    }
  | { isGenerated: false; reason: GenerateImageFailureReason; message: string };

/** Map a provider error to one clean human sentence (raw error stays in the log). */
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
  /** Force the deterministic mock (route: x-tandem-mock header). */
  isMockForced?: boolean;
  /** Env source, overridable in tests. */
  env?: Record<string, string | undefined>;
}

/** Generate one image (base64 + mime type + derived alt) from a text prompt. */
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

  const logRequest = (details: { isOk: boolean; outputBytes?: number; reason?: string }) => {
    console.log(
      JSON.stringify({
        tag: "tandem.image.request",
        model: modelId,
        isMock: isUsingMock,
        totalMs: Math.round(performance.now() - startMs),
        promptChars: prompt.length,
        ...(aspectRatio === undefined ? {} : { aspectRatio }),
        ...details,
      }),
    );
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

  try {
    const { image } = await generateImage({
      model: google.image(GEMINI_IMAGE_MODEL_ID),
      prompt,
      ...(aspectRatio === undefined ? {} : { aspectRatio }),
      maxRetries: IMAGE_GENERATION_MAX_RETRIES,
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
    // Raw provider error: server log only — never the user-facing outcome.
    console.error(
      JSON.stringify({
        tag: "tandem.image.generationFailed",
        model: modelId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    const failure = toFriendlyGenerationFailureMessage(error);
    logRequest({ isOk: false, reason: failure.reason });
    return { isGenerated: false, ...failure };
  }
}

// ---------------------------------------------------------------------------
// Storage upload (agent path — the human path uploads client-side)
// ---------------------------------------------------------------------------

export type StoreImageOutcome =
  | { isStored: true; src: string }
  | { isStored: false; message: string };

export interface StoreImageInConvexInput {
  base64: string;
  mimeType: string;
  /** Env source, overridable in tests. */
  env?: Record<string, string | undefined>;
}

/**
 * Upload generated image bytes to Convex storage and resolve the serving URL —
 * the server-side mirror of ImageSourceField's upload flow (generateUploadUrl
 * → POST bytes → getFileUrl), via ConvexHttpClient like the personas route.
 */
export async function storeImageInConvex({
  base64,
  mimeType,
  env = process.env,
}: StoreImageInConvexInput): Promise<StoreImageOutcome> {
  const convexUrl = env.NEXT_PUBLIC_CONVEX_URL;
  if (convexUrl === undefined || convexUrl === "") {
    return { isStored: false, message: "image storage isn't configured on this server (NEXT_PUBLIC_CONVEX_URL is not set)." };
  }
  try {
    const bytes = base64ToUint8Array(base64);
    const convexClient = new ConvexHttpClient(convexUrl);
    const postUrl = await convexClient.mutation(api.files.generateUploadUrl, {});
    const response = await fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type": mimeType },
      // base64ToUint8Array returns a fresh, exact-length buffer — safe to wrap.
      body: new Blob([bytes.buffer as ArrayBuffer], { type: mimeType }),
    });
    if (!response.ok) {
      throw new Error(`Storage upload failed with status ${response.status}`);
    }
    const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
    const src = await convexClient.query(api.files.getFileUrl, { storageId });
    if (src === null) {
      throw new Error("Uploaded image has no serving URL");
    }
    return { isStored: true, src };
  } catch (error) {
    console.error(
      JSON.stringify({
        tag: "tandem.image.storeFailed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return { isStored: false, message: "the generated image couldn't be saved to storage." };
  }
}

// ---------------------------------------------------------------------------
// Agent-path convenience: generate + store in one call
// ---------------------------------------------------------------------------

export type GenerateAndStoreImageOutcome =
  | { isOk: true; src: string; alt: string }
  | { isOk: false; message: string };

export interface GenerateAndStoreImageInput {
  prompt: string;
  aspectRatio?: ImageAspectRatio;
  isMockForced?: boolean;
}

/** The agent executor's one-shot: model → storage → durable https URL + alt. */
export async function generateAndStoreImage({
  prompt,
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
  });
  if (!storage.isStored) {
    return { isOk: false, message: storage.message };
  }
  return { isOk: true, src: storage.src, alt: generation.alt };
}
