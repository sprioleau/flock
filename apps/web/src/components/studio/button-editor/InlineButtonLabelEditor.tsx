"use client";

import { StarterKit } from "@tiptap/starter-kit";
import type { Editor } from "@tiptap/core";
import { EditorProvider } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ButtonBlock, ResolvedButtonStyles } from "@flock/email-sdk";
import { useEditorStore, useEditorStoreApi } from "@/lib/editor-store";
import { normalizeButtonLabel } from "./normalize-button-label";

export interface InlineButtonLabelEditorProps {
  block: ButtonBlock;
  resolvedStyles: ResolvedButtonStyles;
}

/**
 * Point-and-edit for button labels (owner ask 2026-07-31): a single-line
 * ProseMirror (Tiptap) surface mounted IN the button while
 * `editingBlockId === block.id`, visually congruent with the rendered
 * React Email Button.
 *
 * Design verdict — property op, NOT a synced PM doc: a label is a plain
 * string consumed by the renderer, the outline, and the agent's
 * updateBlockProperties.label path. A per-label prosemirror-sync doc would
 * add a second write path (sync mirror alongside the property op) for a
 * ~20-character string. Instead the session is LOCAL-ONLY and commits AT
 * MOST ONE `updateBlockProperties { label }` op when it settles (Escape,
 * Enter, outside pointerdown, or unmount) — the same one-op-per-session law
 * as the rich-text editor, on the same history spine. Collaboration
 * degrades to last-write-wins on that op, which is acceptable for labels
 * (stated owner-approved trade-off); the agent's label edits keep flowing
 * through updateBlockProperties untouched.
 *
 * Single-line discipline: Enter commits instead of splitting (multiline
 * pastes flatten to spaces at commit), and an emptied editor keeps the
 * previous label — the schema requires a non-empty label.
 */
export function InlineButtonLabelEditor({ block, resolvedStyles }: InlineButtonLabelEditorProps) {
  const dispatch = useEditorStore((state) => state.dispatch);
  const stopTextEditing = useEditorStore((state) => state.stopTextEditing);
  // The FRAME's store instance (not the active one): this editor may live in
  // a non-active sibling frame, and the commit must check THAT document.
  const editorStoreApi = useEditorStoreApi();

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const hasCommittedRef = useRef(false);
  const blockId = block.id;
  const initialLabel = block.properties.label;

  const commitSession = useCallback(() => {
    if (hasCommittedRef.current) {
      return;
    }
    hasCommittedRef.current = true;
    if (editorStoreApi.getState().doc[blockId] === undefined) {
      // The block was removed mid-session; nothing to commit to.
      return;
    }
    const editor = editorRef.current;
    if (editor === null || editor.isDestroyed) {
      return;
    }
    // Flatten to one line: paragraph breaks (multiline paste) become spaces.
    const label = normalizeButtonLabel(editor.getText({ blockSeparator: " " }));
    if (label === "" || label === initialLabel) {
      return;
    }
    dispatch({ name: "updateBlockProperties", blockId, properties: { label } });
  }, [blockId, dispatch, editorStoreApi, initialLabel]);

  // Commit-and-close on any pointerdown outside the button's wrapper.
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

  // Safety net: whatever unmounts the editor commits the session exactly
  // once (guard reset per mount for StrictMode's simulated cycle — a no-op
  // commit, since the label hasn't changed by then).
  useEffect(() => {
    hasCommittedRef.current = false;
    return () => commitSession();
  }, [commitSession]);

  // Plain single-line text: no marks, no headings, no lists, no PM history
  // (the store's op spine is the single undo authority).
  const extensions = useMemo(
    () => [
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        hardBreak: false,
        heading: false,
        horizontalRule: false,
        italic: false,
        link: false,
        listItem: false,
        orderedList: false,
        strike: false,
        underline: false,
        undoRedo: false,
      }),
    ],
    [],
  );

  const hasBorder = resolvedStyles.borderSize > 0;

  return (
    <div
      ref={wrapperRef}
      data-inline-button-label-editor=""
      style={{
        paddingTop: resolvedStyles.paddingTop,
        paddingBottom: resolvedStyles.paddingBottom,
        paddingLeft: resolvedStyles.paddingLeft,
        paddingRight: resolvedStyles.paddingRight,
        textAlign: resolvedStyles.align,
      }}
    >
      {/* Visual replica of the SDK ButtonBlockView's anchor (same resolved
          styles + React Email Button's inline-block/line-height chrome), so
          the static-view → editor swap is seamless. */}
      <div
        style={{
          display: "inline-block",
          maxWidth: "100%",
          lineHeight: "120%",
          textDecoration: "none",
          textAlign: "left",
          backgroundColor: resolvedStyles.backgroundColor,
          color: resolvedStyles.textColor,
          borderRadius: `${resolvedStyles.borderRadius}px`,
          ...(hasBorder
            ? { border: `${resolvedStyles.borderSize}px solid ${resolvedStyles.borderColor}` }
            : {}),
          padding: `${resolvedStyles.verticalPadding}px ${resolvedStyles.horizontalPadding}px`,
          fontFamily: resolvedStyles.fontFamily,
        }}
      >
        <style>{`
          [data-inline-button-label-editor] .ProseMirror { outline: none; }
          [data-inline-button-label-editor] .ProseMirror p { margin: 0; }
        `}</style>
        <EditorProvider
          extensions={extensions}
          content={{
            type: "doc",
            content: [
              {
                type: "paragraph",
                content:
                  initialLabel.length > 0 ? [{ type: "text", text: initialLabel }] : undefined,
              },
            ],
          }}
          autofocus="end"
          immediatelyRender={false}
          onCreate={({ editor }) => {
            editorRef.current = editor;
          }}
          editorProps={{
            handleKeyDown: (_view, event) => {
              if (event.key === "Enter" || event.key === "Escape") {
                commitSession();
                stopTextEditing();
                return true;
              }
              return false;
            },
          }}
        />
      </div>
    </div>
  );
}
