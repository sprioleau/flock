import { Extension, Node } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { createTextBlockExtensions } from "./text-block-extensions";

/**
 * Guards the per-node-alignment contract of the editor schema.
 *
 * The bug this locks down: the Resend StarterKit's heading extension ships a
 * React node view that renders `<Heading {...node.attrs}>`, and react-email's
 * Heading forwards unknown props onto the `<h1>`. Every registered node
 * attribute therefore reached the DOM as a raw attribute — including the
 * TextAlign extension's `textAlign`, which React refuses to recognize
 * ("React does not recognize the `textAlign` prop on a DOM element") and
 * emits as an invalid lowercase `textalign="center"` instead of a style.
 *
 * The fix registers the heading with its node view returning null, so Tiptap
 * falls back to `renderHTML` and each attribute renders itself properly.
 */
describe("createTextBlockExtensions", () => {
  const extensions = createTextBlockExtensions();

  const headingNodes = extensions.filter(
    (extension): extension is Node => extension instanceof Node && extension.name === "heading",
  );

  it("registers exactly one heading extension", () => {
    expect(headingNodes).toHaveLength(1);
  });

  it("registers no node view for headings, so renderHTML owns the DOM", () => {
    const { addNodeView } = headingNodes[0]!.config;
    // A node view IS configured (overriding the kit's) but yields null —
    // Tiptap's ExtensionManager then registers none at all. It cannot be
    // merely absent: getExtensionField walks up to the parent extension,
    // which would resurrect the attribute-spreading node view.
    expect(typeof addNodeView).toBe("function");
    expect(addNodeView?.call(undefined as never)).toBeNull();
  });

  it("keeps headings to the SDK's levels 1-3", () => {
    expect(headingNodes[0]!.options).toMatchObject({ levels: [1, 2, 3] });
  });

  it("registers TextAlign for headings and paragraphs, without justify", () => {
    const textAlign = extensions.find(
      (extension): extension is Extension =>
        extension instanceof Extension && extension.name === "textAlign",
    );
    expect(textAlign?.options).toMatchObject({
      types: ["heading", "paragraph"],
      alignments: ["left", "center", "right"],
    });
  });
});
