"use client";

// The package's default theme (includes the bubble-menu layout layer);
// inline-text-editor.css remaps its --re-* variables to our theme tokens.
import "@react-email/editor/themes/default.css";
import "./inline-text-editor.css";

import { useTiptapSync } from "@convex-dev/prosemirror-sync/tiptap";
import { BubbleMenu } from "@react-email/editor/ui";
import type { AnyExtension, Content, Editor, JSONContent } from "@tiptap/core";
import { EditorProvider } from "@tiptap/react";
import { useMutation } from "convex/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  TextBlockView,
  textDocSchema,
  type ResolvedTextNodeStyles,
  type ResolvedTextStyles,
  type TextBlock,
  type TextDoc,
} from "@tandem/email-sdk";
import { api } from "@convex/_generated/api";
import { useEditorStore } from "@/lib/editor-store";
import { isTextDocEqual, normalizeEditorDoc } from "./normalize-editor-doc";
import { createTextBlockExtensions } from "./text-block-extensions";

export interface InlineTextEditorProps {
  block: TextBlock;
  resolvedStyles: ResolvedTextStyles;
}

/**
 * The per-text-block inline editing surface: the Resend editor's text core
 * (reduced StarterKit) mounted in place of the static TextBlockView while
 * `editingBlockId === block.id` — now a LIVE collaborative doc.
 *
 * Sync model (Phase 5.1/5.2): the block id doubles as the prosemirror-sync
 * doc id. Opening the editor fires `ensureBlockDoc` (idempotent; the server
 * creates the sync doc from the block's current text — the single creation
 * path, so two clients can never race divergent initial content) and mounts
 * via `useTiptapSync`. While the snapshot loads — or the doc doesn't exist
 * yet — the static TextBlockView keeps rendering, so the click→editor swap
 * stays seamless; the editor mounts (and autofocuses) the moment sync is
 * ready. Keystrokes then flow through the sync extension's step pipeline,
 * NOT through store ops, and the server debounce-mirrors PM snapshots into
 * `block.properties.text` — which is why the mounted editor never re-reads
 * `block.properties.text` (it may lag or lead the live doc).
 *
 * Commit semantics (one undo step per session — "session op + mirror"): the
 * editor's own history stays disabled; on close (Escape, outside pointerdown,
 * or unmount — e.g. another block's editor opening) the session commits AT
 * MOST ONE `updateText` op: normalize getJSON() → validate with
 * textDocSchema → dispatch only if the doc changed since the session opened.
 * The op is the history-spine record of the session; the server mirror makes
 * its application effectively idempotent. Validation failure keeps the block
 * unchanged.
 */
export function InlineTextEditor({ block, resolvedStyles }: InlineTextEditorProps) {
  const stopTextEditing = useEditorStore((state) => state.stopTextEditing);
  const ensureBlockDoc = useMutation(api.prosemirror.ensureBlockDoc);

  const sync = useTiptapSync(api.prosemirror, block.id, {
    // One beforeunload guard per synced block gets noisy; "unsaved" signaling
    // belongs at the app level (spike B gotcha #7).
    warnOnUnsyncedClose: false,
    onSyncError: handleSyncError,
  });

  // Fire-and-forget on session open. Idempotent server-side, so the ref is
  // only about not spamming the mutation; a StrictMode double-fire would be
  // harmless. If it throws, the block row is gone — fail closed.
  const hasEnsuredDocRef = useRef(false);
  useEffect(() => {
    if (hasEnsuredDocRef.current) {
      return;
    }
    hasEnsuredDocRef.current = true;
    ensureBlockDoc({ blockId: block.id }).catch((error: unknown) => {
      console.warn("InlineTextEditor: ensureBlockDoc failed; closing the editor", error);
      stopTextEditing();
    });
  }, [block.id, ensureBlockDoc, stopTextEditing]);

  if (sync.isLoading || sync.initialContent === null) {
    // Waiting on the snapshot (or on ensureBlockDoc's server-side create —
    // the getSnapshot subscription flips this state the moment it lands).
    // Render exactly what the static branch renders so there is no flash.
    return <PendingTextView block={block} resolvedStyles={resolvedStyles} />;
  }

  return (
    <SyncedTextEditor
      block={block}
      resolvedStyles={resolvedStyles}
      initialContent={sync.initialContent}
      syncExtension={sync.extension}
    />
  );
}

