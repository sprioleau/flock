import {
  blockIdSchema,
  createActionRegistry,
  defineEmailAction,
  emailActionRegistry,
  type EmailActionRegistry,
} from "@flock/email-sdk";
import { z } from "zod";
import { describeBlock, type BlockDetails } from "./describe-block";
import { defineReadWebPageAction, type ReadWebPageFn } from "./read-web-page";
import { widgetActions } from "./widget-actions";

/**
 * Agent-level action definitions (plan §9.4 item 1 — the catalog-lookup tool).
 *
 * `getBlockDetails` lives HERE, not in the email-sdk: it wraps this package's
 * `describeBlock`, and the sdk cannot depend on @flock/agent. The full agent
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

export interface BuildAgentActionRegistryOptions {
  /**
   * Host-app implementation of reading one public web page (guarded fetch +
   * generic extraction). When provided, the `readWebPage` analysis action is
   * registered and buildToolGuidance switches on the source-page workflow
   * guidance; when omitted (e.g. a host with no network layer), the tool and
   * its guidance are absent — the registry stays purely local.
   *
   * ONE option, where there were two. They differed only by which extractor
   * the host would run, which is a decision that can no longer be made before
   * the page has been fetched and read.
   */
  readWebPage?: ReadWebPageFn;
  /**
   * Register the generative-UI widget actions (askForClarification,
   * proposeSectionVariations, proposeEdits, listAssets — see
   * widget-actions.ts). Only a host that renders chat widgets AND fulfills
   * the host-side executions (schema-only clarification, data-part writes,
   * the session-scoped asset listing) should enable this; when omitted, the
   * tools and their guidance are absent.
   */
  shouldIncludeWidgetActions?: boolean;
}

/**
 * Build THE registry the chat route advertises and dispatches from: every
 * email-sdk built-in action (registration order preserved) plus the agent
 * analysis actions. Registering getBlockDetails also switches on
 * buildToolGuidance's catalog-lookup hint (see prompts/tool-guidance.ts);
 * likewise the injected readWebPage switches on the source-page workflow.
 */
export function buildAgentActionRegistry(
  options?: BuildAgentActionRegistryOptions,
): EmailActionRegistry {
  const pageReadingActions =
    options?.readWebPage === undefined
      ? []
      : [defineReadWebPageAction({ readWebPage: options.readWebPage })];
  const optionalWidgetActions = options?.shouldIncludeWidgetActions === true ? widgetActions : [];
  return createActionRegistry([
    ...emailActionRegistry.actions,
    ...agentAnalysisActions,
    ...pageReadingActions,
    ...optionalWidgetActions,
  ]);
}
