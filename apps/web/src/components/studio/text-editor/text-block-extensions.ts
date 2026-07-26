import { StarterKit } from "@react-email/editor/extensions";
import type { Extensions } from "@tiptap/core";

/**
 * The Resend editor's StarterKit reduced to a per-text-block schema
 * (Spike A §2.5, docs/decisions/spike-a-resend-editor-role.md): every
 * structural/email-chrome node disabled, plus everything outside the SDK's
 * text vocabulary (packages/email-sdk/src/schema/text.ts).
 *
 * What remains: doc > (paragraph | heading 1-3) > (text | hardBreak), with
 * bold / italic / underline / strike / link marks — exactly the shape
 * `textDocSchema` accepts (modulo the attr-stripping in
 * normalize-editor-doc.ts).
 */
export function createTextBlockExtensions(): Extensions {
  return [
    StarterKit.configure({
      // Structural / email chrome — the flat map owns structure; the editor
      // never sees it (canvas-architecture decision).
      Body: false,
      Container: false,
      Div: false,
      Section: false,
      TwoColumns: false,
      ThreeColumns: false,
      FourColumns: false,
      ColumnsColumn: false,
      Table: false,
      TableRow: false,
      TableCell: false,
      TableHeader: false,
      Button: false,
      Divider: false,
      PreviewText: false,
      GlobalContent: false,
      MaxNesting: false,
      TrailingNode: false,
      // Nodes/marks outside the SDK text schema (strict vocabulary).
      BulletList: false,
      OrderedList: false,
      ListItem: false,
      Blockquote: false,
      CodeBlockPrism: false,
      Code: false,
      Sup: false,
      Uppercase: false,
      PreservedStyle: false,
      // Block-level styling lives on the flat-map block, never as node
      // attrs inside the doc (text-block-model decision §2).
      AlignmentAttribute: false,
      StyleAttribute: false,
      ClassAttribute: false,
      // Single history authority: the store's undo replays SDK inverses —
      // one committed updateText op per editing session.
      UndoRedo: false,
      // SDK headings are levels 1-3 only.
      Heading: { levels: [1, 2, 3] },
    }),
  ];
}
