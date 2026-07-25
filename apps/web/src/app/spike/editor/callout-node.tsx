import { EmailNode } from "@react-email/editor/core";
import { mergeAttributes } from "@tiptap/core";

const CALLOUT_INLINE_STYLE =
  "padding: 12px 16px; background-color: #fef3c7; border-left: 3px solid #d97706; border-radius: 4px;";

/**
 * Spike probe #4 — a trivial custom block created with `EmailNode.create`
 * (from `@react-email/editor/core`). It must round-trip:
 * insert (Tiptap JSON) → parseHTML/renderHTML in the canvas →
 * renderToReactEmail in the exported email HTML.
 */
export const CalloutNode = EmailNode.create({
  name: "callout",
  group: "block",
  content: "inline*",

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-callout": "",
        style: CALLOUT_INLINE_STYLE,
      }),
      0,
    ];
  },

  renderToReactEmail({ children, style }) {
    return (
      <div
        data-callout=""
        style={{
          ...style,
          padding: "12px 16px",
          backgroundColor: "#fef3c7",
          borderLeft: "3px solid #d97706",
          borderRadius: 4,
        }}
      >
        {children}
      </div>
    );
  },
});
