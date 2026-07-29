import { describe, expect, it } from "vitest";
import { render } from "react-email";
import type { TextBlock } from "../../schema/blocks";
import type { TextDoc } from "../../schema/text";
import { resolveBlockStyles } from "../styles";
import { TextBlockView } from "./TextBlockView";

function textBlockWithDoc(doc: TextDoc): TextBlock {
  return {
    id: "txt_a1b2",
    type: "text",
    parentId: "sec_a1b2",
    childrenIds: [],
    properties: { text: doc },
  };
}

async function renderDoc(doc: TextDoc, globals?: Parameters<typeof resolveBlockStyles>[0]) {
  const block = textBlockWithDoc(doc);
  return render(
    <TextBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />,
  );
}

describe("TextBlockView", () => {
  it("renders heading nodes as h1/h2/h3 with level-scoped global styles", async () => {
    const html = await renderDoc(
      {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "One" }] },
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Two" }] },
          { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Three" }] },
        ],
      },
      { heading2TextColor: "#22aa22" },
    );
    expect(html).toContain("<h1");
    expect(html).toContain("<h2");
    expect(html).toContain("<h3");
    expect(html).toMatch(/<h2[^>]*color:#22aa22/);
  });

  it("renders paragraph nodes as <p> via React Email Text", async () => {
    const html = await renderDoc({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
    });
    expect(html).toMatch(/<p[^>]*>Hello<\/p>/);
  });

  it("maps bold → <strong> and italic → <em>", async () => {
    const html = await renderDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "B", marks: [{ type: "bold" }] },
            { type: "text", text: "I", marks: [{ type: "italic" }] },
          ],
        },
      ],
    });
    expect(html).toContain("<strong>B</strong>");
    expect(html).toContain("<em>I</em>");
  });

  it("maps underline and strike to text-decoration spans", async () => {
    const html = await renderDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "U", marks: [{ type: "underline" }] },
            { type: "text", text: "S", marks: [{ type: "strike" }] },
          ],
        },
      ],
    });
    expect(html).toMatch(/<span[^>]*text-decoration:underline[^>]*>U<\/span>/);
    expect(html).toMatch(/<span[^>]*text-decoration:line-through[^>]*>S<\/span>/);
  });

  it("maps link marks to <a> colored by globals.linkTextColor", async () => {
    const html = await renderDoc(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "docs",
                marks: [{ type: "link", attrs: { href: "https://example.com/docs" } }],
              },
            ],
          },
        ],
      },
      { linkTextColor: "#ff6600" },
    );
    expect(html).toMatch(/<a[^>]*href="https:\/\/example\.com\/docs"/);
    expect(html).toMatch(/<a[^>]*color:#ff6600/);
  });

  it("nests stacked marks (bold + italic + link) around one run", async () => {
    const html = await renderDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "all",
              marks: [
                { type: "bold" },
                { type: "italic" },
                { type: "link", attrs: { href: "https://example.com" } },
              ],
            },
          ],
        },
      ],
    });
    expect(html).toMatch(/<a[^>]*><em><strong>all<\/strong><\/em><\/a>/);
  });

  it("maps textStyle attrs to inline font-family / color / font-size on a span", async () => {
    const html = await renderDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "styled",
              marks: [
                {
                  type: "textStyle",
                  attrs: {
                    fontFamily: "Georgia, 'Times New Roman', serif",
                    color: "#c0392b",
                    fontSize: "18px",
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(html).toMatch(
      /<span[^>]*font-family:Georgia, &#x27;Times New Roman&#x27;, serif[^>]*>styled<\/span>/,
    );
    expect(html).toMatch(/<span[^>]*color:#c0392b[^>]*>styled<\/span>/);
    expect(html).toMatch(/<span[^>]*font-size:18px[^>]*>styled<\/span>/);
  });

  it("emits only the textStyle attrs that are present", async () => {
    const html = await renderDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "red", marks: [{ type: "textStyle", attrs: { color: "#ff0000" } }] },
          ],
        },
      ],
    });
    expect(html).toMatch(/<span style="color:#ff0000">red<\/span>/);
    expect(html).not.toContain("font-family:undefined");
    expect(html).not.toContain("font-size:undefined");
  });

  it("maps highlight to an inline background-color span", async () => {
    const html = await renderDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "hi", marks: [{ type: "highlight", attrs: { color: "#fff3a3" } }] },
          ],
        },
      ],
    });
    expect(html).toMatch(/<span[^>]*background-color:#fff3a3[^>]*>hi<\/span>/);
  });

  it("nests textStyle and highlight with the classic marks", async () => {
    const html = await renderDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "all",
              marks: [
                { type: "bold" },
                { type: "textStyle", attrs: { color: "#0044cc" } },
                { type: "highlight", attrs: { color: "#fff3a3" } },
              ],
            },
          ],
        },
      ],
    });
    expect(html).toMatch(
      /<span[^>]*background-color:#fff3a3[^>]*><span[^>]*color:#0044cc[^>]*><strong>all<\/strong><\/span><\/span>/,
    );
  });

  it("renders hardBreak as <br", async () => {
    const html = await renderDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "line one" },
            { type: "hardBreak" },
            { type: "text", text: "line two" },
          ],
        },
      ],
    });
    expect(html).toMatch(/line one<br\s*\/?>line two/);
  });
});
