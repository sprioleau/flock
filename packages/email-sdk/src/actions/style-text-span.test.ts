import { describe, expect, it } from "vitest";
import { applyOperation } from "../operations/apply";
import { createTextDoc, textDocSchema, type TextDoc, type TextNode } from "../schema/text";
import { createSampleDocument } from "../store/document";
import type { ActionContext } from "./context";
import { dispatchContentAction } from "./registry";
import { emailActionRegistry } from "./builtins";
import {
  applySpanStyle,
  resolveStyleTextSpanOperation,
  styleTextSpanAction,
  styleTextSpanInputSchema,
} from "./style-text-span";

const agentContext: ActionContext = {
  caller: "tool",
  authorId: "agent_thread_1",
  author: "agent",
  batchId: "batch_1",
  threadId: "thread_1",
};

/** One paragraph, one unmarked run. */
function paragraphDoc(text: string): TextDoc {
  return createTextDoc(text);
}

/** The rich-text doc of a sample-document text block (type-narrowed). */
function sampleTextDocOf(blockId: string): TextDoc {
  const block = createSampleDocument()[blockId as keyof ReturnType<typeof createSampleDocument>]!;
  if (block.type !== "text") throw new Error(`fixture: ${blockId} is not a text block`);
  return block.properties.text;
}

function textNodesOf(doc: TextDoc, nodeIndex = 0): TextNode[] {
  return (doc.content[nodeIndex]!.content ?? []).filter(
    (inline): inline is TextNode => inline.type === "text",
  );
}

describe("applySpanStyle — find & occurrence resolution", () => {
  it("styles the first occurrence by default", () => {
    const result = applySpanStyle({
      text: paragraphDoc("one fish two fish"),
      find: "fish",
      style: { bold: true },
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.matchCount).toBe(2);
    expect(textNodesOf(result.text)).toEqual([
      { type: "text", text: "one " },
      { type: "text", text: "fish", marks: [{ type: "bold" }] },
      { type: "text", text: " two fish" },
    ]);
  });

  it("styles the nth occurrence when asked", () => {
    const result = applySpanStyle({
      text: paragraphDoc("one fish two fish"),
      find: "fish",
      occurrence: 2,
      style: { italic: true },
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(textNodesOf(result.text)).toEqual([
      { type: "text", text: "one fish two " },
      { type: "text", text: "fish", marks: [{ type: "italic" }] },
    ]);
  });

  it('styles every occurrence with "all", across block nodes', () => {
    const doc: TextDoc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Big sale" }] },
        { type: "paragraph", content: [{ type: "text", text: "The sale ends when the sale ends." }] },
      ],
    };
    const result = applySpanStyle({ text: doc, find: "sale", occurrence: "all", style: { bold: true } });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.matchCount).toBe(3);
    expect(textNodesOf(result.text, 0)).toEqual([
      { type: "text", text: "Big " },
      { type: "text", text: "sale", marks: [{ type: "bold" }] },
    ]);
    expect(textNodesOf(result.text, 1)).toEqual([
      { type: "text", text: "The " },
      { type: "text", text: "sale", marks: [{ type: "bold" }] },
      { type: "text", text: " ends when the " },
      { type: "text", text: "sale", marks: [{ type: "bold" }] },
      { type: "text", text: " ends." },
    ]);
  });

  it("reports span_not_found with a zero match count", () => {
    const result = applySpanStyle({
      text: paragraphDoc("nothing to see"),
      find: "missing phrase",
      style: { bold: true },
    });
    expect(result).toEqual({ isOk: false, reason: "span_not_found", matchCount: 0 });
  });

  it("reports occurrence_out_of_range with the real match count", () => {
    const result = applySpanStyle({
      text: paragraphDoc("one fish two fish"),
      find: "fish",
      occurrence: 3,
      style: { bold: true },
    });
    expect(result).toEqual({ isOk: false, reason: "occurrence_out_of_range", matchCount: 2 });
  });

  it("matches across text-node boundaries within one paragraph", () => {
    const doc: TextDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "You describe, " },
            { type: "text", text: "your partner builds", marks: [{ type: "bold" }] },
            { type: "text", text: " together." },
          ],
        },
      ],
    };
    const result = applySpanStyle({ text: doc, find: "partner builds together", style: { underline: true } });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(textNodesOf(result.text)).toEqual([
      { type: "text", text: "You describe, " },
      { type: "text", text: "your ", marks: [{ type: "bold" }] },
      { type: "text", text: "partner builds", marks: [{ type: "bold" }, { type: "underline" }] },
      { type: "text", text: " together", marks: [{ type: "underline" }] },
      { type: "text", text: "." },
    ]);
  });

  it("treats whitespace runs (including hard breaks) flexibly", () => {
    const doc: TextDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Ready to ride?" },
            { type: "hardBreak" },
            { type: "text", text: "Grab a seat." },
          ],
        },
      ],
    };
    // The outline shows the hard break as a plain space; both spellings work.
    const result = applySpanStyle({ text: doc, find: "ride? Grab", style: { bold: true } });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const content = result.text.content[0]!.content!;
    expect(content).toEqual([
      { type: "text", text: "Ready to " },
      { type: "text", text: "ride?", marks: [{ type: "bold" }] },
      { type: "hardBreak" },
      { type: "text", text: "Grab", marks: [{ type: "bold" }] },
      { type: "text", text: " a seat." },
    ]);
  });

  it("never matches across paragraph/heading boundaries", () => {
    const doc: TextDoc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "ends here" }] },
        { type: "paragraph", content: [{ type: "text", text: "starts there" }] },
      ],
    };
    const result = applySpanStyle({ text: doc, find: "here starts", style: { bold: true } });
    expect(result.isOk).toBe(false);
  });

  it("escapes regex specials in find", () => {
    const result = applySpanStyle({
      text: paragraphDoc("Save 50% (today only)!"),
      find: "50% (today only)!",
      style: { bold: true },
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(textNodesOf(result.text)[1]).toEqual({
      type: "text",
      text: "50% (today only)!",
      marks: [{ type: "bold" }],
    });
  });
});

