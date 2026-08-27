/**
 * @flock/agent — compressed document views, prompts, tool definitions,
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

// --- Agent actions & registry (§9.4 item 1, Phase 3 integration) -----------------
export {
  getBlockDetailsAction,
  agentAnalysisActions,
  buildAgentActionRegistry,
} from "./actions";
export type { BuildAgentActionRegistryOptions } from "./actions";

// --- Generative-UI widget actions (host fulfills execution — see module doc) ------
export {
  askForClarificationAction,
  askForClarificationInputSchema,
  listAssetsAction,
  listAssetsInputSchema,
  materializeSectionVariations,
  proposeEditsAction,
  proposeEditsInputSchema,
  proposeSectionVariationsAction,
  proposeSectionVariationsInputSchema,
  validateEditSuggestions,
  widgetActions,
} from "./widget-actions";
export type {
  AskForClarificationInput,
  AssetSummary,
  ListAssetsInput,
  ListAssetsResult,
  ProposeEditsInput,
  ProposeEditsResult,
  ProposeSectionVariationsInput,
  ProposeSectionVariationsResult,
  SectionVariationPayload,
  ValidatedEditSuggestion,
} from "./widget-actions";

// --- Page reading contract (ONE tool — executor injected by the host) ------------
export { defineReadWebPageAction, readWebPageInputSchema } from "./read-web-page";
export type {
  ReadWebPageBlock,
  ReadWebPageFn,
  ReadWebPageInput,
  ReadWebPageList,
  ReadWebPagePayload,
  ReadWebPageResult,
} from "./read-web-page";


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
