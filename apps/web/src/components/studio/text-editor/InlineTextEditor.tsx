"use client";

// The package's default theme (includes the bubble-menu layout layer);
// inline-text-editor.css remaps its --re-* variables to our theme tokens.
import "@react-email/editor/themes/default.css";
import "./inline-text-editor.css";

import { BubbleMenu } from "@react-email/editor/ui";
import type { Editor, JSONContent } from "@tiptap/core";
import { EditorProvider } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  textDocSchema,
  type ResolvedTextNodeStyles,
  type ResolvedTextStyles,
  type TextBlock,
} from "@tandem/email-sdk";
import { useEditorStore } from "@/lib/editor-store";
import { isTextDocEqual, normalizeEditorDoc } from "./normalize-editor-doc";
import { createTextBlockExtensions } from "./text-block-extensions";

export interface InlineTextEditorProps {
  block: TextBlock;
  resolvedStyles: ResolvedTextStyles;
}

/**
 * The per-text-block inline editing surface: the Resend editor's text core
 * (reduced StarterKit) in a plain Tiptap EditorProvider, mounted in place of
 * the static TextBlockView while `editingBlockId === block.id`.
 *
 * Commit semantics (one undo step per session): the editor's own history is
 * disabled; on close (Escape, outside pointerdown, or unmount — e.g. another
 * block's editor opening) the session commits AT MOST ONE `updateText` op:
 * normalize getJSON() → validate with textDocSchema → dispatch only if the
 * doc actually changed. Validation failure keeps the block unchanged.
 */
export function InlineTextEditor({ block, resolvedStyles }: InlineTextEditorProps) {
  const dispatch = useEditorStore((state) => state.dispatch);
  const stopTextEditing = useEditorStore((state) => state.stopTextEditing);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  /** Latest doc JSON, maintained on every update — commit's fallback if the
   * Tiptap editor is already destroyed when the unmount cleanup runs. */
  const latestJsonRef = useRef<JSONContent>(block.properties.text);
  /** The doc as it was when the session opened; commit diffs against this. */
  const initialTextRef = useRef(block.properties.text);
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
    const editor = editorRef.current;
    const editorJson =
      editor !== null && !editor.isDestroyed ? editor.getJSON() : latestJsonRef.current;
    const normalized = normalizeEditorDoc(editorJson);
    const parsed = textDocSchema.safeParse(normalized);
    if (!parsed.success) {
      console.warn(
        "InlineTextEditor: normalized editor doc failed SDK validation; keeping block unchanged",
        parsed.error,
      );
      return;
    }
    if (isTextDocEqual(parsed.data, initialTextRef.current)) {
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

  const extensions = useMemo(() => createTextBlockExtensions(), []);
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
        content={block.properties.text}
        autofocus="end"
        immediatelyRender={false}
        onCreate={({ editor }) => {
          editorRef.current = editor;
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
