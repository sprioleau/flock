"use client";

// The package's default theme (includes the bubble-menu layout layer);
// inline-text-editor.css remaps its --re-* variables to our theme tokens.
import "@react-email/editor/themes/default.css";
import "./inline-text-editor.css";
import "./presence-cursors.css";

import { useTiptapSync } from "@convex-dev/prosemirror-sync/tiptap";
import { BubbleMenu } from "@react-email/editor/ui";
import type { AnyExtension, Content, Editor, JSONContent } from "@tiptap/core";
import { EditorProvider } from "@tiptap/react";
import { useConvex, useMutation } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TextBlockView,
  textDocSchema,
  type ResolvedTextNodeStyles,
  type ResolvedTextStyles,
  type TextBlock,
  type TextDoc,
} from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import { useEditorStore, useEditorStoreApi } from "@/lib/editor-store";
import { useBroadcastPresence, usePresenceRoster } from "@/lib/presence";
import { createAgentPulseExtension } from "./agent-pulse-extension";
import { AlignmentControls } from "./alignment-controls";
import { getCollabSelectionVersion } from "./collab-sync-state";
import { isTextDocEqual, normalizeEditorDoc } from "./normalize-editor-doc";
import {
  createRemoteCursorsExtension,
  updateRemoteCursors,
  type RemoteCursor,
} from "./remote-cursors-extension";
import {
  FontFamilySelector,
  FontSizeSelector,
  HighlightSelector,
  TextColorSelector,
} from "./span-style-controls";
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
 * Sync model (Phase 5.1/5.2): the sync doc id is the document-scoped
 * composite `${documentId}:${blockId}` (block ids alone are only unique
 * within a document). Opening the editor fires `ensureBlockDoc` (idempotent; the server
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
  const documentId = useEditorStore((state) => state.documentId);
  const ensureBlockDoc = useMutation(api.prosemirror.ensureBlockDoc);
  const broadcastPresence = useBroadcastPresence();

  // Click-to-editable instrumentation (Phase 6.2b latency fix): the editing
  // session starts the render this component first mounts — within a tick of
  // the store's startTextEditing — and ends at the Tiptap onCreate below.
  const [editorOpenedAt] = useState<number | null>(() =>
    typeof performance === "undefined" ? null : performance.now(),
  );

  // Presence (6.2a contract): the provider owns broadcasting editingBlockId
  // (it watches the editor store); 6.2b owns ONLY the `selection` field.
  // Clear it on every editor-close path — this component unmounts on all of
  // them, and Tiptap's blur event does not fire on unmount.
  useEffect(() => {
    return () => broadcastPresence({ selection: undefined });
  }, [broadcastPresence]);

  // Document-scoped sync doc id (block ids alone collide across sample and
  // forked documents; format mirrored server-side in model/textBlockSync.ts).
  // documentId is always set while the studio canvas is interactive; the
  // fallback id fails checkRead and the editor stays in PendingTextView.
  const syncDocId = `${documentId ?? "detached"}:${block.id}`;

  const sync = useTiptapSync(api.prosemirror, syncDocId, {
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
    if (hasEnsuredDocRef.current || documentId === null) {
      return;
    }
    hasEnsuredDocRef.current = true;
    ensureBlockDoc({ documentId, blockId: block.id }).catch((error: unknown) => {
      console.warn("InlineTextEditor: ensureBlockDoc failed; closing the editor", error);
      stopTextEditing();
    });
  }, [block.id, documentId, ensureBlockDoc, stopTextEditing]);

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
      syncDocId={syncDocId}
      editorOpenedAt={editorOpenedAt}
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
  syncDocId: string;
  /** performance.now() at editing-session start, for latency instrumentation. */
  editorOpenedAt: number | null;
}

/**
 * The live editor, mounted only once the sync snapshot is available. Content
 * comes exclusively from sync (`initialContent` + the extension's step
 * stream); `block` is used for its id and never for `properties.text`.
 *
 * Presence (Phase 6.2b): local selection is broadcast on focus/selection
 * change through the 6.2a presence hook (throttled inside the hook — nothing
 * here debounces or sits on the keystroke path), tagged with the collab sync
 * version read from the editor state. Remote roster selections targeting
 * this block render as decorations via the remote-cursors extension, and
 * agent-authored steps flash via the agent-pulse extension.
 */
