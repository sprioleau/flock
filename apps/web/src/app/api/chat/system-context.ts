import { buildDocumentContext, buildToolGuidance, SYSTEM_STATIC } from "@tandem/agent";
import type { BlockId, EmailDocument } from "@tandem/email-sdk";
import { chatActionRegistry } from "./registry";

/**
 * System context for the chat pipeline — composed from the packages/agent
 * prompt layers (the Phase 3 integration; this module was the marked seam).
 *
 * Caching contract (see packages/agent/src/prompts/index.ts):
 *
 * - `staticInstructions` — layers (a) SYSTEM_STATIC + (b) buildToolGuidance,
 *   both byte-identical for EVERY request (the guidance is a pure function of
 *   the module-level registry). Sent as the `system` message, i.e. the FIRST
 *   tokens, so Gemini's implicit context caching gets a stable prefix.
 * - `documentContext` — layer (c) buildDocumentContext: per-request fresh
 *   tokens (compressed outline + selection). Appended as the LAST user message
 *   so it never breaks the cached prefix (static system + conversation).
 */

export interface BuildSystemContextInput {
  doc: EmailDocument;
  selectedBlockId?: BlockId;
}

export interface SystemContext {
  /** Static agent identity + document model + tool guidance. Cache-stable, sent first. */
  staticInstructions: string;
  /** Per-request document outline + selection. Fresh tokens, sent last. */
  documentContext: string;
}

/**
 * Route-level static tail: HOW this transport attaches the per-request
 * document view. Constant — safe inside the cached prefix.
 */
const DOCUMENT_CONTEXT_NOTE = `## Document context

The current document state is attached as the final user message, marked [DOCUMENT CONTEXT]. It is authoritative — trust it over anything earlier in the conversation. It is a compressed outline: text is truncated and most properties are omitted, so call getBlockDetails when an edit depends on a block's exact current contents. When the user says "this" or "the selected" block, use the id under "## Selection".`;

/**
 * Layers (a) + (b) + the route note, assembled ONCE at module load: all are
 * constants for a given build, and pre-joining guarantees the byte-identical
 * prefix Gemini's implicit caching keys on.
 */
const STATIC_INSTRUCTIONS = [
  SYSTEM_STATIC,
  buildToolGuidance(chatActionRegistry),
  DOCUMENT_CONTEXT_NOTE,
].join("\n\n");

/** Build the two-layer system context for one request. */
export function buildSystemContext({
  doc,
  selectedBlockId,
}: BuildSystemContextInput): SystemContext {
  const documentContext = [
    "[DOCUMENT CONTEXT — auto-attached, not written by the user]",
    buildDocumentContext({ doc, options: { selectedBlockId } }),
  ].join("\n");

  return { staticInstructions: STATIC_INSTRUCTIONS, documentContext };
}
