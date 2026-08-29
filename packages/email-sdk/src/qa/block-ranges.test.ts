import { describe, expect, it } from "vitest";
import { renderToHTML } from "../render/render-to-html";
import { createStarterDocument } from "../store/document";
import { findBlockIdAt, indexBlockRanges, toIndexRange } from "./block-ranges";

/*
  THE ATTRIBUTION LAYER, tested on its own.

  Everything the pre-send check claims about WHICH BLOCK has a problem rests
  on this module, and it is the part that can be wrong while looking right:
  a scanner that mis-tracks one tag still returns block ids, just the wrong
  ones, and a finding pointing at an innocent block is worse than one pointing
  at nothing. So the tests below assert the identity of the block, never
  merely that some block came back.
*/

/* A stamped element's extent must be the element, exactly — start tag through
   end tag. Slicing the input with the returned range is the only assertion
   that can tell a correct extent from a plausible one. */
function sliceOf(html: string, range: { startIndex: number; endIndex: number }): string {
  return html.slice(range.startIndex, range.endIndex);
}

describe("indexBlockRanges", () => {
  it("returns each stamped element's exact extent, parents before children", () => {
    const html =
      '<div data-flock-block-id="sec_a"><p data-flock-block-id="txt_b">hi</p></div>';
    const ranges = indexBlockRanges(html);

    expect(ranges.map((range) => range.blockId)).toEqual(["sec_a", "txt_b"]);
    expect(sliceOf(html, ranges[0]!)).toBe(html);
    expect(sliceOf(html, ranges[1]!)).toBe('<p data-flock-block-id="txt_b">hi</p>');
  });

  it("ignores unstamped elements entirely", () => {
    const ranges = indexBlockRanges("<table><tr><td>plain</td></tr></table>");
    expect(ranges).toEqual([]);
  });

  /*
    React Email wraps layout in Outlook conditional comments, and it emits BOTH
    halves — `<!--[if mso]><table><tr><td><![endif]-->` and later
    `<!--[if mso]></td></tr></table><![endif]-->`. The closing half is the
    dangerous one: a scanner that reads into it meets `</div>`-shaped end tags
    that pop REAL elements, so the enclosing block's extent ends early and
    every attribution inside the remainder moves to the wrong block.

    The opening half alone does not discriminate — stray unclosed tags are
    absorbed by the tolerant pop in indexBlockRanges — which is why this
    fixture uses a closing tag. Found by mutation: the earlier version of this
    test passed with comment handling deleted.
  */
  it("does not scan into comments, so a conditional comment cannot close a real element", () => {
    const html =
      '<div data-flock-block-id="sec_a">' +
      "<!--[if mso]></div><![endif]-->" +
      '<p data-flock-block-id="txt_b">hi</p>' +
      "</div>";
    const ranges = indexBlockRanges(html);

    expect(ranges.map((range) => range.blockId)).toEqual(["sec_a", "txt_b"]);
    expect(sliceOf(html, ranges[0]!)).toBe(html);
    expect(sliceOf(html, ranges[1]!)).toBe('<p data-flock-block-id="txt_b">hi</p>');
  });

  /*
    The tolerant pop, which is the scanner's main line of defence: an end tag
    with no matching open element is IGNORED rather than unwinding whatever
    happens to be on top of the stack. Popping blindly would end the enclosing
    block here and hand every later finding to the wrong block.
  */
  it("ignores a stray end tag rather than closing a real ancestor with it", () => {
    const html = '<div data-flock-block-id="sec_a"><span>x</span></em></div>';
    const ranges = indexBlockRanges(html);

    expect(ranges.map((range) => range.blockId)).toEqual(["sec_a"]);
    expect(sliceOf(html, ranges[0]!)).toBe(html);
  });

  it("keeps sibling subtrees separate rather than nesting them", () => {
    const html =
      '<div data-flock-block-id="txt_a">one</div><div data-flock-block-id="txt_b">two</div>';
    const ranges = indexBlockRanges(html);

    expect(sliceOf(html, ranges[0]!)).toBe('<div data-flock-block-id="txt_a">one</div>');
    expect(sliceOf(html, ranges[1]!)).toBe('<div data-flock-block-id="txt_b">two</div>');
  });
});