function handleSyncError(error: Error): void {
  // Sync failures (e.g. the block's doc deleted server-side mid-session) are
  // non-fatal for the session: local editing keeps working and the session
  // commit still records the result on the history spine.
  console.warn("InlineTextEditor: prosemirror-sync error", error);
}

/**
 * The pre-sync stand-in: visually identical to the non-editing branch
 * (same TextBlockView, same resolved styles). Escape / outside pointerdown
 * still exit editing mode — there is no editor content to commit yet.
 */
function PendingTextView({ block, resolvedStyles }: InlineTextEditorProps) {
  const stopTextEditing = useEditorStore((state) => state.stopTextEditing);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const wrapper = wrapperRef.current;
      if (wrapper === null || !(event.target instanceof Node)) {
        return;
      }
      if (!wrapper.contains(event.target)) {
        stopTextEditing();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        stopTextEditing();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [stopTextEditing]);

  return (
    <div ref={wrapperRef}>
      <TextBlockView block={block} resolvedStyles={resolvedStyles} />
    </div>
  );
}

interface SyncedTextEditorProps extends InlineTextEditorProps {
  initialContent: Content;
  syncExtension: AnyExtension;
}

/**
 * The live editor, mounted only once the sync snapshot is available. Content
 * comes exclusively from sync (`initialContent` + the extension's step
 * stream); `block` is used for its id and never for `properties.text`.
 */
function SyncedTextEditor({
  block,
  resolvedStyles,
  initialContent,
  syncExtension,
}: SyncedTextEditorProps) {
  const dispatch = useEditorStore((state) => state.dispatch);
  const stopTextEditing = useEditorStore((state) => state.stopTextEditing);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  /** Latest doc JSON, maintained on every update — commit's fallback if the
   * Tiptap editor is already destroyed when the unmount cleanup runs. */
  const latestJsonRef = useRef<JSONContent | null>(null);
  /** The doc as it was when the editor mounted (the normalized form of the
   * sync snapshot, captured through the same getJSON()→normalize instrument
   * the commit uses); commit diffs against this. Null until onCreate — a
   * session whose editor never materialized has nothing to commit. */
  const initialTextRef = useRef<TextDoc | null>(null);
  const hasCommittedRef = useRef(false);

  const blockId = block.id;

  /** Stable across the session (zustand actions and the block id never
   * change identity), so the unmount cleanup runs it exactly once. */
  const commitSession = useCallback(() => {
    if (hasCommittedRef.current) {
      return;
    }
    hasCommittedRef.current = true;
    if (useEditorStore.getState().doc[blockId] === undefined) {
      // The block was removed mid-session (e.g. deleted via the action row);
      // there is nothing to commit to.
      return;
    }
    const initialText = initialTextRef.current;
    if (initialText === null) {
      // The Tiptap editor never finished mounting; nothing could have changed.
      return;
    }
    const editor = editorRef.current;
    const editorJson =
      editor !== null && !editor.isDestroyed ? editor.getJSON() : latestJsonRef.current;
    if (editorJson === null) {
      return;
    }
    const normalized = normalizeEditorDoc(editorJson);
    const parsed = textDocSchema.safeParse(normalized);
    if (!parsed.success) {
      console.warn(
        "InlineTextEditor: normalized editor doc failed SDK validation; keeping block unchanged",
        parsed.error,
      );
      return;
    }
    if (isTextDocEqual(parsed.data, initialText)) {
      return;
    }
    dispatch({ name: "updateText", blockId, text: parsed.data });
  }, [blockId, dispatch]);

  // Commit-and-close on any pointerdown outside the block's wrapper. The
  // bubble menu, node selector, and link form all render INSIDE the wrapper
  // (the Tiptap bubble-menu plugin appends to the editor's parent element;
  // the Radix popovers are non-portaled), so interacting with them never
  // closes the session.
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const wrapper = wrapperRef.current;
      if (wrapper === null || !(event.target instanceof Node)) {
        return;
      }
      if (!wrapper.contains(event.target)) {
        commitSession();
        stopTextEditing();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [commitSession, stopTextEditing]);

  // Safety net: whatever unmounts this editor (Escape, selection moving to
  // another block, block deletion reconcile) commits the session exactly
  // once. The guard is reset on every effect mount so StrictMode's simulated
  // mount→cleanup→mount cycle (which runs this cleanup once with an
  // unchanged doc — a no-op commit) cannot leave the real session already
  // marked committed.
  useEffect(() => {
    hasCommittedRef.current = false;
    return () => commitSession();
  }, [commitSession]);

  // PM history stays disabled inside createTextBlockExtensions (single
  // history authority: the store's session op); the sync extension carries
  // the collab plugin.
  const extensions = useMemo(
    () => [...createTextBlockExtensions(), syncExtension],
    [syncExtension],
  );
  const congruenceCss = useMemo(() => buildCongruenceCss(resolvedStyles), [resolvedStyles]);

  return (
    <div
      ref={wrapperRef}
      data-inline-text-editor=""
      style={{
        paddingTop: resolvedStyles.paddingTop,
        paddingBottom: resolvedStyles.paddingBottom,
        paddingLeft: resolvedStyles.paddingLeft,
        paddingRight: resolvedStyles.paddingRight,
      }}
    >
      <style>{congruenceCss}</style>
      <EditorProvider
        extensions={extensions}
        content={initialContent}
        autofocus="end"
        immediatelyRender={false}
        onCreate={({ editor }) => {
          editorRef.current = editor;
          latestJsonRef.current = editor.getJSON();
          if (initialTextRef.current === null) {
            // Session-open baseline: the snapshot as parsed by the actual
            // schema — measured with the commit's own instrument, so schema
            // round-tripping can never manufacture a false diff.
            initialTextRef.current = normalizeEditorDoc(latestJsonRef.current);
          }
        }}
        onUpdate={({ editor }) => {
          latestJsonRef.current = editor.getJSON();
        }}
        editorProps={{
          handleKeyDown: (_view, event) => {
            if (event.key === "Escape") {
              commitSession();
              stopTextEditing();
              return true;
            }
            return false;
          },
        }}
      >
        <BubbleMenu.Root>
          {/* Exactly the SDK's block vocabulary: P + H1-H3. */}
          <BubbleMenu.NodeSelector omit={["Bullet List", "Numbered List", "Quote", "Code"]} />
          {/* Exactly the SDK's mark set. */}
          <BubbleMenu.ItemGroup>
            <BubbleMenu.Bold />
            <BubbleMenu.Italic />
            <BubbleMenu.Underline />
            <BubbleMenu.Strike />
          </BubbleMenu.ItemGroup>
          <BubbleMenu.LinkSelector />
        </BubbleMenu.Root>
      </EditorProvider>
    </div>
  );
}

