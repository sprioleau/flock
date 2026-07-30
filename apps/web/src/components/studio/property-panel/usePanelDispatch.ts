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
 * explicitly set to `undefined` is REMOVED by the SDK's merge — but ONLY for
 * in-memory application. The store forwards the settled op to Convex, whose
 * serialization silently DROPS object fields whose value is `undefined`, so a
 * `{ key: undefined }` patch degrades to an empty merge server-side: the
 * override clears locally, then the next server snapshot rebases it right
 * back (the "clear snaps back" bug). Clears therefore dispatch
 * `replaceBlockProperties` with the block's full current properties minus the
 * cleared keys — one dispatch, JSON-safe, and its generated inverse restores
 * the override in one undo step.
 */

/** Dispatch a partial property patch to one block. Keys set to `undefined` clear overrides. */
export function useCommitBlockProperties(blockId: BlockId) {
  const dispatch = useEditorStore((state) => state.dispatch);
  return useCallback(
    (properties: Record<string, unknown>) => {
      const hasClearedKey = Object.values(properties).some((value) => value === undefined);
      if (!hasClearedKey) {
        dispatch({ name: "updateBlockProperties", blockId, properties });
        return;
      }
      // Clear path: replace the whole properties object without the cleared
      // keys (undefined does not survive the Convex transport — see above).
      const block = useEditorStore.getState().doc[blockId];
      if (block === undefined) {
        return;
      }
      const nextProperties: Record<string, unknown> = { ...block.properties };
      for (const [key, value] of Object.entries(properties)) {
        if (value === undefined) {
          delete nextProperties[key];
        } else {
          nextProperties[key] = value;
        }
      }
      dispatch({ name: "replaceBlockProperties", blockId, properties: nextProperties });
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
