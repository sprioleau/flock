import { describe, expect, it } from "vitest";
import {
  applyOperation,
  applyOperations,
  createEmptyDocument,
  type Block,
  type BlockId,
  type EmailDocument,
  type Operation,
} from "@flock/email-sdk";
import {
  createDefaultLeafBlock,
  createDefaultSection,
} from "@/components/studio/block-defaults";
import { getContrastRatio } from "@/lib/brand-kit";
import { evaluateSuggestionRules } from "./rules";
import type { RecentPropertyEdit } from "./types";

/**
 * The anchor block: which block a suggestion is ABOUT.
 *
 * It was always implicit — `targetBlockIds[0]`, first by Set insertion order.
 * That was fine while the only surface was a card at the bottom of the chat
 * panel, and is far too fragile now that real UI hangs off it: the canvas pill
 * renders inside that block's shell. So it is carried explicitly, and these
 * tests pin it to the block the user actually just edited for BOTH rules —
 * including the case where the pattern spans several blocks and "first in the
 * set" would have been the wrong one to point at.
 */

const id = (value: string) => value as BlockId;

function apply(doc: EmailDocument, op: Operation): EmailDocument {
  const result = applyOperation(doc, op);
  if (!result.isOk) {
    throw new Error(`fixture apply failed: ${JSON.stringify(result.errors)}`);
  }
  return result.doc;
}

/** root > sec_aaaa [btn_aaaa, btn_bbbb, btn_cccc] — the owner's exact shape. */
function buildThreeButtonDoc(): EmailDocument {
  let doc = createEmptyDocument();
  doc = apply(doc, { name: "addSection", section: createDefaultSection(id("sec_aaaa")), index: 0 });
  for (const [index, blockId] of ["btn_aaaa", "btn_bbbb", "btn_cccc"].entries()) {
    doc = apply(doc, {
      name: "addBlock",
      block: createDefaultLeafBlock({
        type: "button",
        id: id(blockId),
        parentId: id("sec_aaaa"),
        doc,
      }),
      parentId: id("sec_aaaa"),
      index,
    });
  }
  return doc;
}

function setProperty({
  doc,
  blockId,
  propertyKey,
  value,
}: {
  doc: EmailDocument;
  blockId: string;
  propertyKey: string;
  value: unknown;
}): EmailDocument {
  return apply(doc, {
    name: "updateBlockProperties",
    blockId: id(blockId),
    properties: { [propertyKey]: value },
  });
}

function makeEdit({
  blockId,
  blockType = "button",
  propertyKey,
  value,
  version,
  author = "user",
}: {
  blockId: string;
  blockType?: Block["type"];
  propertyKey: string;
  value: unknown;
  version: number;
  author?: RecentPropertyEdit["author"];
}): RecentPropertyEdit {
  return {
    blockId: id(blockId),
    blockType,
    propertyKey,
    value,
    version,
    author,
    createdAtMs: Date.now(),
  };
}

const neverDismissed = () => false;

/*
  The two fills every case below is built from, and they are not interchangeable
  decoration. White (the default button label) reads at 4.0:1 on #ff0000 — a
  real, published WCAG AA failure — and at 10.1:1 on #0b3d91. Any test that
  wants a PATTERN rule and not the contrast critique has to use the passing one,
  because the critique is evaluated first on purpose (see rules.ts).
*/
const FAILING_BUTTON_FILL = "#ff0000";
const PASSING_BUTTON_FILL = "#0b3d91";