function SyncedTextEditor({
  block,
  resolvedStyles,
  initialContent,
  syncExtension,
  syncDocId,
  editorOpenedAt,
}: SyncedTextEditorProps) {
  const dispatch = useEditorStore((state) => state.dispatch);
  const stopTextEditing = useEditorStore((state) => state.stopTextEditing);
  // The FRAME's store instance (not the active one): this editor may live in
  // a non-active sibling frame, and the commit must check THAT document.
  const editorStoreApi = useEditorStoreApi();
  const broadcastPresence = useBroadcastPresence();
  const roster = usePresenceRoster();
  const convex = useConvex();

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
    if (editorStoreApi.getState().doc[blockId] === undefined) {
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
  }, [blockId, dispatch, editorStoreApi]);

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

  // WRITE PATH (presence): selection broadcast on Tiptap focus/selection
  // events. The 6.2a hook throttles + single-flights internally; the collab
  // version is read straight off the editor state (see collab-sync-state.ts)
  // so it costs nothing. Renderers clamp remote positions regardless.
  const broadcastSelection = useCallback(
    (editor: Editor) => {
      const version = getCollabSelectionVersion(editor.state);
      broadcastPresence({
        selection: {
          blockId,
          anchor: editor.state.selection.anchor,
          head: editor.state.selection.head,
          ...(version === null ? {} : { version }),
        },
      });
    },
    [blockId, broadcastPresence],
  );

  // READ PATH (presence): other online members whose selection targets THIS
  // block, pushed into the remote-cursors plugin as meta-only transactions.
  const remoteCursors = useMemo<RemoteCursor[]>(
    () =>
      roster.flatMap((member) => {
        const selection = member.data.selection;
        if (
          member.isSelf ||
          !member.isOnline ||
          selection === undefined ||
          selection.blockId !== blockId
        ) {
          return [];
        }
        return [
          {
            userId: member.userId,
            name: member.data.name,
            color: member.data.color,
            anchor: selection.anchor,
            head: selection.head,
            version: selection.version,
            isAgent: member.data.isAgent === true,
          },
        ];
      }),
    [roster, blockId],
  );
  /** Latest roster-derived cursors, so onCreate can seed the plugin when the
   * editor materializes after the roster already arrived. */
  const remoteCursorsRef = useRef<RemoteCursor[]>(remoteCursors);
  useEffect(() => {
    remoteCursorsRef.current = remoteCursors;
    const editor = editorRef.current;
    if (editor !== null && !editor.isDestroyed) {
      updateRemoteCursors({ editor, cursors: remoteCursors });
    }
  }, [remoteCursors]);

  // Agent-pulse attribution: prosemirror-collab doesn't expose step
  // clientIds client-side, so the pulse plugin hands us a confirmed version
  // window and we ask the server which clientIds authored it (getSteps
  // returns steps paired with clientIds). Fires only when remote steps
  // arrive — never on local keystrokes.
  const resolveClientIds = useCallback(
    async ({ fromVersion, stepCount }: { fromVersion: number; stepCount: number }) => {
      const result = await convex.query(api.prosemirror.getSteps, {
        id: syncDocId,
        version: fromVersion,
      });
      return result.clientIds.slice(0, stepCount);
    },
    [convex, syncDocId],
  );

  // PM history stays disabled inside createTextBlockExtensions (single
  // history authority: the store's session op); the sync extension carries
  // the collab plugin. The presence extensions are pure view-layer
  // decoration plugins — no schema or content behavior.
  const extensions = useMemo(
    () => [
      ...createTextBlockExtensions(),
      syncExtension,
      createRemoteCursorsExtension(),
      createAgentPulseExtension({ resolveClientIds }),
    ],
    [syncExtension, resolveClientIds],
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
          if (editorOpenedAt !== null) {
            console.debug(
              `[flock] click-to-editable: ${Math.round(performance.now() - editorOpenedAt)}ms (${syncDocId})`,
            );
          }
          // Seed remote cursors that arrived before the editor materialized.
          if (remoteCursorsRef.current.length > 0) {
            updateRemoteCursors({ editor, cursors: remoteCursorsRef.current });
          }
        }}
        onUpdate={({ editor }) => {
          latestJsonRef.current = editor.getJSON();
        }}
        onSelectionUpdate={({ editor }) => broadcastSelection(editor)}
        onFocus={({ editor }) => broadcastSelection(editor)}
        onBlur={() => broadcastPresence({ selection: undefined })}
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
          {/* Span-level typography: the textStyle + highlight marks
              (span-style-controls.tsx; popovers are non-portaled — see the
              outside-pointerdown invariant above). */}
          <BubbleMenu.ItemGroup>
            <FontFamilySelector />
            <FontSizeSelector />
            <TextColorSelector />
            <HighlightSelector />
          </BubbleMenu.ItemGroup>
          {/* Per-paragraph alignment: node attrs via the TextAlign extension
              (content-level, rides the sync pipeline — NOT a block op). */}
          <BubbleMenu.ItemGroup>
            <AlignmentControls />
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
  word-wrap: break-word;
  word-break: break-word;
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
  word-wrap: break-word;
  word-break: break-word;
}`,
    `[data-inline-text-editor] .ProseMirror a {
  color: ${linkTextColor};
  text-decoration: underline;
}`,
  ].join("\n");
}
