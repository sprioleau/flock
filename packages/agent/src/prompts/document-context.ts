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
  return `## Current document\n\n${outline}\n\n## Selection\n\n${selectionLine}`;
}