describe("findBlockIdAt", () => {
  const html =
    '<body><div data-flock-block-id="sec_a">' +
    '<p data-flock-block-id="txt_b"><span style="color:red">hi</span></p>' +
    '<p data-flock-block-id="txt_c">bye</p>' +
    "</div></body>";
  const ranges = indexBlockRanges(html);

  /* The span belongs to txt_b and is nested inside sec_a. Naming the ancestor
     would be defensible-looking and wrong: it is the paragraph a user would
     edit, not the section. */
  it("names the INNERMOST enclosing block, not an ancestor", () => {
    const spanStart = html.indexOf('<span style="color:red">');
    const spanEnd = html.indexOf("</span>") + "</span>".length;

    expect(findBlockIdAt({ ranges, startIndex: spanStart, endIndex: spanEnd })).toBe("txt_b");
  });

  /* The sibling discrimination. A scanner that tracked only opening offsets,
     or a lookup that walked backwards to the nearest stamp, returns txt_b
     here — the previous sibling — because txt_b opens before txt_c. */
  it("does not attribute a span to the block that merely precedes it", () => {
    const secondStart = html.indexOf('<p data-flock-block-id="txt_c">');
    const secondEnd = html.indexOf("bye</p>") + "bye</p>".length;

    expect(findBlockIdAt({ ranges, startIndex: secondStart, endIndex: secondEnd })).toBe("txt_c");
  });

  it("names the block itself when the span IS the block's own element", () => {
    const range = ranges.find((candidate) => candidate.blockId === "txt_c");
    expect(
      findBlockIdAt({ ranges, startIndex: range!.startIndex, endIndex: range!.endIndex }),
    ).toBe("txt_c");
  });

  /*
    Document-level markup gets `undefined`, and that is the answer, not a
    fallback. `<body>` is rendered by the document root, so a finding about it
    belongs to no block; rounding it to the first block would be the silent
    mis-attribution this whole module exists to avoid.
  */
  it("returns undefined for markup no block produced", () => {
    expect(findBlockIdAt({ ranges, startIndex: 0, endIndex: html.length })).toBeUndefined();
  });

  it("requires containment, not overlap", () => {
    const blockRange = ranges.find((candidate) => candidate.blockId === "txt_b")!;
    /* Starts inside txt_b and ends past it — no block contains this span. */
    expect(
      findBlockIdAt({
        ranges,
        startIndex: blockRange.startIndex + 1,
        endIndex: html.length,
      }),
    ).toBeUndefined();
  });
});

describe("toIndexRange", () => {
  /*
    caniemail reports 1-based line/column with an INCLUSIVE end column. Getting
    that off by one silently shifts every attribution by a character, which is
    invisible in the middle of a long element and decisive at its edges. The
    assertion is a slice, so only the exact convention passes.
  */
  it("converts a 1-based inclusive-end position into a half-open slice of the same string", () => {
    const html = "<a>\n<div style=\"display:flex\">x</div>\n";
    const line = "<div style=\"display:flex\">x</div>";
    const range = toIndexRange({
      html,
      start: { line: 2, column: 1 },
      end: { line: 2, column: line.length },
    });

    expect(html.slice(range.startIndex, range.endIndex)).toBe(line);
  });

  it("spans multiple lines", () => {
    const html = "<body>\n<p>x</p>\n</body>";
    const range = toIndexRange({
      html,
      start: { line: 1, column: 1 },
      end: { line: 3, column: 7 },
    });

    expect(html.slice(range.startIndex, range.endIndex)).toBe(html);
  });
});

describe("indexBlockRanges on a real annotated render", () => {
  /*
    The synthetic cases above are hand-written HTML. This one is the actual
    output of React Email for a real fixture — table soup, React comment
    markers, conditional comments, void tags and all — which is the only input
    the checker ever sees in production.
  */
  it("recovers every block of the starter document, and each range really is that block's markup", async () => {
    const doc = createStarterDocument();
    const html = await renderToHTML(doc, { isBlockAnnotated: true });
    const ranges = indexBlockRanges(html);

    const expectedBlockIds = Object.keys(doc).filter((blockId) => blockId !== "root");
    expect([...new Set(ranges.map((range) => range.blockId))].sort()).toEqual(
      expectedBlockIds.sort(),
    );

    /* Every recovered range must be a well-formed element carrying its own
       stamp — the cheap way to catch a scanner whose extents have drifted. */
    for (const range of ranges) {
      const markup = sliceOf(html, range);
      expect(markup.startsWith("<")).toBe(true);
      expect(markup.endsWith(">")).toBe(true);
      expect(markup).toContain(`data-flock-block-id="${range.blockId}"`);
    }

    /* Nesting is real: the button's range sits strictly inside its section's. */
    const button = ranges.find((range) => range.blockId === "btn_ct01")!;
    const section = ranges.find((range) => range.blockId === "sec_hero")!;
    expect(section.startIndex).toBeLessThan(button.startIndex);
    expect(section.endIndex).toBeGreaterThan(button.endIndex);
  });

  it("emits no stamps at all on an ordinary render, so a sent email carries none", async () => {
    const html = await renderToHTML(createStarterDocument());

    expect(html).not.toContain("data-flock-block-id");
    expect(indexBlockRanges(html)).toEqual([]);
  });
});
