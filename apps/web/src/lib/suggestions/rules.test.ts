import { describe, expect, it } from "vitest";
import {
  applyOperation,
  createEmptyDocument,
  type BlockId,
  type EmailDocument,
  type Operation,
} from "@flock/email-sdk";
import {
  createDefaultLeafBlock,
  createDefaultSection,
} from "@/components/studio/block-defaults";
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
  propertyKey,
  value,
  version,
}: {
  blockId: string;
  propertyKey: string;
  value: unknown;
  version: number;
}): RecentPropertyEdit {
  return {
    blockId: id(blockId),
    blockType: "button",
    propertyKey,
    value,
    version,
    createdAtMs: Date.now(),
  };
}

const neverDismissed = () => false;

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
    doc = setProperty({ doc, blockId: "btn_aaaa", propertyKey: "backgroundColor", value: "#ff0000" });
    doc = setProperty({ doc, blockId: "btn_bbbb", propertyKey: "backgroundColor", value: "#ff0000" });

    const firstEdit = makeEdit({
      blockId: "btn_aaaa",
      propertyKey: "backgroundColor",
      value: "#ff0000",
      version: 1,
    });
    const anchorEdit = makeEdit({
      blockId: "btn_bbbb",
      propertyKey: "backgroundColor",
      value: "#ff0000",
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
