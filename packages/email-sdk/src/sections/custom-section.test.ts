import { describe, expect, it } from "vitest";
import {
  buildCustomSection,
  customSectionSchema,
} from "./custom-section";

function createSeededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe("custom section contract", () => {
  it("accepts a bounded two-column content shape and builds the same safe block tree as catalog sections", () => {
    const parsed = customSectionSchema.safeParse({
      columns: [
        {
          widthPercent: 40,
          leaves: [{ kind: "text", role: "heading", text: "The finding" }],
        },
        {
          widthPercent: 60,
          leaves: [
            { kind: "text", role: "paragraph", text: "The source explains the finding." },
            { kind: "button", label: "Read the source", href: "https://example.com/source" },
          ],
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("custom section should parse");
    const built = buildCustomSection({ section: parsed.data, random: createSeededRandom(4) });
    expect(built.section.childrenIds).toHaveLength(1);
    expect(built.children.map((block) => block.type)).toEqual([
      "row",
      "column",
      "column",
      "text",
      "text",
      "button",
    ]);
    expect(JSON.stringify(built)).not.toContain("color");
    expect(JSON.stringify(built)).not.toContain("style");
  });

  it("supports a single-column custom section without manufacturing a row", () => {
    const parsed = customSectionSchema.parse({
      columns: [{ leaves: [{ kind: "text", role: "paragraph", text: "Only source copy." }] }],
    });
    const built = buildCustomSection({ section: parsed, random: createSeededRandom(5) });
    expect(built.section.childrenIds).toHaveLength(1);
    expect(built.children.map((block) => block.type)).toEqual(["text"]);
  });

  it("rejects raw HTML, arbitrary styling, unsafe links, mixed widths, and oversized layouts", () => {
    expect(
      customSectionSchema.safeParse({
        columns: [{ leaves: [{ kind: "text", role: "paragraph", text: "<script>alert(1)</script>" }] }],
      }).success,
    ).toBe(false);
    expect(
      customSectionSchema.safeParse({
        columns: [{ leaves: [{ kind: "html", html: "<div>unsafe</div>" }] }],
      }).success,
    ).toBe(false);
    expect(
      customSectionSchema.safeParse({
        columns: [{ leaves: [{ kind: "text", role: "paragraph", text: "copy", style: {} }] }],
      }).success,
    ).toBe(false);
    expect(
      customSectionSchema.safeParse({
        columns: [{ leaves: [{ kind: "button", label: "Go", href: "http://example.com" }] }],
      }).success,
    ).toBe(false);
    expect(
      customSectionSchema.safeParse({
        columns: [
          { widthPercent: 50, leaves: [{ kind: "text", role: "paragraph", text: "one" }] },
          { leaves: [{ kind: "text", role: "paragraph", text: "two" }] },
        ],
      }).success,
    ).toBe(false);
    expect(
      customSectionSchema.safeParse({
        columns: Array.from({ length: 3 }, () => ({
          leaves: Array.from({ length: 8 }, (_, index) => ({
            kind: "text",
            role: "paragraph",
            text: `copy ${index}`,
          })),
        })),
      }).success,
    ).toBe(false);
  });
});
