import { GENERATE_IMAGE_MAX_PROMPT_LENGTH } from "@flock/email-sdk";
import { z } from "zod";
import { IMAGE_ASPECT_RATIOS } from "./constants";

/**
 * /api/generate-image wire contract — imported by both the route and the
 * client's Generate-with-AI panel field (isomorphic: Zod + types only).
 */

export const GENERATE_IMAGE_API_PATH = "/api/generate-image";

export const generateImageRequestBodySchema = z.strictObject({
  prompt: z.string().min(1).max(GENERATE_IMAGE_MAX_PROMPT_LENGTH),
  aspectRatio: z.enum(IMAGE_ASPECT_RATIOS).optional(),
});

export type GenerateImageRequestBody = z.infer<typeof generateImageRequestBodySchema>;

export interface GenerateImageResponseBody {
  base64: string;
  mimeType: string;
  /** Alt text derived from the prompt — committed alongside src. */
  alt: string;
}

export interface GenerateImageErrorResponseBody {
  /** "out_of_credits" is the AI allowance (convex/authCredits.ts), not a failure. */
  error: "invalid_request" | "generation_failed" | "out_of_credits";
  message: string;
}
