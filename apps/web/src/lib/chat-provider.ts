import { z } from "zod";

/**
 * Which inference provider runs a chat turn — the ONE isomorphic module naming
 * them, imported by the wire contract, the settings UI, and the server-side
 * model factory alike.
 *
 * Kept deliberately separate from app/api/chat/constants.ts: that module reads
 * `process.env` at import time, so it can never be pulled into a client
 * bundle. These ids are just strings and both sides need them.
 *
 * Why two providers at all: the Gemini free tier is ~20 requests/day for the
 * WHOLE deployment, which is small enough to block a day's work. OpenRouter
 * offers free models and is the pressure valve. Gemini stays the default
 * because it is the provider every prompt and every eval was tuned against.
 */

export const CHAT_PROVIDER_IDS = ["gemini", "openrouter"] as const;

export type ChatProviderId = (typeof CHAT_PROVIDER_IDS)[number];

export const chatProviderIdSchema = z.enum(CHAT_PROVIDER_IDS);

/**
 * The provider used when nobody has chosen one — both the deployment default
 * and the fallback for any unrecognised value.
 */
export const DEFAULT_CHAT_PROVIDER_ID: ChatProviderId = "gemini";

/**
 * Narrow an untrusted string to a provider id, falling back to the default.
 * Unknown values are NOT an error anywhere: a stale localStorage entry or a
 * mistyped env var should degrade to the default, never break a turn.
 */
export function resolveChatProviderId(rawValue: string | undefined | null): ChatProviderId {
  const parsed = chatProviderIdSchema.safeParse(rawValue);
  return parsed.success ? parsed.data : DEFAULT_CHAT_PROVIDER_ID;
}

/**
 * User-facing provider names. Owner law: never expose internal ids in the UI.
 */
export const CHAT_PROVIDER_LABELS: Record<ChatProviderId, string> = {
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
};
