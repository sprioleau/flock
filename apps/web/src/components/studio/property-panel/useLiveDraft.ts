"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/*
  Live-committing field draft: every input event commits immediately so the
  canvas tracks in real time (no debounce anywhere in the property panel).
  Convex traffic and undo granularity are handled downstream by the editor
  store's gesture coalescing (UNDO_COALESCE_WINDOW_MS) — rapid same-field
  dispatches merge into ONE settled op sent to Convex, whose server-generated
  inverse snapshots the gesture's starting value.

  The draft is the field's local text while editing; the external (store)
  value only resyncs it while the field is NOT focused, so clamped/invalid
  intermediate keystrokes don't fight the input. Blur resyncs the draft and
  ends the coalescing run (a gesture boundary).
*/

export interface UseLiveDraftInput<T> {
  /*
    The committed external value (from the editor store).
  */
  value: T;
  /*
    Called on every draft change; implementations may skip invalid drafts.
  */
  onCommit: (value: T) => void;
  /*
    Called on blur — the field's gesture boundary (store.endCoalescing).
  */
  onGestureEnd?: () => void;
}

export interface UseLiveDraftResult<T> {
  draft: T;
  /*
    Update the draft and commit immediately.
  */
  setDraft: (next: T) => void;
  handleFocus: () => void;
  handleBlur: () => void;
}

export function useLiveDraft<T>({
  value,
  onCommit,
  onGestureEnd,
}: UseLiveDraftInput<T>): UseLiveDraftResult<T> {
  const [draft, setDraftState] = useState<T>(value);
  const isEditingRef = useRef(false);
  const externalValueRef = useRef(value);
  const onCommitRef = useRef(onCommit);
  const onGestureEndRef = useRef(onGestureEnd);

  useEffect(() => {
    externalValueRef.current = value;
    onCommitRef.current = onCommit;
    onGestureEndRef.current = onGestureEnd;
  });

  /*
    Resync the draft when the store value changes while the field is idle
    (undo/redo, another control, agent edits).
  */
  useEffect(() => {
    if (!isEditingRef.current) {
      setDraftState(value);
    }
  }, [value]);

  const setDraft = useCallback((next: T) => {
    setDraftState(next);
    onCommitRef.current(next);
  }, []);

  const handleFocus = useCallback(() => {
    isEditingRef.current = true;
  }, []);

  const handleBlur = useCallback(() => {
    isEditingRef.current = false;
    /*
      Snap the draft back to the committed value (drops invalid/clamped text)
      and end the undo-coalescing run.
    */
    setDraftState(externalValueRef.current);
    onGestureEndRef.current?.();
  }, []);

  return { draft, setDraft, handleFocus, handleBlur };
}