describe("applySpanStyle — mark application", () => {
  it("sets value marks: textStyle attrs, highlight, and link", () => {
    const result = applySpanStyle({
      text: paragraphDoc("Read the docs now"),
      find: "docs",
      style: {
        fontFamily: "Georgia, serif",
        textColor: "#16a34a",
        fontSizePx: 18,
        highlightColor: "#fff3a3",
        linkHref: "https://example.com/docs",
      },
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(textNodesOf(result.text)[1]).toEqual({
      type: "text",
      text: "docs",
      marks: [
        { type: "link", attrs: { href: "https://example.com/docs" } },
        {
          type: "textStyle",
          attrs: { fontFamily: "Georgia, serif", color: "#16a34a", fontSize: "18px" },
        },
        { type: "highlight", attrs: { color: "#fff3a3" } },
      ],
    });
  });

  it("false removes boolean marks; true is idempotent on already-marked text", () => {
    const doc: TextDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "loud and bold", marks: [{ type: "bold" }, { type: "italic" }] }],
        },
      ],
    };
    const removed = applySpanStyle({ text: doc, find: "loud and bold", style: { bold: false } });
    expect(removed.isOk).toBe(true);
    if (!removed.isOk) return;
    expect(textNodesOf(removed.text)).toEqual([
      { type: "text", text: "loud and bold", marks: [{ type: "italic" }] },
    ]);

    const rebolded = applySpanStyle({ text: doc, find: "loud and bold", style: { bold: true } });
    expect(rebolded.isOk).toBe(true);
    if (!rebolded.isOk) return;
    expect(textNodesOf(rebolded.text)).toEqual([
      { type: "text", text: "loud and bold", marks: [{ type: "bold" }, { type: "italic" }] },
    ]);
  });

  it("null removes value marks — a fully-cleared textStyle mark disappears", () => {
    const doc: TextDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "tinted words",
              marks: [{ type: "textStyle", attrs: { color: "#c0392b", fontSize: "20px" } }],
            },
          ],
        },
      ],
    };
    const partiallyCleared = applySpanStyle({ text: doc, find: "tinted words", style: { textColor: null } });
    expect(partiallyCleared.isOk).toBe(true);
    if (!partiallyCleared.isOk) return;
    expect(textNodesOf(partiallyCleared.text)).toEqual([
      { type: "text", text: "tinted words", marks: [{ type: "textStyle", attrs: { fontSize: "20px" } }] },
    ]);

    const fullyCleared = applySpanStyle({
      text: doc,
      find: "tinted words",
      style: { textColor: null, fontSizePx: null },
    });
    expect(fullyCleared.isOk).toBe(true);
    if (!fullyCleared.isOk) return;
    expect(textNodesOf(fullyCleared.text)).toEqual([{ type: "text", text: "tinted words" }]);
  });

  it("null removes highlight and link marks", () => {
    const doc: TextDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "linked",
              marks: [
                { type: "link", attrs: { href: "https://example.com" } },
                { type: "highlight", attrs: { color: "#ff0" } },
              ],
            },
          ],
        },
      ],
    };
    const result = applySpanStyle({ text: doc, find: "linked", style: { linkHref: null, highlightColor: null } });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(textNodesOf(result.text)).toEqual([{ type: "text", text: "linked" }]);
  });

  it("merges the styled span back into neighbours when marks end up identical", () => {
    const doc: TextDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "all " },
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
            { type: "text", text: " here" },
          ],
        },
      ],
    };
    // Removing bold from the middle run makes all three runs identical → one run.
    const result = applySpanStyle({ text: doc, find: "bold", style: { bold: false } });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(textNodesOf(result.text)).toEqual([{ type: "text", text: "all bold here" }]);
  });

  it("leaves untouched runs and other paragraphs byte-identical (structural sharing)", () => {
    const doc = createSampleDocument().txt_e5f6!;
    if (doc.type !== "text") throw new Error("fixture");
    const result = applySpanStyle({
      text: doc.properties.text,
      find: "Welcome to Tandem",
      style: { textColor: "#16a34a" },
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // The paragraph node (index 1) was not part of the match — same reference.
    expect(result.text.content[1]).toBe(doc.properties.text.content[1]);
  });

  it("every output validates against the strict textDocSchema", () => {
    const cases = [
      applySpanStyle({ text: paragraphDoc("one fish two fish"), find: "fish", occurrence: "all", style: { bold: true, italic: false } }),
      applySpanStyle({ text: paragraphDoc("plain"), find: "plain", style: { fontSizePx: 12 } }),
      applySpanStyle({
        text: sampleTextDocOf("txt_r7s8"),
        find: "Ready to ride?",
        style: { italic: false, highlightColor: "#fff3a3" },
      }),
    ];
    for (const result of cases) {
      expect(result.isOk).toBe(true);
      if (!result.isOk) continue;
      expect(textDocSchema.safeParse(result.text).success).toBe(true);
    }
  });
});

