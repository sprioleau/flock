"use client";

import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BubbleMenuItem,
  useBubbleMenuContext,
} from "@react-email/editor/ui";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import type { ReactNode } from "react";
import type { TextAlign } from "@tandem/email-sdk";

/**
 * Per-paragraph alignment controls for the inline-editor bubble menu.
 *
 * These drive the official TextAlign extension's `textAlign` node attr on the
 * selection's paragraph/heading nodes (text-block-extensions) — NOT a
 * block-property op: per-node alignment is content-level formatting that
 * rides the prosemirror-sync step pipeline and the session's one `updateText`
 * op, exactly like marks. The block's own properties.textAlign (property
 * panel) stays the default; a node attr overrides it for that node only.
 *
 * Resend's pre-wired BubbleMenu.Align* buttons are NOT used: they are bound
 * to Resend's `alignment` attr (its AlignmentAttribute extension, disabled in
 * our schema). These compose the same BubbleMenuItem primitive, so the look
 * (and the --re-*→shadcn contrast remap in inline-text-editor.css) matches
 * the B/I/U/S buttons for free.
 *
 * Toggle semantics: clicking the active alignment clears the attr back to
 * null — "inherit the block's alignment" — so no lit button means inherited.
 * isActive only matches explicit attrs, never the inherited value.
 */

/** The node types carrying the textAlign attr (TextAlign `types` option). */
const ALIGNABLE_NODE_TYPES = ["heading", "paragraph"] as const;

/**
 * `toggleTextAlign(align)`, spelled with core-typed commands. The TextAlign
 * extension's own commands are typed via a `declare module "@tiptap/core"`
 * augmentation that the typescript6/native checker merges unreliably
 * (toggleTextAlign intermittently "does not exist on ChainedCommands"), so
 * this mirrors the extension's implementation — updateAttributes /
 * resetAttributes per type — which is what setTextAlign/unsetTextAlign do.
 */
function toggleNodeTextAlign(editor: Editor, align: TextAlign): void {
  const isActive = editor.isActive({ textAlign: align });
  const chain = editor.chain().focus();
  for (const nodeType of ALIGNABLE_NODE_TYPES) {
    if (isActive) {
      chain.resetAttributes(nodeType, "textAlign");
    } else {
      chain.updateAttributes(nodeType, { textAlign: align });
    }
  }
  chain.run();
}

const ALIGNMENT_OPTIONS: ReadonlyArray<{
  align: TextAlign;
  name: string;
  icon: ReactNode;
}> = [
  { align: "left", name: "align-left", icon: <AlignLeftIcon /> },
  { align: "center", name: "align-center", icon: <AlignCenterIcon /> },
  { align: "right", name: "align-right", icon: <AlignRightIcon /> },
];

export function AlignmentControls() {
  const { editor } = useBubbleMenuContext();
  const activeAlign = useEditorState({
    editor,
    selector: ({ editor: editorState }): TextAlign | null => {
      for (const { align } of ALIGNMENT_OPTIONS) {
        if (editorState?.isActive({ textAlign: align }) === true) {
          return align;
        }
      }
      return null;
    },
  });

  return (
    <>
      {ALIGNMENT_OPTIONS.map(({ align, name, icon }) => (
        <BubbleMenuItem
          key={align}
          name={name}
          isActive={activeAlign === align}
          onCommand={() => {
            if (editor !== null) {
              toggleNodeTextAlign(editor, align);
            }
          }}
          // Keep the editor's selection: never let the trigger steal focus.
          onPointerDown={(event) => event.preventDefault()}
        >
          {icon}
        </BubbleMenuItem>
      ))}
    </>
  );
}
