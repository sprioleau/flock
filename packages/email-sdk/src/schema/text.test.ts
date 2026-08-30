import { describe, expect, it } from "vitest";
import { createTextDoc, textDocSchema, textMarkSchema } from "./text";

const paragraphWith = (content: unknown[]) => ({
  type: "doc",
  content: [{ type: "paragraph", content }],
});

describe("textDocSchema — happy paths", () => {
  it("accepts a single plain paragraph", () => {
    const result = textDocSchema.safeParse(createTextDoc("Hello world"));
    expect(result.success).toBe(true);
  });

  it("accepts an empty paragraph (doc with no visible text)", () => {
    expect(textDocSchema.safeParse(createTextDoc()).success).toBe(true);
  });

  it("accepts mixed headings (levels 1–3) and paragraphs in one doc", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "H1" }] },
        { type: "paragraph", content: [{ type: "text", text: "Body" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "H2" }] },
        { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "H3" }] },
      ],
    };
    expect(textDocSchema.safeParse(doc).success).toBe(true);
  });

  it("accepts a per-node textAlign attr on paragraphs and headings", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1, textAlign: "center" },
          content: [{ type: "text", text: "Centered heading" }],
        },
        {
          type: "paragraph",
          attrs: { textAlign: "right" },
          content: [{ type: "text", text: "Right paragraph" }],
        },
        /*
          Explicit left is meaningful (overrides a centered block default).
        */
        { type: "paragraph", attrs: { textAlign: "left" } },
        /*
          Missing attrs = inherit the block's alignment (the pre-attr shape).
        */
        { type: "paragraph", content: [{ type: "text", text: "Inherits" }] },
      ],
    };
    expect(textDocSchema.safeParse(doc).success).toBe(true);
  });

  it("accepts every supported mark", () => {
    const doc = paragraphWith([
      { type: "text", text: "b", marks: [{ type: "bold" }] },
      { type: "text", text: "i", marks: [{ type: "italic" }] },
      { type: "text", text: "u", marks: [{ type: "underline" }] },
      { type: "text", text: "s", marks: [{ type: "strike" }] },
      { type: "text", text: "l", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
      {
        type: "text",
        text: "t",
        marks: [
          {
            type: "textStyle",
            attrs: { fontFamily: "Georgia, 'Times New Roman', serif", color: "#c0392b", fontSize: "18px" },
          },
        ],
      },
      { type: "text", text: "h", marks: [{ type: "highlight", attrs: { color: "#fff3a3" } }] },
    ]);
    expect(textDocSchema.safeParse(doc).success).toBe(true);
  });

  it("accepts a textStyle mark carrying a single attribute", () => {
    for (const attrs of [
      { fontFamily: "Helvetica, Arial, sans-serif" },
      { color: "#1a1a2e" },
      { fontSize: "12px" },
    ]) {
      const doc = paragraphWith([{ type: "text", text: "x", marks: [{ type: "textStyle", attrs }] }]);
      expect(textDocSchema.safeParse(doc).success).toBe(true);
    }
  });

  it("accepts stacked marks on one text run", () => {
    const doc = paragraphWith([
      {
        type: "text",
        text: "bold link",
        marks: [{ type: "bold" }, { type: "link", attrs: { href: "*|UNSUB|*" } }],
      },
    ]);
    expect(textDocSchema.safeParse(doc).success).toBe(true);
  });

  it("accepts hard breaks between text runs", () => {
    const doc = paragraphWith([
      { type: "text", text: "line one" },
      { type: "hardBreak" },
      { type: "text", text: "line two" },
    ]);
    expect(textDocSchema.safeParse(doc).success).toBe(true);
  });
});

