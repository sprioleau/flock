import { describe, expect, it } from "vitest";
import { applyOperation } from "../operations/apply";
import { createSampleDocument } from "../store/document";
import { resolveBlockStyles } from "../render/styles";
import type { RowBlock } from "../schema/blocks";
import { emailActionRegistry, updateBlockPropertiesAction } from "./builtins";
import type { ActionContext } from "./context";
import { dispatchContentAction } from "./registry";

/**
 * Agent/human parity for the row block's style properties.
 *
 * The human panel writes these through `updateBlockProperties`; the agent
 * reaches the SAME action through the registry. This pins the three things a
 * new control has to do to be real: survive schema validation, produce an
 * inverse that restores the previous state (the undo spine), and resolve into
 * the styles the renderer actually reads.
 *
 * `row_k1l2` is the sample document's two-column row, and it starts with
 * empty properties — so every assertion below is about the property arriving,
 * not about a value that was already there.
 */

const agentContext: ActionContext = {
  caller: "tool",
  authorId: "agent_thread_1",
  author: "agent",
  batchId: "batch_1",
  threadId: "thread_1",
};

const ROW_ID = "row_k1l2";

function rowOf(doc: ReturnType<typeof createSampleDocument>): RowBlock {
  const block = doc[ROW_ID];
  if (block === undefined || block.type !== "row") {
    throw new Error(`expected ${ROW_ID} to be a row`);
  }
  return block;
}

describe("row style properties are reachable by the agent", () => {
  it("starts from a row with no style overrides", () => {
    expect(rowOf(createSampleDocument()).properties).toEqual({});
  });

  it.each([
    ["backgroundColor", { backgroundColor: "#e0f2fe" }],
    ["paddingLeft", { paddingLeft: 16 }],
    ["paddingRight", { paddingRight: 16 }],
    ["paddingTop", { paddingTop: 8 }],
    ["paddingBottom", { paddingBottom: 8 }],
  ])("the agent can set %s through the action registry", (_name, properties) => {
    const doc = createSampleDocument();
    const result = dispatchContentAction({
      registry: emailActionRegistry,
      doc,
      name: "updateBlockProperties",
      input: { name: "updateBlockProperties", blockId: ROW_ID, properties },
      context: agentContext,
    });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(rowOf(result.doc).properties).toEqual(properties);
  });

  it("resolves an agent-set background into the styles the renderer reads", () => {
    const doc = createSampleDocument();
    const applied = updateBlockPropertiesAction.run({
      doc,
      input: {
        name: "updateBlockProperties",
        blockId: ROW_ID,
        properties: { backgroundColor: "#111827", paddingLeft: 12 },
      },
      context: agentContext,
    });

    expect(applied.isOk).toBe(true);
    if (!applied.isOk) return;
    const resolved = resolveBlockStyles(undefined, rowOf(applied.doc));
    expect(resolved.backgroundColor).toBe("#111827");
    expect(resolved.paddingLeft).toBe(12);
  });

  it("produces an inverse that undoes the change (the history spine)", () => {
    const doc = createSampleDocument();
    const applied = updateBlockPropertiesAction.run({
      doc,
      input: {
        name: "updateBlockProperties",
        blockId: ROW_ID,
        properties: { backgroundColor: "#111827" },
      },
      context: agentContext,
    });
    expect(applied.isOk).toBe(true);
    if (!applied.isOk) return;
    expect(rowOf(applied.doc).properties.backgroundColor).toBe("#111827");

    // The inverse of a property MERGE is a wholesale replace — that is how a
    // cleared override is expressed. Undo replays it through applyOperation,
    // the same generic path the history spine uses, so the test does too.
    expect(applied.inverse.name).toBe("replaceBlockProperties");
    const undone = applyOperation(applied.doc, applied.inverse);
    expect(undone.isOk).toBe(true);
    if (!undone.isOk) return;
    // Back to a row with no overrides at all — not merely a different color.
    expect(rowOf(undone.doc).properties).toEqual({});
  });

  it("rejects a property the row schema does not define", () => {
    const doc = createSampleDocument();
    const result = updateBlockPropertiesAction.run({
      doc,
      input: {
        name: "updateBlockProperties",
        blockId: ROW_ID,
        properties: { widthPercent: 50 },
      },
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
  });
});
