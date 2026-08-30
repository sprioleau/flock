import { applyOperations, createDemoDocument, type EmailDocument } from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import { composeFindingOps } from "./finding-ops";

/*
  The proposed-edit contract, from what a persona can emit to what lands in the
  document. What must hold:

  - a copy finding carries a fix that ACTUALLY CHANGES THE WORDS, through the
    SDK's own updateText operation rather than a property write;
  - the change is reversible — the op log stores inverses, and a copy rewrite
    that cannot be undone is worse than no rewrite at all;
  - the block's structure survives the rewrite (a heading stays a heading);
  - anything that would silently DESTROY content is refused rather than
    applied, and the finding degrades to informational; and
  - the property-edit path behaves exactly as it always did.
*/

const SHOUTING_PARAGRAPH_BLOCK = "txt_push";
const HEADING_AND_PARAGRAPH_BLOCK = "txt_lead";
const MIXED_MARKS_FOOTER_BLOCK = "txt_foot";

function textOf({ doc, blockId }: { doc: EmailDocument; blockId: string }): string {
  const block = doc[blockId];
  if (block === undefined || block.type !== "text") {
    throw new Error(`${blockId} is not a text block`);
  }
  return JSON.stringify(block.properties.text);
}

describe("composeFindingOps — copy rewrites", () => {
  it("turns a plain-text rewrite into an updateText op that changes the block's words", () => {
    const doc = createDemoDocument();
    const ops = composeFindingOps({
      doc,
      proposedCopyEdits: [
        { blockId: SHOUTING_PARAGRAPH_BLOCK, text: "Yours is set aside until Sunday night." },
      ],
    });
    expect(ops?.map((op) => op.name)).toEqual(["updateText"]);
    const applied = applyOperations(doc, ops!);
    expect(applied.isOk).toBe(true);
    if (!applied.isOk) {
      return;
    }
    const rewritten = textOf({ doc: applied.doc, blockId: SHOUTING_PARAGRAPH_BLOCK });
    expect(rewritten).toContain("Yours is set aside until Sunday night.");
    expect(rewritten).not.toContain("LAST CHANCE");
  });

  it("reverts exactly: the op's inverse restores the original words", () => {
    /*
      Apply → revert is the promise behind every persona card (the finding's
      batch is reverted through history.revertBatch, which replays the stored
      inverses). A rewrite whose inverse does not restore the block byte for
      byte would leave the user unable to get their copy back.
    */
    const doc = createDemoDocument();
    const before = textOf({ doc, blockId: SHOUTING_PARAGRAPH_BLOCK });
    const ops = composeFindingOps({
      doc,
      proposedCopyEdits: [{ blockId: SHOUTING_PARAGRAPH_BLOCK, text: "A quieter paragraph." }],
    });
    const applied = applyOperations(doc, ops!);
    if (!applied.isOk) {
      throw new Error("the rewrite did not apply");
    }
    expect(textOf({ doc: applied.doc, blockId: SHOUTING_PARAGRAPH_BLOCK })).not.toBe(before);
    const reverted = applyOperations(applied.doc, applied.inverses);
    expect(reverted.isOk).toBe(true);
    if (!reverted.isOk) {
      return;
    }
    expect(textOf({ doc: reverted.doc, blockId: SHOUTING_PARAGRAPH_BLOCK })).toBe(before);
  });

  it("keeps the block's structure: a heading stays a heading at its level", () => {
    /*
      The model writes words, never document structure — so the heading/
      paragraph shape has to come from the block being rewritten. If it did
      not, a tone fix on a hero would silently demote its h1 to body copy.
    */
    const doc = createDemoDocument();
    const ops = composeFindingOps({
      doc,
      proposedCopyEdits: [
        {
          blockId: HEADING_AND_PARAGRAPH_BLOCK,
          text: "Your spring lot is here\nThe first bags came off the roaster on Tuesday.",
        },
      ],
    });
    const applied = applyOperations(doc, ops!);
    if (!applied.isOk) {
      throw new Error("the rewrite did not apply");
    }
    const block = applied.doc[HEADING_AND_PARAGRAPH_BLOCK];
    if (block === undefined || block.type !== "text") {
      throw new Error("the hero text block vanished");
    }
    expect(block.properties.text.content).toEqual([
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: "Your spring lot is here" }],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "The first bags came off the roaster on Tuesday." }],
      },
    ]);
  });

  it("accepts the outline's own ' | ' separator between a block's pieces", () => {
    /*
      The outline a persona reads joins a text block's nodes with " | ", so a
      model that echoes that separator back has understood the instruction and
      typed the wrong character. Repairing it is deterministic; refusing it
      would cost a good rewrite.
    */
    const doc = createDemoDocument();
    const ops = composeFindingOps({
      doc,
      proposedCopyEdits: [
        { blockId: HEADING_AND_PARAGRAPH_BLOCK, text: "Spring has landed | Your bag is ready." },
      ],
    });
    const applied = applyOperations(doc, ops!);
    if (!applied.isOk) {
      throw new Error("the rewrite did not apply");
    }
    const block = applied.doc[HEADING_AND_PARAGRAPH_BLOCK];
    if (block === undefined || block.type !== "text") {
      throw new Error("the hero text block vanished");
    }
    expect(block.properties.text.content).toHaveLength(2);
    expect(block.properties.text.content[0]?.type).toBe("heading");
  });
});