describe("textDocSchema — email-safety rejections", () => {
  it("rejects unknown mark types (code)", () => {
    const doc = paragraphWith([{ type: "text", text: "x", marks: [{ type: "code" }] }]);
    expect(textDocSchema.safeParse(doc).success).toBe(false);
  });

  it("rejects the Nuni fontSize mark (not in our subset — size lives on textStyle)", () => {
    const doc = paragraphWith([
      { type: "text", text: "x", marks: [{ type: "fontSize", attrs: { size: "12px" } }] },
    ]);
    expect(textDocSchema.safeParse(doc).success).toBe(false);
  });

  it("rejects a textStyle mark with no attrs, empty attrs, or empty-string attrs", () => {
    expect(textMarkSchema.safeParse({ type: "textStyle" }).success).toBe(false);
    expect(textMarkSchema.safeParse({ type: "textStyle", attrs: {} }).success).toBe(false);
    expect(
      textMarkSchema.safeParse({ type: "textStyle", attrs: { fontFamily: "" } }).success,
    ).toBe(false);
    expect(textMarkSchema.safeParse({ type: "textStyle", attrs: { color: "" } }).success).toBe(
      false,
    );
  });

  it("rejects unknown attrs on a textStyle mark (lineHeight, backgroundColor)", () => {
    expect(
      textMarkSchema.safeParse({ type: "textStyle", attrs: { lineHeight: "1.5" } }).success,
    ).toBe(false);
    expect(
      textMarkSchema.safeParse({ type: "textStyle", attrs: { backgroundColor: "#fff" } }).success,
    ).toBe(false);
  });

  it("rejects non-pixel textStyle font sizes (em, %, bare numbers)", () => {
    for (const fontSize of ["1.2em", "120%", "18", "large"]) {
      expect(textMarkSchema.safeParse({ type: "textStyle", attrs: { fontSize } }).success).toBe(
        false,
      );
    }
  });

  it("rejects a highlight mark without a color", () => {
    expect(textMarkSchema.safeParse({ type: "highlight" }).success).toBe(false);
    expect(textMarkSchema.safeParse({ type: "highlight", attrs: {} }).success).toBe(false);
    expect(textMarkSchema.safeParse({ type: "highlight", attrs: { color: "" } }).success).toBe(
      false,
    );
  });

  it("rejects extra attributes on a highlight mark", () => {
    expect(
      textMarkSchema.safeParse({ type: "highlight", attrs: { color: "#fff3a3", opacity: 0.5 } })
        .success,
    ).toBe(false);
  });

  it("rejects a link mark without attrs.href", () => {
    expect(textMarkSchema.safeParse({ type: "link" }).success).toBe(false);
    expect(textMarkSchema.safeParse({ type: "link", attrs: {} }).success).toBe(false);
    expect(textMarkSchema.safeParse({ type: "link", attrs: { href: "" } }).success).toBe(false);
  });

  it("rejects extra attributes on a link mark (title)", () => {
    const mark = { type: "link", attrs: { href: "https://example.com", title: "hi" } };
    expect(textMarkSchema.safeParse(mark).success).toBe(false);
  });

  it("rejects attrs on attribute-less marks (bold)", () => {
    expect(textMarkSchema.safeParse({ type: "bold", attrs: {} }).success).toBe(false);
  });

  it("rejects unknown block node types (blockquote)", () => {
    const doc = {
      type: "doc",
      content: [{ type: "blockquote", content: [{ type: "text", text: "x" }] }],
    };
    expect(textDocSchema.safeParse(doc).success).toBe(false);
  });

  it("rejects heading levels outside 1–3", () => {
    const docFor = (level: number) => ({
      type: "doc",
      content: [{ type: "heading", attrs: { level }, content: [{ type: "text", text: "x" }] }],
    });
    expect(textDocSchema.safeParse(docFor(4)).success).toBe(false);
    expect(textDocSchema.safeParse(docFor(0)).success).toBe(false);
  });

  it("rejects a heading with no attrs", () => {
    const doc = { type: "doc", content: [{ type: "heading", content: [] }] };
    expect(textDocSchema.safeParse(doc).success).toBe(false);
  });

  it("rejects an empty doc (no block nodes)", () => {
    expect(textDocSchema.safeParse({ type: "doc", content: [] }).success).toBe(false);
  });

  it("rejects empty text runs", () => {
    expect(textDocSchema.safeParse(paragraphWith([{ type: "text", text: "" }])).success).toBe(false);
  });

  it("rejects unknown keys on text nodes (Nuni's key/isDefaultContent)", () => {
    const doc = paragraphWith([
      { type: "text", text: "x", key: "placeholder_content_abc", isDefaultContent: true },
    ]);
    expect(textDocSchema.safeParse(doc).success).toBe(false);
  });

  it("rejects unknown attrs on paragraphs (Nuni's preventHardLineBreaks)", () => {
    const doc = {
      type: "doc",
      content: [{ type: "paragraph", attrs: { preventHardLineBreaks: true }, content: [] }],
    };
    expect(textDocSchema.safeParse(doc).success).toBe(false);
  });

  it("rejects textAlign values outside the SDK vocabulary (justify, null)", () => {
    const justified = {
      type: "doc",
      content: [{ type: "paragraph", attrs: { textAlign: "justify" } }],
    };
    expect(textDocSchema.safeParse(justified).success).toBe(false);
    /*
      Tiptap's "unaligned" spelling is attr null — normalize strips it to a
      missing attr before validation; the schema itself never accepts null.
    */
    const nullAligned = {
      type: "doc",
      content: [{ type: "paragraph", attrs: { textAlign: null } }],
    };
    expect(textDocSchema.safeParse(nullAligned).success).toBe(false);
  });

  it("rejects an empty paragraph attrs object (attrs require textAlign)", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", attrs: {} }] };
    expect(textDocSchema.safeParse(doc).success).toBe(false);
  });

  it("rejects a heading nested inside a paragraph", () => {
    const doc = paragraphWith([{ type: "heading", attrs: { level: 1 }, content: [] }]);
    expect(textDocSchema.safeParse(doc).success).toBe(false);
  });

  it("rejects a wrapper that is not a doc", () => {
    expect(
      textDocSchema.safeParse({ type: "document", content: [{ type: "paragraph" }] }).success,
    ).toBe(false);
  });
});
