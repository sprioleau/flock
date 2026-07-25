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

  it("accepts every supported mark", () => {
    const doc = paragraphWith([
      { type: "text", text: "b", marks: [{ type: "bold" }] },
      { type: "text", text: "i", marks: [{ type: "italic" }] },
      { type: "text", text: "u", marks: [{ type: "underline" }] },
      { type: "text", text: "s", marks: [{ type: "strike" }] },
      { type: "text", text: "l", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
    ]);
    expect(textDocSchema.safeParse(doc).success).toBe(true);
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
  it("rejects unknown mark types (highlight)", () => {
    const doc = paragraphWith([{ type: "text", text: "x", marks: [{ type: "highlight" }] }]);
    expect(textDocSchema.safeParse(doc).success).toBe(false);
  });

  it("rejects the Nuni fontSize mark (not in our subset)", () => {
    const doc = paragraphWith([
      { type: "text", text: "x", marks: [{ type: "fontSize", attrs: { size: "12px" } }] },
    ]);
    expect(textDocSchema.safeParse(doc).success).toBe(false);
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