describe("composeFindingOps — refusals (a fix that would destroy content is not offered)", () => {
  it("refuses a rewrite with fewer lines than the block has paragraphs", () => {
    /*
      One line for a two-piece block would drop the trailing paragraph — a
      deletion the persona never proposed and the user never saw coming.
    */
    expect(
      composeFindingOps({
        doc: createDemoDocument(),
        proposedCopyEdits: [
          { blockId: HEADING_AND_PARAGRAPH_BLOCK, text: "Just a headline, nothing else." },
        ],
      }),
    ).toBeNull();
  });

  it("refuses a rewrite of a block whose formatting varies run to run", () => {
    /*
      The demo footer's first paragraph is two hyperlinks around a separator.
      A whole-doc replacement cannot carry marks the rewritten words no longer
      align with, and dropping two live links out of a footer under the banner
      of a "copy fix" is not an acceptable trade.
    */
    expect(
      composeFindingOps({
        doc: createDemoDocument(),
        proposedCopyEdits: [
          {
            blockId: MIXED_MARKS_FOOTER_BLOCK,
            text: "Our story · Wholesale\nHarborlight Coffee Roasters\nUnsubscribe",
          },
        ],
      }),
    ).toBeNull();
  });

  it("refuses a rewrite aimed at a block that is not text", () => {
    /*
      A button's label is a property. Nothing is written on the way to
      discovering that — the batch never leaves this module.
    */
    expect(
      composeFindingOps({
        doc: createDemoDocument(),
        proposedCopyEdits: [{ blockId: "btn_scnd", text: "Shop the lineup" }],
      }),
    ).toBeNull();
  });

  it("refuses a rewrite of a block that does not exist, and an empty one", () => {
    const doc = createDemoDocument();
    expect(
      composeFindingOps({ doc, proposedCopyEdits: [{ blockId: "txt_zzzz", text: "Hello." }] }),
    ).toBeNull();
    expect(
      composeFindingOps({
        doc,
        proposedCopyEdits: [{ blockId: SHOUTING_PARAGRAPH_BLOCK, text: "   \n  " }],
      }),
    ).toBeNull();
  });

  it("refuses a rewrite that has run away into a document", () => {
    expect(
      composeFindingOps({
        doc: createDemoDocument(),
        proposedCopyEdits: [
          { blockId: SHOUTING_PARAGRAPH_BLOCK, text: "beans and more beans ".repeat(200) },
        ],
      }),
    ).toBeNull();
  });
});

describe("composeFindingOps — property edits (unchanged by the copy-edit work)", () => {
  it("groups one block's property edits into a single op and coerces the scalars", () => {
    const doc = createDemoDocument();
    const ops = composeFindingOps({
      doc,
      proposedEdits: [
        { blockId: "btn_scnd", property: "backgroundColor", value: "#1f6f5c" },
        { blockId: "btn_scnd", property: "borderRadius", value: "6" },
        { blockId: "btn_scnd", property: "align", value: "center" },
      ],
    });
    expect(ops).toEqual([
      {
        name: "updateBlockProperties",
        blockId: "btn_scnd",
        properties: { backgroundColor: "#1f6f5c", borderRadius: 6, align: "center" },
      },
    ]);
  });

  it("still refuses a property edit that fails the dry run", () => {
    expect(
      composeFindingOps({
        doc: createDemoDocument(),
        proposedEdits: [{ blockId: "btn_nope", property: "align", value: "center" }],
      }),
    ).toBeNull();
  });

  it("returns an empty batch when a finding proposes nothing (informational)", () => {
    expect(composeFindingOps({ doc: createDemoDocument() })).toEqual([]);
  });

  it("carries a property edit and a copy rewrite in ONE batch", () => {
    /*
      One press, one op-log batch, one revert — a finding that recolors a
      block and rewrites the words above it must not become two half-fixes.
    */
    const doc = createDemoDocument();
    const ops = composeFindingOps({
      doc,
      proposedEdits: [{ blockId: "btn_scnd", property: "align", value: "center" }],
      proposedCopyEdits: [{ blockId: SHOUTING_PARAGRAPH_BLOCK, text: "A quieter paragraph." }],
    });
    expect(ops?.map((op) => op.name)).toEqual(["updateBlockProperties", "updateText"]);
    expect(applyOperations(doc, ops!).isOk).toBe(true);
  });
});