describe("resolveStyleTextSpanOperation", () => {
  const doc = createSampleDocument();

  function parseInput(input: unknown) {
    return styleTextSpanInputSchema.parse(input);
  }

  it("resolves to one canonical updateText operation", () => {
    const resolved = resolveStyleTextSpanOperation({
      doc,
      input: parseInput({
        name: "styleTextSpan",
        blockId: "txt_e5f6",
        find: "your partner builds",
        style: { textColor: "#16a34a", fontSizePx: 18 },
      }),
    });
    expect(resolved.isOk).toBe(true);
    if (!resolved.isOk) return;
    expect(resolved.op.name).toBe("updateText");
    expect(resolved.op.blockId).toBe("txt_e5f6");
    const applied = applyOperation(doc, resolved.op);
    expect(applied.isOk).toBe(true);
  });

  it("names the block's ACTUAL text in the span_not_found repair hint", () => {
    const resolved = resolveStyleTextSpanOperation({
      doc,
      input: parseInput({
        name: "styleTextSpan",
        blockId: "txt_r7s8",
        find: "text that is not there",
        style: { bold: true },
      }),
    });
    expect(resolved.isOk).toBe(false);
    if (resolved.isOk) return;
    expect(resolved.errors[0]!.code).toBe("span_not_found");
    expect(resolved.errors[0]!.message).toContain('"Ready to ride? Grab a seat on the right."');
    expect(resolved.errors[0]!.blockId).toBe("txt_r7s8");
  });

  it("reports the real match count for an out-of-range occurrence", () => {
    const resolved = resolveStyleTextSpanOperation({
      doc,
      input: parseInput({
        name: "styleTextSpan",
        blockId: "txt_e5f6",
        find: "Tandem",
        occurrence: 4,
        style: { bold: true },
      }),
    });
    expect(resolved.isOk).toBe(false);
    if (resolved.isOk) return;
    expect(resolved.errors[0]!.code).toBe("span_not_found");
    expect(resolved.errors[0]!.message).toContain("Only 1 occurrence(s)");
    expect(resolved.errors[0]!.message).toContain("occurrence 4 is out of range");
  });

  it("rejects a missing block and a non-text block with taxonomy codes", () => {
    const missing = resolveStyleTextSpanOperation({
      doc,
      input: parseInput({ name: "styleTextSpan", blockId: "txt_none", find: "x", style: { bold: true } }),
    });
    expect(missing.isOk).toBe(false);
    if (missing.isOk) return;
    expect(missing.errors[0]!.code).toBe("target_not_found");
    // A well-formed text id pointing at a non-text row cannot be built through
    // the schema (prefix implies type), so wrong_block_type is exercised at
    // the applySpanStyle wrapper level via a hand-built doc:
    const forged = { ...doc, txt_fake: { ...doc.img_g7h8!, id: "txt_fake" } };
    const wrongType = resolveStyleTextSpanOperation({
      doc: forged as typeof doc,
      input: parseInput({ name: "styleTextSpan", blockId: "txt_fake", find: "x", style: { bold: true } }),
    });
    expect(wrongType.isOk).toBe(false);
    if (wrongType.isOk) return;
    expect(wrongType.errors[0]!.code).toBe("wrong_block_type");
  });
});