/**
 * Renderer constants mirrored from the SDK's TextBlockView (not exported):
 * heading sizes are fixed for cross-client consistency; paragraphs get
 * react-email `Text` defaults (14px / 24px).
 */
const HEADING_FONT_SIZES = { 1: "32px", 2: "24px", 3: "20px" } as const;

function headingRule(level: 1 | 2 | 3, styles: ResolvedTextNodeStyles): string {
  return `[data-inline-text-editor] .ProseMirror h${level} {
  font-family: ${styles.fontFamily};
  color: ${styles.textColor};
  text-align: ${styles.textAlign};
  font-size: ${HEADING_FONT_SIZES[level]};
  line-height: 1.3;
  font-weight: bold;
  margin: 0;
}`;
}

/**
 * Per-block content styles matching what TextBlockView resolves for the
 * same block, so the static-view → editor swap is visually seamless.
 */
function buildCongruenceCss(resolvedStyles: ResolvedTextStyles): string {
  const { paragraph, linkTextColor } = resolvedStyles;
  return [
    headingRule(1, resolvedStyles.heading1),
    headingRule(2, resolvedStyles.heading2),
    headingRule(3, resolvedStyles.heading3),
    `[data-inline-text-editor] .ProseMirror p {
  font-family: ${paragraph.fontFamily};
  color: ${paragraph.textColor};
  text-align: ${paragraph.textAlign};
  font-size: 14px;
  line-height: 24px;
  margin: 0;
}`,
    `[data-inline-text-editor] .ProseMirror a {
  color: ${linkTextColor};
  text-decoration: underline;
}`,
  ].join("\n");
}
