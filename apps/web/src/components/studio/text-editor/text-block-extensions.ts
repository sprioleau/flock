import { StarterKit } from "@react-email/editor/extensions";
import type { Extensions } from "@tiptap/core";
import { Highlight } from "@tiptap/extension-highlight";
import { Color, FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";

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
 *
 * Span-level typography (gap #7 candidate set, out-of-the-box only): the
 * Resend StarterKit ships no TextStyle-family extensions, so the OFFICIAL
 * Tiptap ones are layered on top — one `textStyle` mark carrying
 * fontFamily/color/fontSize attrs, plus the multicolor `highlight` mark.
 * Both map 1:1 onto the SDK's textStyleMarkSchema/highlightMarkSchema.
 * LineHeight/BackgroundColor (the rest of the text-style family) stay OUT:
 * they are not in the SDK vocabulary.
 */
export function createTextBlockExtensions(): Extensions {
  return [
    // One mark type ("textStyle") whose attrs the three sub-extensions
    // register; renders as a plain inline-styled <span> — email-safe.
    TextStyle,
    FontFamily,
    Color,
    FontSize,
    // Renders <mark data-color style="background-color:…">; multicolor so the
    // color is explicit (the SDK schema requires it — no UA-default yellow).
    Highlight.configure({ multicolor: true }),
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
