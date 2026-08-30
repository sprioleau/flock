import { describe, expect, it } from "vitest";
import {
  applyOperation,
  createEmptyDocument,
  type BlockId,
  type EmailDocument,
  type Operation,
} from "@flock/email-sdk";
import { createDefaultLeafBlock, createDefaultSection } from "@/components/studio/block-defaults";
import { getContrastRatio } from "@/lib/brand-kit";
import {
  getContrastFixColor,
  getContrastSubject,
  getIsContrastCritiqueProperty,
  resolveBackgroundBehind,
} from "./contrast";

/*
  The critique rule's measuring instrument. Everything here is checked against
  PUBLISHED WCAG numbers rather than against a fixture chosen to agree with the
  implementation: white-on-black is 21:1 by definition, white on pure red is
  4.0:1, and #767676/#777777 on white are the canonical pair that straddle the
  4.5:1 AA boundary (4.54 and 4.48). If the maths drifts, those four break.
*/

const id = (value: string) => value as BlockId;

function apply(doc: EmailDocument, op: Operation): EmailDocument {
  const result = applyOperation(doc, op);
  if (!result.isOk) {
    throw new Error(`fixture apply failed: ${JSON.stringify(result.errors)}`);
  }
  return result.doc;
}

/*
  root > sec_aaaa > [btn_aaaa, row_aaaa > col_aaaa > lnk_aaaa]
*/
function buildDoc(): EmailDocument {
  let doc = createEmptyDocument();
  doc = apply(doc, { name: "addSection", section: createDefaultSection(id("sec_aaaa")), index: 0 });
  doc = apply(doc, {
    name: "addBlock",
    block: createDefaultLeafBlock({
      type: "button",
      id: id("btn_aaaa"),
      parentId: id("sec_aaaa"),
      doc,
    }),
    parentId: id("sec_aaaa"),
    index: 0,
  });
  doc = apply(doc, {
    name: "addBlock",
    block: {
      id: id("row_aaaa"),
      type: "row",
      parentId: id("sec_aaaa"),
      childrenIds: [],
      properties: {},
    },
    parentId: id("sec_aaaa"),
    index: 1,
  });
  doc = apply(doc, {
    name: "addBlock",
    block: {
      id: id("col_aaaa"),
      type: "column",
      parentId: id("row_aaaa"),
      childrenIds: [],
      properties: {},
    },
    parentId: id("row_aaaa"),
    index: 0,
  });
  doc = apply(doc, {
    name: "addBlock",
    block: createDefaultLeafBlock({
      type: "link",
      id: id("lnk_aaaa"),
      parentId: id("col_aaaa"),
      doc,
    }),
    parentId: id("col_aaaa"),
    index: 0,
  });
  return doc;
}

function setProperties({
  doc,
  blockId,
  properties,
}: {
  doc: EmailDocument;
  blockId: string;
  properties: Record<string, unknown>;
}): EmailDocument {
  return apply(doc, { name: "updateBlockProperties", blockId: id(blockId), properties });
}

function subjectForButton({
  backgroundColor,
  textColor,
}: {
  backgroundColor: string;
  textColor: string;
}) {
  const doc = setProperties({
    doc: buildDoc(),
    blockId: "btn_aaaa",
    properties: { backgroundColor, textColor },
  });
  const block = doc.btn_aaaa;
  if (block === undefined) {
    throw new Error("fixture lost its button");
  }
  return getContrastSubject({ doc, block });
}

describe("contrast maths — published WCAG values, not fixture agreement", () => {
  it("reads white on black as 21:1 and passes it", () => {
    const subject = subjectForButton({ backgroundColor: "#000000", textColor: "#ffffff" });
    expect(subject?.ratio).toBeCloseTo(21, 2);
    expect(subject?.minRatio).toBe(4.5);
    expect(subject?.isFailing).toBe(false);
  });

  it("reads white on pure red as 4.0:1 and fails it", () => {
    const subject = subjectForButton({ backgroundColor: "#ff0000", textColor: "#ffffff" });
    expect(subject?.ratio).toBeCloseTo(4.0, 1);
    expect(subject?.isFailing).toBe(true);
  });

  it("passes #767676 on white — 4.54:1, the published AA boundary", () => {
    const subject = subjectForButton({ backgroundColor: "#ffffff", textColor: "#767676" });
    expect(subject?.ratio).toBeCloseTo(4.54, 2);
    expect(subject?.isFailing).toBe(false);
  });

  it("fails #777777 on white — 4.48:1, one step past the boundary", () => {
    const subject = subjectForButton({ backgroundColor: "#ffffff", textColor: "#777777" });
    expect(subject?.ratio).toBeCloseTo(4.48, 2);
    expect(subject?.isFailing).toBe(true);
  });

  it("declines to measure a color it cannot parse", () => {
    expect(subjectForButton({ backgroundColor: "transparent", textColor: "#ffffff" })).toBeNull();
  });
});

