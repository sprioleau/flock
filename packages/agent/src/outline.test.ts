import { createEmptyDocument, createSampleDocument } from "@tandem/email-sdk";
import { describe, expect, it } from "vitest";
import { generateDocumentOutline } from "./outline";

const sampleDoc = createSampleDocument();

describe("generateDocumentOutline (default depth: blocks)", () => {
  const outline = generateDocumentOutline({ doc: sampleDoc });

  it("matches the snapshot", () => {
    expect(outline).toMatchInlineSnapshot(`
      "globals: buttonBackgroundColor=#1a1a2e, heading1TextAlign=center
      sec_a1b2 section
        txt_e5f6 text h1,p "Welcome to Tandem | You describe, your partner builds — read…" +bold
        img_g7h8 image alt="Two riders on a tandem bicycle" w=520 src=placehold.co
        div_i9j0 divider
      sec_c3d4 section
        row_k1l2 row (2 col)
          col_m3n4 column 60%
            txt_r7s8 text p "Ready to ride? Grab a seat on the right."
          col_p5q6 column 40%
            btn_t9u0 button "Get started" href=https://example.com/start"
    `);
  });

  it("is deterministic — two calls produce byte-identical output", () => {
    expect(generateDocumentOutline({ doc: sampleDoc })).toBe(outline);
  });

  it("lists only NON-default globals", () => {
    // Set in the sample doc but equal to renderer defaults — must be omitted.
    expect(outline).not.toContain("emailBackgroundColor");
    expect(outline).not.toContain("contentBackgroundColor");
    expect(outline).not.toContain("contentWidth");
    // Genuinely non-default — must be present.
    expect(outline).toContain("buttonBackgroundColor=#1a1a2e");
    expect(outline).toContain("heading1TextAlign=center");
  });

  it("shows image src as host only, never the full URL", () => {
    expect(outline).toContain("src=placehold.co");
    expect(outline).not.toContain("https://placehold.co");
    expect(outline).not.toContain("placehold.co/600x400");
  });

  it("walks in reading order (childrenIds order)", () => {
    const ids = [
      "sec_a1b2",
      "txt_e5f6",
      "img_g7h8",
      "div_i9j0",
      "sec_c3d4",
      "row_k1l2",
      "col_m3n4",
      "txt_r7s8",
      "col_p5q6",
      "btn_t9u0",
    ];
    const positions = ids.map((id) => outline.indexOf(id));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("notes heading levels and bold marks on text blocks", () => {
    expect(outline).toMatch(/txt_e5f6 text h1,p ".*" \+bold/);
    // txt_r7s8 has italic but no bold — no +bold flag.
    expect(outline).toMatch(/txt_r7s8 text p "[^"]*"\n/);
    expect(outline).not.toMatch(/txt_r7s8[^\n]*\+bold/);
  });

  it("stays terse — a few hundred tokens on the sample doc", () => {
    // ~4 chars/token heuristic: keep the whole outline well under ~300 tokens.
    expect(outline.length).toBeLessThan(1200);
    expect(outline.split("\n").length).toBe(11); // globals + 10 blocks
  });
});

describe("maxTextChars option", () => {
  it("caps extracted text per text block", () => {
    const outline = generateDocumentOutline({ doc: sampleDoc, options: { maxTextChars: 10 } });
    const quoted = [...outline.matchAll(/"([^"]*)"/g)]
      .map((match) => match[1]!)
      // alt text is not governed by maxTextChars
      .filter((text) => !text.startsWith("Two riders"));
    expect(quoted.length).toBeGreaterThan(0);
    for (const text of quoted) {
      // 10 chars + the single ellipsis character when truncated.
      expect(text.length).toBeLessThanOrEqual(11);
    }
    expect(outline).toContain('"Welcome to…"');
  });

  it("does not append an ellipsis when the text fits", () => {
    const outline = generateDocumentOutline({ doc: sampleDoc, options: { maxTextChars: 500 } });
    expect(outline).toContain('"Welcome to Tandem | You describe,');
    expect(outline).not.toMatch(/txt_e5f6[^\n]*…/);
  });
});

describe("depth option", () => {
  it('"sections" lists only sections with child counts', () => {
    const outline = generateDocumentOutline({ doc: sampleDoc, options: { depth: "sections" } });
    expect(outline).toMatchInlineSnapshot(`
      "globals: buttonBackgroundColor=#1a1a2e, heading1TextAlign=center
      sec_a1b2 section (3 children)
      sec_c3d4 section (1 children)"
    `);
    expect(outline).not.toContain("txt_");
    expect(outline).not.toContain("btn_");
    expect(outline).not.toContain("row_");
  });

  it('"full" adds the remaining explicitly-set props as key=value', () => {
    const outline = generateDocumentOutline({ doc: sampleDoc, options: { depth: "full" } });
    expect(outline).toContain("txt_e5f6 text");
    expect(outline).toContain("[paddingBottom=12 paddingTop=24]"); // sorted keys
    expect(outline).toContain("sec_c3d4 section [innerBackgroundColor=#fafafa]");
    expect(outline).toContain("col_m3n4 column 60% [verticalAlign=middle]");
    expect(outline).toContain("btn_t9u0 button \"Get started\" href=https://example.com/start [align=center]");
    // Still never the full image URL, even at full depth.
    expect(outline).not.toContain("https://placehold.co");
  });

  it('"blocks" (default) omits the full-depth extras', () => {
    const outline = generateDocumentOutline({ doc: sampleDoc });
    expect(outline).not.toContain("paddingTop");
    expect(outline).not.toContain("verticalAlign");
  });
});

describe("edge cases", () => {
  it("handles an empty document", () => {
    expect(generateDocumentOutline({ doc: createEmptyDocument() })).toBe(
      "globals: (all defaults)\n(no sections)",
    );
  });

  it("marks dangling child references instead of throwing", () => {
    const doc = createSampleDocument();
    const section = structuredClone(doc.sec_a1b2!);
    section.childrenIds = [...section.childrenIds, "txt_gone"];
    const outline = generateDocumentOutline({ doc: { ...doc, sec_a1b2: section } });
    expect(outline).toContain("txt_gone (missing)");
  });
});
