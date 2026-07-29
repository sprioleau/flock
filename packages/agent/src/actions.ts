import {
  blockIdSchema,
  createActionRegistry,
  defineEmailAction,
  emailActionRegistry,
  type EmailActionRegistry,
} from "@tandem/email-sdk";
import { z } from "zod";
import { describeBlock, type BlockDetails } from "./describe-block";

/**
 * Agent-level action definitions (plan §9.4 item 1 — the catalog-lookup tool).
 *
 * `getBlockDetails` lives HERE, not in the email-sdk: it wraps this package's
 * `describeBlock`, and the sdk cannot depend on @tandem/agent. The full agent
 * registry is therefore also assembled here — the sdk built-ins plus the
 * agent-only analysis actions.
 */

const getBlockDetailsInputSchema = z
  .object({
    blockId: blockIdSchema.describe(
      'The block id to look up, exactly as it appears in the document outline (e.g. "txt_r7s8").',
    ),
  })
  .describe("Input for getBlockDetails: the id of one existing block.");

/**
 * The §9.4 catalog-lookup analysis action: full JSON of one block plus its
 * ancestor chain, on demand — so the per-request outline can stay compact.
 * `run` returns null for an unknown id; the tool wrapper (apps/web chat tools)
 * turns that into a model-facing "no such block" message.
 */
export const getBlockDetailsAction = defineEmailAction({
  name: "getBlockDetails",
  description:
    "Fetch one block's COMPLETE JSON — every property, including a text block's full rich-text doc — plus its ancestor block ids (root first). Read-only; the document is unchanged. Call this before edits that must preserve or extend a block's exact current state (e.g. updateText replaces the WHOLE text doc, so fetch the full doc first — the outline truncates text and omits marks and most properties).",
  kind: "analysis",
  schema: getBlockDetailsInputSchema,
  readOnly: true,
  parallelSafe: true,
  needsApproval: false,
  run: (doc, input): BlockDetails | null => describeBlock({ doc, blockId: input.blockId }),
});

/** Every agent-only action layered on top of the sdk built-ins. */
export const agentAnalysisActions = [getBlockDetailsAction] as const;

/**
 * Build THE registry the chat route advertises and dispatches from: every
 * email-sdk built-in action (registration order preserved) plus the agent
 * analysis actions. Registering getBlockDetails also switches on
 * buildToolGuidance's catalog-lookup hint (see prompts/tool-guidance.ts).
 */
export function buildAgentActionRegistry(): EmailActionRegistry {
  return createActionRegistry([...emailActionRegistry.actions, ...agentAnalysisActions]);
}