describe("sibling-asymmetry — the owner's case", () => {
  it("anchors on the one button the user just left-aligned", () => {
    // Three buttons in a section; the user aligns ONE of them left.
    const doc = setProperty({
      doc: buildThreeButtonDoc(),
      blockId: "btn_bbbb",
      propertyKey: "align",
      value: "left",
    });
    const anchorEdit = makeEdit({
      blockId: "btn_bbbb",
      propertyKey: "align",
      value: "left",
      version: 1,
    });

    const suggestion = evaluateSuggestionRules({
      doc,
      recentEdits: [anchorEdit],
      anchorEdit,
      isPatternDismissed: neverDismissed,
    });

    expect(suggestion).not.toBeNull();
    expect(suggestion?.ruleId).toBe("sibling-asymmetry");
    expect(suggestion?.anchorBlockId).toBe("btn_bbbb");
    // The copy the owner saw, still exactly that.
    expect(suggestion?.title).toBe("Style the other buttons to match?");
    expect(suggestion?.description).toBe(
      "2 buttons in this section still have a different align.",
    );
  });

  it("keeps the anchor inside targetBlockIds, so staleness still covers it", () => {
    const doc = setProperty({
      doc: buildThreeButtonDoc(),
      blockId: "btn_cccc",
      propertyKey: "align",
      value: "left",
    });
    const anchorEdit = makeEdit({
      blockId: "btn_cccc",
      propertyKey: "align",
      value: "left",
      version: 1,
    });
    const suggestion = evaluateSuggestionRules({
      doc,
      recentEdits: [anchorEdit],
      anchorEdit,
      isPatternDismissed: neverDismissed,
    });
    expect(suggestion?.anchorBlockId).toBe("btn_cccc");
    expect(suggestion?.targetBlockIds).toContain("btn_cccc");
  });
});

describe("repeated-property-edit", () => {
  it("anchors on the LAST block edited, not the first of the pattern", () => {
    // Four buttons; the user recolors two of them in sequence. The pill must
    // appear under the one they just touched — btn_bbbb, which is neither the
    // first block in the document nor the first in the pattern.
    let doc = buildThreeButtonDoc();
    doc = apply(doc, {
      name: "addBlock",
      block: createDefaultLeafBlock({
        type: "button",
        id: id("btn_dddd"),
        parentId: id("sec_aaaa"),
        doc,
      }),
      parentId: id("sec_aaaa"),
      index: 3,
    });
    // The fill is PASSING_BUTTON_FILL rather than the red this test used to
    // carry: red trips low-contrast-edit, which now outranks this rule. What
    // is under test here is the ANCHOR, not the color, so the color moves.
    for (const target of ["btn_aaaa", "btn_bbbb"]) {
      doc = setProperty({
        doc,
        blockId: target,
        propertyKey: "backgroundColor",
        value: PASSING_BUTTON_FILL,
      });
    }

    const firstEdit = makeEdit({
      blockId: "btn_aaaa",
      propertyKey: "backgroundColor",
      value: PASSING_BUTTON_FILL,
      version: 1,
    });
    const anchorEdit = makeEdit({
      blockId: "btn_bbbb",
      propertyKey: "backgroundColor",
      value: PASSING_BUTTON_FILL,
      version: 2,
    });

    const suggestion = evaluateSuggestionRules({
      doc,
      recentEdits: [firstEdit, anchorEdit],
      anchorEdit,
      isPatternDismissed: neverDismissed,
    });

    expect(suggestion?.ruleId).toBe("repeated-property-edit");
    expect(suggestion?.anchorBlockId).toBe("btn_bbbb");
    // ...and NOT merely whatever landed first in the target set.
    expect(suggestion?.targetBlockIds[0]).toBe("btn_bbbb");
  });
});

/**
 * low-contrast-edit (§10 row 7) — the agent critiquing a HUMAN edit rather
 * than offering to repeat one. The bar for a critique is higher than for a
 * pattern suggestion: it has to be right when it speaks AND silent when the
 * edit is fine, so every case below has its negative twin.
 *
 * The rule must separate FAILING_BUTTON_FILL from PASSING_BUTTON_FILL and
 * nothing else — it is not allowed to have an opinion about anything past
 * that.
 */