describe("styleTextSpanAction through dispatchContentAction", () => {
  const doc = createSampleDocument();

  it("is a parallel-safe, unapproved content action registered in the builtin registry", () => {
    expect(styleTextSpanAction.kind).toBe("content");
    expect(styleTextSpanAction.parallelSafe).toBe(true);
    expect(styleTextSpanAction.needsApproval).toBe(false);
    expect(emailActionRegistry.actionsByName.get("styleTextSpan")).toBe(styleTextSpanAction);
  });

  it("dispatches: log entry records the RESOLVED updateText op; inverse restores the doc", () => {
    const result = dispatchContentAction({
      registry: emailActionRegistry,
      doc,
      name: "styleTextSpan",
      input: {
        name: "styleTextSpan",
        blockId: "txt_e5f6",
        find: "your partner builds",
        style: { bold: false, textColor: "#16a34a" },
      },
      context: agentContext,
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.logEntry.op.name).toBe("updateText");
    expect(result.logEntry.batchId).toBe("batch_1");
    expect(result.logEntry.author).toBe("agent");
    const block = result.doc.txt_e5f6!;
    if (block.type !== "text") throw new Error("fixture");
    expect(textNodesOf(block.properties.text, 1)).toContainEqual({
      type: "text",
      text: "your partner builds",
      marks: [{ type: "textStyle", attrs: { color: "#16a34a" } }],
    });
    const undone = applyOperation(result.doc, result.inverse);
    expect(undone.isOk).toBe(true);
    if (!undone.isOk) return;
    expect(undone.doc).toEqual(doc);
  });

  it("surfaces span_not_found as a retryable dispatch failure", () => {
    const result = dispatchContentAction({
      registry: emailActionRegistry,
      doc,
      name: "styleTextSpan",
      input: { name: "styleTextSpan", blockId: "txt_e5f6", find: "no such words", style: { bold: true } },
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("retryable");
    expect(result.errors[0]!.code).toBe("span_not_found");
    expect(result.errors[0]!.message).toContain("Welcome to Tandem");
  });

  it("rejects an empty style object and unknown style keys at the schema gate", () => {
    expect(
      styleTextSpanInputSchema.safeParse({
        name: "styleTextSpan",
        blockId: "txt_e5f6",
        find: "Tandem",
        style: {},
      }).success,
    ).toBe(false);
    expect(
      styleTextSpanInputSchema.safeParse({
        name: "styleTextSpan",
        blockId: "txt_e5f6",
        find: "Tandem",
        style: { color: "#fff" },
      }).success,
    ).toBe(false);
  });
});
