import type { BlockId, EmailDocument } from "@flock/email-sdk";
import { generateDocumentOutline, type DocumentOutlineOptions } from "../outline";

/**
 * Prompt layer (c) — per-request document context. Plan §3.2.
 *
 * NOT CACHEABLE — regenerated every turn. This is the "fresh tokens" tail of
 * the prompt: it must be assembled AFTER the static layers (SYSTEM_STATIC,
 * buildToolGuidance) so it never breaks Gemini's implicit-cache prefix.
 */

export interface BuildDocumentContextOptions extends DocumentOutlineOptions {
  /** The block currently selected in the editor UI, if any. */
  selectedBlockId?: BlockId | null;
}

export interface BuildDocumentContextInput {
  doc: EmailDocument;
  options?: BuildDocumentContextOptions;
}

/**
 * Scope reminder printed under the selection line.
 *
 * SYSTEM_STATIC states the rule once, cacheably ("## How far a request
 * reaches"). This restates it in the prompt's last section with the concrete
 * id filled in, because that is the one place the model is looking when it
 * decides what "the text" refers to — and getting it wrong there repaints the
 * user's whole email for a request about one block.
 */
function buildScopeReminder(selectedBlockId: string | null): string {
  return selectedBlockId === null
    ? "Nothing is selected, so an unqualified request has no implied target: treat it as document-wide only when the user's words are document-wide, and otherwise ask which block they mean."
    : `An unqualified styling or content request ("make the text green", "make this bigger", "center it") means ${selectedBlockId} and nothing else — edit that block's own properties, not globals. Widen to the whole document only when the user's words widen it ("all", "every", "the whole email").`;
}

/**
 * The per-request document view: the compressed outline plus the user's
 * current editor selection ("this"/"it" in user messages usually means the
 * selected block).
 */
export function buildDocumentContext({
  doc,
  options = {},
}: BuildDocumentContextInput): string {
  const { selectedBlockId = null, ...outlineOptions } = options;
  const outline = generateDocumentOutline({ doc, options: outlineOptions });
  const selectedBlock = selectedBlockId !== null ? doc[selectedBlockId] : undefined;
  const selectionLine =
    selectedBlock !== undefined
      ? `selected: ${selectedBlock.id} (${selectedBlock.type})`
      : "selected: none";
  const scopeReminder = buildScopeReminder(selectedBlock?.id ?? null);
  return `## Current document\n\n${outline}\n\n## Selection\n\n${selectionLine}\n\n${scopeReminder}`;
}