describe("low-contrast-edit — critiquing the edit that just landed", () => {
  it("names the defect and attaches a fix that actually clears AA", () => {
    const doc = setProperty({
      doc: buildThreeButtonDoc(),
      blockId: "btn_aaaa",
      propertyKey: "backgroundColor",
      value: FAILING_BUTTON_FILL,
    });
    const anchorEdit = makeEdit({
      blockId: "btn_aaaa",
      propertyKey: "backgroundColor",
      value: FAILING_BUTTON_FILL,
      version: 1,
    });

    const suggestion = evaluateSuggestionRules({
      doc,
      recentEdits: [anchorEdit],
      anchorEdit,
      isPatternDismissed: neverDismissed,
    });

    expect(suggestion?.ruleId).toBe("low-contrast-edit");
    expect(suggestion?.anchorBlockId).toBe("btn_aaaa");
    expect(suggestion?.rungs.map((rung) => rung.id)).toEqual(["fix"]);
    expect(suggestion?.description).toContain("4:1");

    // The fix touches exactly the edited block, and the result reads.
    const rung = suggestion!.rungs[0]!;
    expect(rung.ops).toHaveLength(1);
    const applied = applyOperations(doc, rung.ops);
    expect(applied.isOk).toBe(true);
    const fixedButton = applied.isOk ? applied.doc.btn_aaaa : undefined;
    const fixedTextColor =
      fixedButton?.type === "button" ? fixedButton.properties.textColor : undefined;
    expect(fixedTextColor).toBeDefined();
    expect(
      getContrastRatio({ foreground: fixedTextColor!, background: FAILING_BUTTON_FILL })!,
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("says NOTHING about a recolor that reads perfectly well", () => {
    const doc = setProperty({
      doc: buildThreeButtonDoc(),
      blockId: "btn_aaaa",
      propertyKey: "backgroundColor",
      value: PASSING_BUTTON_FILL,
    });
    const anchorEdit = makeEdit({
      blockId: "btn_aaaa",
      propertyKey: "backgroundColor",
      value: PASSING_BUTTON_FILL,
      version: 1,
    });

    const suggestion = evaluateSuggestionRules({
      doc,
      recentEdits: [anchorEdit],
      anchorEdit,
      isPatternDismissed: neverDismissed,
    });

    // Not silence overall — the ladder still works. Just no critique.
    expect(suggestion?.ruleId).toBe("sibling-asymmetry");
  });

  it("does not dredge up a failure the edit did not touch", () => {
    // The button is ALREADY unreadable; the user then rounds its corners.
    let doc = setProperty({
      doc: buildThreeButtonDoc(),
      blockId: "btn_aaaa",
      propertyKey: "backgroundColor",
      value: FAILING_BUTTON_FILL,
    });
    doc = setProperty({ doc, blockId: "btn_aaaa", propertyKey: "borderRadius", value: 12 });
    const anchorEdit = makeEdit({
      blockId: "btn_aaaa",
      propertyKey: "borderRadius",
      value: 12,
      version: 2,
    });

    const suggestion = evaluateSuggestionRules({
      doc,
      recentEdits: [anchorEdit],
      anchorEdit,
      isPatternDismissed: neverDismissed,
    });

    expect(suggestion?.ruleId).not.toBe("low-contrast-edit");
  });

  it("outranks the ladder — a defect beats an offer to spread it", () => {
    let doc = buildThreeButtonDoc();
    doc = setProperty({
      doc,
      blockId: "btn_aaaa",
      propertyKey: "backgroundColor",
      value: FAILING_BUTTON_FILL,
    });
    doc = setProperty({
      doc,
      blockId: "btn_bbbb",
      propertyKey: "backgroundColor",
      value: FAILING_BUTTON_FILL,
    });
    const firstEdit = makeEdit({
      blockId: "btn_aaaa",
      propertyKey: "backgroundColor",
      value: FAILING_BUTTON_FILL,
      version: 1,
    });
    const anchorEdit = makeEdit({
      blockId: "btn_bbbb",
      propertyKey: "backgroundColor",
      value: FAILING_BUTTON_FILL,
      version: 2,
    });

    const suggestion = evaluateSuggestionRules({
      doc,
      recentEdits: [firstEdit, anchorEdit],
      anchorEdit,
      isPatternDismissed: neverDismissed,
    });

    // repeated-property-edit would otherwise match here and offer to paint the
    // remaining button the same unreadable red.
    expect(suggestion?.ruleId).toBe("low-contrast-edit");
  });

  it("critiques the AGENT's own edit, which is the case most worth catching", () => {
    const doc = setProperty({
      doc: buildThreeButtonDoc(),
      blockId: "btn_aaaa",
      propertyKey: "backgroundColor",
      value: FAILING_BUTTON_FILL,
    });
    const anchorEdit = makeEdit({
      blockId: "btn_aaaa",
      propertyKey: "backgroundColor",
      value: FAILING_BUTTON_FILL,
      version: 1,
      author: "agent",
    });

    const suggestion = evaluateSuggestionRules({
      doc,
      recentEdits: [],
      anchorEdit,
      isPatternDismissed: neverDismissed,
    });

    expect(suggestion?.ruleId).toBe("low-contrast-edit");
  });

  it("but the PATTERN rules still only follow the user's own habits", () => {
    const doc = setProperty({
      doc: buildThreeButtonDoc(),
      blockId: "btn_aaaa",
      propertyKey: "backgroundColor",
      value: PASSING_BUTTON_FILL,
    });
    const anchorEdit = makeEdit({
      blockId: "btn_aaaa",
      propertyKey: "backgroundColor",
      value: PASSING_BUTTON_FILL,
      version: 1,
      author: "agent",
    });

    // The identical edit authored by the user produces sibling-asymmetry.
    expect(
      evaluateSuggestionRules({
        doc,
        recentEdits: [anchorEdit],
        anchorEdit: { ...anchorEdit, author: "user" },
        isPatternDismissed: neverDismissed,
      })?.ruleId,
    ).toBe("sibling-asymmetry");

    expect(
      evaluateSuggestionRules({
        doc,
        recentEdits: [],
        anchorEdit,
        isPatternDismissed: neverDismissed,
      }),
    ).toBeNull();
  });
});

describe("low-contrast-edit — what dismissing it means", () => {
  function critiqueFor(blockId: string, isPatternDismissed: (key: string) => boolean) {
    let doc = buildThreeButtonDoc();
    for (const target of ["btn_aaaa", "btn_bbbb"]) {
      doc = setProperty({
        doc,
        blockId: target,
        propertyKey: "backgroundColor",
        value: FAILING_BUTTON_FILL,
      });
    }
    const anchorEdit = makeEdit({
      blockId,
      propertyKey: "backgroundColor",
      value: FAILING_BUTTON_FILL,
      version: 1,
    });
    return evaluateSuggestionRules({
      doc,
      recentEdits: [anchorEdit],
      anchorEdit,
      isPatternDismissed,
    });
  }

  it("quiets the block the user disagreed about, and only that block", () => {
    const dismissedAaaa = (key: string) => key === "critique:contrast|btn_aaaa";
    expect(critiqueFor("btn_aaaa", dismissedAaaa)?.ruleId).not.toBe("low-contrast-edit");
    expect(critiqueFor("btn_bbbb", dismissedAaaa)?.ruleId).toBe("low-contrast-edit");
  });

  it("keeps its key space disjoint from the style-pattern dismissals", () => {
    // Dismissing "stop matching my button colors" must not also mean
    // "stop telling me when a button is unreadable" — different statements.
    const dismissedStylePattern = (key: string) => key === "button|backgroundColor";
    expect(critiqueFor("btn_aaaa", dismissedStylePattern)?.ruleId).toBe("low-contrast-edit");
  });
});

describe("low-contrast-edit — standalone links", () => {
  /* root > sec_aaaa > lnk_aaaa, on the default #ffffff content background. */
  function buildLinkDoc(): EmailDocument {
    let doc = createEmptyDocument();
    doc = apply(doc, {
      name: "addSection",
      section: createDefaultSection(id("sec_aaaa")),
      index: 0,
    });
    return apply(doc, {
      name: "addBlock",
      block: createDefaultLeafBlock({
        type: "link",
        id: id("lnk_aaaa"),
        parentId: id("sec_aaaa"),
        doc,
      }),
      parentId: id("sec_aaaa"),
      index: 0,
    });
  }

  it("critiques a link recolored past legibility on its own background", () => {
    const doc = setProperty({
      doc: buildLinkDoc(),
      blockId: "lnk_aaaa",
      propertyKey: "textColor",
      value: "#9ad4ff",
    });
    const anchorEdit = makeEdit({
      blockId: "lnk_aaaa",
      blockType: "link",
      propertyKey: "textColor",
      value: "#9ad4ff",
      version: 1,
    });

    const suggestion = evaluateSuggestionRules({
      doc,
      recentEdits: [anchorEdit],
      anchorEdit,
      isPatternDismissed: neverDismissed,
    });

    expect(suggestion?.ruleId).toBe("low-contrast-edit");
    expect(suggestion?.rungs[0]?.ops).toEqual([
      {
        name: "updateBlockProperties",
        blockId: "lnk_aaaa",
        properties: { textColor: expect.any(String) },
      },
    ]);
  });

  /*
    THE GUARD THAT ONLY A LARGE-TEXT CASE CAN CATCH.

    For body text the `isFailing` check and "is there a corrected color?" agree,
    so a button test cannot tell them apart — deleting the failing check leaves
    every button test green, because the repair pass returns the SAME color for
    a pair that already passes and the rule bails anyway. The two only diverge
    above the large-text threshold, where 3.5:1 is legible but the repair pass
    (which always aims at 4.5) would still hand back a different color. Without
    this case the rule could be made to fire on legibly large type and nothing
    would notice.
  */
  it("leaves a LARGE link alone at a ratio that would fail body text", () => {
    let doc = setProperty({
      doc: buildLinkDoc(),
      blockId: "sec_aaaa",
      propertyKey: "innerBackgroundColor",
      value: "#898989",
    });
    doc = apply(doc, {
      name: "updateBlockProperties",
      blockId: id("lnk_aaaa"),
      properties: { textColor: "#ffffff", fontSize: 24 },
    });
    const anchorEdit = makeEdit({
      blockId: "lnk_aaaa",
      blockType: "link",
      propertyKey: "fontSize",
      value: 24,
      version: 1,
    });

    expect(
      evaluateSuggestionRules({
        doc,
        recentEdits: [anchorEdit],
        anchorEdit,
        isPatternDismissed: neverDismissed,
      }),
    ).toBeNull();
  });

  it("critiques the SAME color once the link is body-sized again", () => {
    let doc = setProperty({
      doc: buildLinkDoc(),
      blockId: "sec_aaaa",
      propertyKey: "innerBackgroundColor",
      value: "#898989",
    });
    doc = apply(doc, {
      name: "updateBlockProperties",
      blockId: id("lnk_aaaa"),
      properties: { textColor: "#ffffff", fontSize: 16 },
    });
    const anchorEdit = makeEdit({
      blockId: "lnk_aaaa",
      blockType: "link",
      propertyKey: "fontSize",
      value: 16,
      version: 1,
    });

    expect(
      evaluateSuggestionRules({
        doc,
        recentEdits: [anchorEdit],
        anchorEdit,
        isPatternDismissed: neverDismissed,
      })?.ruleId,
    ).toBe("low-contrast-edit");
  });

  it("leaves a legible link alone", () => {
    const doc = setProperty({
      doc: buildLinkDoc(),
      blockId: "lnk_aaaa",
      propertyKey: "textColor",
      value: "#0b3d91",
    });
    const anchorEdit = makeEdit({
      blockId: "lnk_aaaa",
      blockType: "link",
      propertyKey: "textColor",
      value: "#0b3d91",
      version: 1,
    });

    expect(
      evaluateSuggestionRules({
        doc,
        recentEdits: [anchorEdit],
        anchorEdit,
        isPatternDismissed: neverDismissed,
      }),
    ).toBeNull();
  });
});
