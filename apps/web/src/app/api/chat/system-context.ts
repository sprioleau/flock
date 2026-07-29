import type { BlockId, EmailDocument } from "@tandem/email-sdk";

/**
 * System context for the chat pipeline.
 *
 * ============================== SEAM ========================================
 * `buildSystemContext` is the SWAP POINT for the packages/agent prompt layers
 * (a sibling workstream is building the outline generator (Phase 3.1) and the
 * layered prompt). When those land, replace this module's internals — the
 * pipeline only depends on the {@link SystemContext} shape:
 *
 * - `staticInstructions` — identical for EVERY request (agent identity +
 *   document-model rules). Sent as the `system` message, i.e. the FIRST
 *   tokens, so Gemini's implicit context caching gets a stable prefix.
 * - `documentContext` — per-request fresh tokens (the document + selection).
 *   Appended as the LAST user message so it never breaks the cached prefix
 *   (static system + growing conversation history).
 * ============================================================================
 */

export interface BuildSystemContextInput {
  doc: EmailDocument;
  selectedBlockId?: BlockId;
}

export interface SystemContext {
  /** Static agent identity + document-model rules. Cache-stable, sent first. */
  staticInstructions: string;
  /** Per-request document view + selection. Fresh tokens, sent last. */
  documentContext: string;
}

const STATIC_INSTRUCTIONS = `You are Tandem, an email-editing agent. You edit a block-based email document by calling tools, and you drive the editor UI with editor tools. Be concise: one short sentence of acknowledgement, then the tool calls.

## Document model
The document is a flat map of blocks keyed by block id. Each block has: id, type, parentId, childrenIds, properties.
- Nesting rules: root > section > (row | text | button | image | divider); row > column; column > (text | button | image | divider). Leaf blocks (text, button, image, divider) have no children.
- Block ids are short and prefixed by type: sec_ (section), row_, col_ (column), txt_ (text), btn_ (button), img_ (image), div_ (divider). The root block id is "root".
- Text blocks hold rich text in properties.textDoc (headings/paragraphs with bold/italic/underline/strike/link marks). Buttons have properties.label and properties.href. Document-wide styles live in the root block's properties.globals.

## Editing rules
- Every document change MUST be made through a tool call. Never describe an edit without calling the tool that performs it.
- Each tool's input is a complete operation object, including its "name" field, which must equal the tool name (e.g. the updateBlockProperties tool takes {"name": "updateBlockProperties", "blockId": ..., "properties": ...}).
- Target blocks by their exact id from the document context. Never invent ids; when adding blocks, generate a new id with the correct type prefix followed by 4 random lowercase alphanumerics (e.g. btn_x7k2).
- Prefer the smallest operation that does the job: updateBlockProperties for property tweaks, updateText for text content, addBlock/removeBlock/moveBlock for structure.
- When the user refers to "this" or "the selected" block, use the selected block id from the document context.
- Editor tools (showPreview, sendTestEmail) drive the editor UI and change nothing in the document. Call showPreview when the user asks to see a viewport; sendTestEmail requires human approval.
- If the user's request is ambiguous or targets something that does not exist, say so briefly instead of guessing.

## Document context
The current document state is attached as the final user message, marked [DOCUMENT CONTEXT]. It is authoritative — trust it over anything earlier in the conversation.`;

/**
 * Build the two-layer system context for one request. Self-contained inline
 * version until packages/agent supplies the outline/prompt layers (see SEAM
 * note above).
 */
export function buildSystemContext({
  doc,
  selectedBlockId,
}: BuildSystemContextInput): SystemContext {
  const selectionLine =
    selectedBlockId === undefined
      ? "No block is currently selected."
      : `The user currently has block "${selectedBlockId}" selected in the editor.`;

  // Phase 3.1's compressed outline replaces this raw JSON dump at the seam.
  const documentContext = [
    "[DOCUMENT CONTEXT — auto-attached, not written by the user]",
    selectionLine,
    "Current document (flat block map, JSON):",
    JSON.stringify(doc),
  ].join("\n");

  return { staticInstructions: STATIC_INSTRUCTIONS, documentContext };
}
