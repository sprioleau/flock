/**
 * @tandem/agent — compressed document views, prompts, tool definitions,
 * triage/execute pipeline.
 *
 * Phase 3.1 implemented: compressed document view (outline + block details)
 * and the prompt layers it feeds (static/cacheable vs per-request — see
 * prompts/index.ts for the caching contract).
 */

export const AGENT_VERSION = "0.1.0";

// --- Compressed document view (outline, §3.1) -----------------------------------
export { generateDocumentOutline } from "./outline";
export type {
  OutlineDepth,
  DocumentOutlineOptions,
  GenerateDocumentOutlineInput,
} from "./outline";

// --- Block detail view (§9.4 catalog-lookup) ------------------------------------
export { describeBlock } from "./describe-block";
export type { DescribeBlockInput, BlockDetails } from "./describe-block";

// --- Prompt layers (static/cacheable → per-request, §3.2) --------------------------
export {
  SYSTEM_STATIC,
  buildToolGuidance,
  buildDocumentContext,
  buildAgentSystemPrompt,
} from "./prompts";
export type {
  BuildDocumentContextInput,
  BuildDocumentContextOptions,
  BuildAgentSystemPromptInput,
} from "./prompts";