describe("the background a block actually sits on", () => {
  it("falls through to the globals content background when nothing overrides it", () => {
    expect(resolveBackgroundBehind({ doc: buildDoc(), blockId: id("lnk_aaaa") })).toBe("#ffffff");
  });

  it("takes the document globals when the theme sets a content background", () => {
    const doc = apply(buildDoc(), {
      name: "applyTheme",
      globals: { contentBackgroundColor: "#101010" },
    });
    expect(resolveBackgroundBehind({ doc, blockId: id("lnk_aaaa") })).toBe("#101010");
  });

  it("prefers the section's own inner background over the globals", () => {
    const doc = setProperties({
      doc: buildDoc(),
      blockId: "sec_aaaa",
      properties: { innerBackgroundColor: "#222222" },
    });
    expect(resolveBackgroundBehind({ doc, blockId: id("lnk_aaaa") })).toBe("#222222");
  });

  it("prefers the nearest container — a column background beats its section", () => {
    let doc = setProperties({
      doc: buildDoc(),
      blockId: "sec_aaaa",
      properties: { innerBackgroundColor: "#222222" },
    });
    doc = setProperties({
      doc,
      blockId: "col_aaaa",
      properties: { backgroundColor: "#0033aa" },
    });
    expect(resolveBackgroundBehind({ doc, blockId: id("lnk_aaaa") })).toBe("#0033aa");
  });

  it("uses a row background when the column is transparent", () => {
    let doc = setProperties({
      doc: buildDoc(),
      blockId: "sec_aaaa",
      properties: { innerBackgroundColor: "#222222" },
    });
    doc = setProperties({ doc, blockId: "row_aaaa", properties: { backgroundColor: "#00aa33" } });
    expect(resolveBackgroundBehind({ doc, blockId: id("lnk_aaaa") })).toBe("#00aa33");
  });
});

describe("the WCAG large-text exemption", () => {
  /*
    #ffffff on #898989 is 3.50:1 — under AA for body text, over it for large.
  */
  function subjectForLink(fontSize: number) {
    let doc = setProperties({
      doc: buildDoc(),
      blockId: "col_aaaa",
      properties: { backgroundColor: "#898989" },
    });
    doc = setProperties({
      doc,
      blockId: "lnk_aaaa",
      properties: { textColor: "#ffffff", fontSize },
    });
    const block = doc.lnk_aaaa;
    if (block === undefined) {
      throw new Error("fixture lost its link");
    }
    return getContrastSubject({ doc, block });
  }

  it("holds 24px text to 3:1, so 3.5:1 is fine", () => {
    const subject = subjectForLink(24);
    expect(subject?.ratio).toBeCloseTo(3.5, 1);
    expect(subject?.minRatio).toBe(3);
    expect(subject?.isFailing).toBe(false);
  });

  it("holds 16px text to 4.5:1, so the same 3.5:1 fails", () => {
    const subject = subjectForLink(16);
    expect(subject?.minRatio).toBe(4.5);
    expect(subject?.isFailing).toBe(true);
  });
});

describe("which edits can even produce a contrast defect", () => {
  it("counts the two colors a button label sits between", () => {
    for (const propertyKey of ["backgroundColor", "textColor"]) {
      expect(getIsContrastCritiqueProperty({ blockType: "button", propertyKey })).toBe(true);
    }
  });

  it("counts a link's color and its size (size moves the AA threshold)", () => {
    for (const propertyKey of ["textColor", "fontSize"]) {
      expect(getIsContrastCritiqueProperty({ blockType: "link", propertyKey })).toBe(true);
    }
  });

  it("ignores properties that cannot change the pair", () => {
    expect(getIsContrastCritiqueProperty({ blockType: "button", propertyKey: "borderRadius" })).toBe(
      false,
    );
    expect(getIsContrastCritiqueProperty({ blockType: "button", propertyKey: "align" })).toBe(false);
    expect(getIsContrastCritiqueProperty({ blockType: "link", propertyKey: "href" })).toBe(false);
  });

  it("ignores block types whose correct threshold is not knowable", () => {
    /*
      Text blocks mix heading and paragraph sizes, so one number cannot judge them.
    */
    expect(getIsContrastCritiqueProperty({ blockType: "text", propertyKey: "textColor" })).toBe(
      false,
    );
    expect(
      getIsContrastCritiqueProperty({ blockType: "section", propertyKey: "innerBackgroundColor" }),
    ).toBe(false);
  });

  it("has no critique-worthy property on a block type it does not judge", () => {
    expect(getIsContrastCritiqueProperty({ blockType: "image", propertyKey: "backgroundColor" })).toBe(
      false,
    );
  });
});

describe("the fix the critique attaches", () => {
  it("returns a color that clears AA against the same background", () => {
    const subject = subjectForButton({ backgroundColor: "#ff0000", textColor: "#ffffff" });
    expect(subject).not.toBeNull();
    const fixColor = getContrastFixColor(subject!);
    expect(fixColor).not.toBeNull();
    expect(
      getContrastRatio({ foreground: fixColor!, background: "#ff0000" })!,
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps as much of the chosen color as it can rather than snapping to black", () => {
    const subject = subjectForButton({ backgroundColor: "#ffffff", textColor: "#777777" });
    const fixColor = getContrastFixColor(subject!);
    expect(fixColor).not.toBe("#000000");
    expect(
      getContrastRatio({ foreground: fixColor!, background: "#ffffff" })!,
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("offers nothing when the pair already reads fine", () => {
    const subject = subjectForButton({ backgroundColor: "#000000", textColor: "#ffffff" });
    expect(getContrastFixColor(subject!)).toBeNull();
  });
});
