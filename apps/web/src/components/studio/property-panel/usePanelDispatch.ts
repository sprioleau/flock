"use client";

import { useCallback, useMemo } from "react";
import {
  resolveGlobalStyles,
  ROOT_BLOCK_ID,
  type BlockId,
  type GlobalStyles,
} from "@tandem/email-sdk";
import { useEditorStore } from "@/lib/editor-store";

/**
 * Panel-side dispatch helpers. Everything funnels through the store's
 * `dispatch` (the single mutation path); these just shape the operations.
 * Fields dispatch on every input event — the store's gesture coalescing
 * (UNDO_COALESCE_WINDOW_MS) keeps it at ONE Convex op (= one server-side
 * undo step) per settled gesture.
 *
 * Clearing an override: `updateBlockProperties` shallow-merges, and a key
 * explicitly set to `undefined` is REMOVED by the SDK's merge (in-memory
 * callers only — JSON callers must use replaceBlockProperties). The panel
 * dispatches in-memory, so `{ key: undefined }` is the clear path here.
 */

/** Dispatch a partial property patch to one block. */
export function useCommitBlockProperties(blockId: BlockId) {
  const dispatch = useEditorStore((state) => state.dispatch);
  return useCallback(
    (properties: Record<string, unknown>) => {
      dispatch({ name: "updateBlockProperties", blockId, properties });
    },
    [dispatch, blockId],
  );
}

/** Commit a partial global-styles patch (one settled edit) to the document. */
export function useCommitGlobalStyles() {
  const dispatch = useEditorStore((state) => state.dispatch);
  return useCallback(
    (globals: GlobalStyles) => {
      dispatch({ name: "updateDocumentSettings", globals });
    },
    [dispatch],
  );
}

/**
 * Gesture boundary for the store's coalescing: fields call this on blur so
 * the settled op flushes to Convex and the next dispatch starts a fresh
 * gesture.
 */
export function useEndCoalescing() {
  return useEditorStore((state) => state.endCoalescing);
}

/** The document's global styles with renderer defaults filled in. */
export function useResolvedGlobals(): Required<GlobalStyles> {
  const globals = useEditorStore((state) => {
    const root = state.doc[ROOT_BLOCK_ID];
    return root !== undefined && root.type === "root" ? root.properties.globals : undefined;
  });
  return useMemo(() => resolveGlobalStyles(globals), [globals]);
}
