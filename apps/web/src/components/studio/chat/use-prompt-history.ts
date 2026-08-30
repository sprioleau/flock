"use client";

import { useRef } from "react";

/**
 * Up-arrow prompt recall for the chat composer (readline-style).
 *
 * Scope: in-memory for the panel's lifetime — the panel mounts per studio
 * document, so history is naturally per document and resets on reload (the
 * same session-scoped recall ChatGPT/Claude web give you; no localStorage, so
 * prompts never bleed across documents or tabs). Capped at
 * {@link MAX_HISTORY_ENTRIES}.
 *
 * Navigation rules (native behavior — arrow keys must keep working for
 * multi-line drafts):
 * - ArrowUp starts recall ONLY when the composer is empty or the caret sits
 *   at position 0 (start of the first line). Otherwise the key falls through
 *   to normal caret movement.
 * - While browsing, the recalled entry is compared to the composer text: as
 *   long as it is UNMODIFIED, ArrowUp/ArrowDown keep walking the history
 *   (regardless of caret — repeated presses walk back like a shell). The
 *   moment the user edits the text, browsing ends and the edit becomes the
 *   working draft.
 * - Walking forward past the newest entry restores the draft that was in the
 *   composer when recall started.
 */

const MAX_HISTORY_ENTRIES = 50;

export interface PromptHistoryNavigationInput {
  direction: "older" | "newer";
  draftText: string;
  selectionStart: number;
  selectionEnd: number;
}

export interface PromptHistory {
  /*
    Record a sent prompt (consecutive duplicates collapse; capped at 50).
  */
  recordPrompt: (text: string) => void;
  /*
    Attempt one history step. Returns the text to put in the composer, or
    null when the keypress should fall through to normal caret movement.
  */
  navigate: (input: PromptHistoryNavigationInput) => string | null;
  /*
    Leave browsing mode (call after every send).
  */
  resetNavigation: () => void;
}

export function usePromptHistory(): PromptHistory {
  const entriesRef = useRef<string[]>([]);
  const browseIndexRef = useRef<number | null>(null);
  const stashedDraftRef = useRef("");

  const recordPrompt = (text: string): void => {
    const trimmedText = text.trim();
    if (trimmedText.length === 0) {
      return;
    }
    const entries = entriesRef.current;
    if (entries.at(-1) === trimmedText) {
      return;
    }
    entries.push(trimmedText);
    if (entries.length > MAX_HISTORY_ENTRIES) {
      entries.shift();
    }
  };

  const navigate = ({
    direction,
    draftText,
    selectionStart,
    selectionEnd,
  }: PromptHistoryNavigationInput): string | null => {
    const entries = entriesRef.current;
    const browseIndex = browseIndexRef.current;
    const isBrowsingUnmodified = browseIndex !== null && draftText === entries[browseIndex];

    if (direction === "older") {
      if (isBrowsingUnmodified) {
        if (browseIndex === 0) {
          /*
            Already at the oldest entry — swallow the key, keep the text.
          */
          return draftText;
        }
        browseIndexRef.current = browseIndex - 1;
        return entries[browseIndex - 1];
      }
      const isCaretAtStart = selectionStart === 0 && selectionEnd === 0;
      const isComposerEmpty = draftText.length === 0;
      if (entries.length === 0 || (!isComposerEmpty && !isCaretAtStart)) {
        return null;
      }
      stashedDraftRef.current = draftText;
      browseIndexRef.current = entries.length - 1;
      return entries[entries.length - 1];
    }

    /*
      direction === "newer": only meaningful while browsing an unmodified entry.
    */
    if (!isBrowsingUnmodified) {
      return null;
    }
    if (browseIndex === entries.length - 1) {
      browseIndexRef.current = null;
      return stashedDraftRef.current;
    }
    browseIndexRef.current = browseIndex + 1;
    return entries[browseIndex + 1];
  };

  const resetNavigation = (): void => {
    browseIndexRef.current = null;
    stashedDraftRef.current = "";
  };

  return { recordPrompt, navigate, resetNavigation };
}
