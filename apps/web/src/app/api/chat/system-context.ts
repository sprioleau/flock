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
  /**
   * Optional extra FRESH-layer line(s), e.g. the brand social-links context
   * (brand-context.ts). Fresh data only — never part of the static prefix.
   */
  brandContextLine?: string | null;
  /**
   * Optional fresh-layer saved-sections block (saved-sections-context.ts):
   * the user's own reusable sections, advertised as scaffoldSection
   * `saved:<id>` templateIds. Fresh data only — never the static prefix.
   */
  savedSectionsContext?: string | null;
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
 * Route-level static tail: how the agent SPEAKS to the user, and what it
 * refuses. Constant — safe inside the cached prefix.
 */
const USER_FACING_CONDUCT_NOTE = `## Talking to the user

Your visible replies must read like a helpful design partner, never an engineer's log:
- NEVER include block ids (sec_a1b2, btn_x9k3, "root", …), tool names, operation names, schema or validation details, batch ids, or any other internal identifiers in your prose. Ids are for tool calls only. Refer to blocks by what the user sees: "the button", "the headline", "the second section".
- Keep replies short and plain-language: say what you changed or found, not how the machinery did it.

## Scope

You ONLY help with this email — its content, structure, styling, previews, and test sends. If the user asks for anything else (general questions, code, other documents, unrelated tasks), reply with one short sentence explaining you can only help with editing this email, and do not call any tools for that request.`;

/**
 * Layers (a) + (b) + the route notes, assembled ONCE at module load: all are
 * constants for a given build, and pre-joining guarantees the byte-identical
 * prefix Gemini's implicit caching keys on.
 */
const STATIC_INSTRUCTIONS = [
  SYSTEM_STATIC,
  buildToolGuidance(chatActionRegistry),
  USER_FACING_CONDUCT_NOTE,
  DOCUMENT_CONTEXT_NOTE,
].join("\n\n");

/** Build the two-layer system context for one request. */
export function buildSystemContext({
  doc,
  selectedBlockId,
  brandContextLine,
  savedSectionsContext,
}: BuildSystemContextInput): SystemContext {
  const documentContext = [
    "[DOCUMENT CONTEXT — auto-attached, not written by the user]",
    buildDocumentContext({ doc, options: { selectedBlockId } }),
    // Fresh-layer brand context (item 26): appended after the outline so the
    // cached static prefix stays byte-identical.
    ...(brandContextLine === undefined || brandContextLine === null ? [] : [brandContextLine]),
    // Fresh-layer saved sections (owner V2): same byte-identity contract.
    ...(savedSectionsContext === undefined || savedSectionsContext === null
      ? []
      : [savedSectionsContext]),
  ].join("\n");

  return { staticInstructions: STATIC_INSTRUCTIONS, documentContext };
}
