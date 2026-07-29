import type { EmailActionRegistry, EmailDocument } from "@tandem/email-sdk";
import { buildDocumentContext, type BuildDocumentContextOptions } from "./document-context";
import { SYSTEM_STATIC } from "./system-static";
import { buildToolGuidance } from "./tool-guidance";

export { SYSTEM_STATIC } from "./system-static";
export { buildToolGuidance } from "./tool-guidance";
export {
  buildDocumentContext,
  type BuildDocumentContextInput,
  type BuildDocumentContextOptions,
} from "./document-context";

/**
 * Prompt layer assembly (plan §3.2), in cache-friendly order:
 *
 *   1. SYSTEM_STATIC              static   — identical every request
 *   2. buildToolGuidance(registry) static  — identical per SDK build
 *   3. buildDocumentContext(...)  per-request — fresh tokens, always last
 *
 * The provider is Gemini: implicit context caching discounts the longest
 * byte-identical prefix across requests, so layers 1–2 are effectively cached
 * and only layer 3 (+ the user message) is paid fresh each turn. Keep it that
 * way — never insert per-request content above layer 3.
 */
export interface BuildAgentSystemPromptInput {
  doc: EmailDocument;
  registry: EmailActionRegistry;
  options?: BuildDocumentContextOptions;
}

/** Assemble the full system prompt: static layers first, fresh tokens last. */
export function buildAgentSystemPrompt({
  doc,
  registry,
  options,
}: BuildAgentSystemPromptInput): string {
  return [SYSTEM_STATIC, buildToolGuidance(registry), buildDocumentContext({ doc, options })].join(
    "\n\n",
  );
}
