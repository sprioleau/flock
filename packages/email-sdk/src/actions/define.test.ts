import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyOperation } from "../operations/apply";
import { removeBlockOperationSchema } from "../operations/ops";
import type { ActionContext } from "./context";
import {
  EMAIL_ACTION_KINDS,
  defineEmailAction,
  resolveNeedsApproval,
  type AnalysisEmailActionConfig,
  type ContentEmailActionConfig,
} from "./define";
import { showPreviewInputSchema, type ShowPreviewCommand } from "./editor-commands";

const toolContext: ActionContext = {
  caller: "tool",
  authorId: "agent_thread_1",
  author: "agent",
};

const frontendContext: ActionContext = {
  caller: "frontend",
  authorId: "user_123",
  author: "user",
};

const contentConfig = {
  name: "removeBlockTest",
  description: "Remove a block (test action).",
  kind: "content",
  schema: removeBlockOperationSchema,
  readOnly: false,
  parallelSafe: false,
  needsApproval: false,
  run: applyOperation,
} satisfies ContentEmailActionConfig<typeof removeBlockOperationSchema>;

describe("defineEmailAction", () => {
  it("exposes the three action kinds", () => {
    expect(EMAIL_ACTION_KINDS).toEqual(["content", "editor", "analysis"]);
  });

  it("defaults agentInputSchema to the full schema", () => {
    const action = defineEmailAction(contentConfig);
    expect(action.agentInputSchema).toBe(action.schema);
    expect(action.schema).toBe(removeBlockOperationSchema);
  });

  it("keeps a provided compact agentInputSchema distinct from the full schema", () => {
    const compactSchema = z.object({ blockId: z.string() });
    const action = defineEmailAction({ ...contentConfig, agentInputSchema: compactSchema });
    expect(action.agentInputSchema).toBe(compactSchema);
    expect(action.schema).toBe(removeBlockOperationSchema);
  });

  it("returns a frozen definition", () => {
    const action = defineEmailAction(contentConfig);
    expect(Object.isFrozen(action)).toBe(true);
    expect(() => {
      (action as { name: string }).name = "mutated";
    }).toThrow();
  });

  it("supports editor actions whose run produces a typed client command with no doc argument", () => {
    const action = defineEmailAction({
      name: "showPreviewTest",
      description: "Show a preview (test action).",
      kind: "editor",
      schema: showPreviewInputSchema,
      readOnly: false,
      parallelSafe: false,
      needsApproval: false,
      run: (input): ShowPreviewCommand => ({ type: "showPreview", mode: input.mode }),
    });
    expect(action.run({ mode: "mobile" })).toEqual({ type: "showPreview", mode: "mobile" });
  });

  it("supports analysis actions that read the doc and return data", () => {
    const action = defineEmailAction({
      name: "countBlocks",
      description: "Count the blocks in the document.",
      kind: "analysis",
      schema: z.strictObject({}),
      readOnly: true,
      parallelSafe: true,
      needsApproval: false,
      run: (doc) => Object.keys(doc).length,
    });
    expect(action.kind).toBe("analysis");
    expect(action.readOnly).toBe(true);
    expect(action.run({}, {})).toBe(0);
  });

  it.each([
    ["", "empty"],
    ["UpdateBlock", "uppercase start"],
    ["update block", "whitespace"],
    ["update_block", "underscore"],
  ])('rejects invalid action name "%s" (%s)', (invalidName) => {
    expect(() => defineEmailAction({ ...contentConfig, name: invalidName })).toThrow(
      /invalid action name/,
    );
  });

  it("rejects an empty description", () => {
    expect(() => defineEmailAction({ ...contentConfig, description: "   " })).toThrow(
      /non-empty description/,
    );
  });

  it("rejects a content action flagged readOnly (runtime callers)", () => {
    const invalidConfig = {
      ...contentConfig,
      readOnly: true,
    } as unknown as ContentEmailActionConfig<typeof removeBlockOperationSchema>;
    expect(() => defineEmailAction(invalidConfig)).toThrow(/cannot be readOnly/);
  });

  it("rejects an analysis action not flagged readOnly (runtime callers)", () => {
    const invalidConfig = {
      name: "peekBlocks",
      description: "Peek at blocks.",
      kind: "analysis",
      schema: z.strictObject({}),
      readOnly: false,
      parallelSafe: true,
      needsApproval: false,
      run: () => 0,
    } as unknown as AnalysisEmailActionConfig<z.ZodType, number>;
    expect(() => defineEmailAction(invalidConfig)).toThrow(/must be readOnly/);
  });

  it("rejects an unknown kind (runtime callers)", () => {
    const invalidConfig = {
      ...contentConfig,
      kind: "webhook",
    } as unknown as ContentEmailActionConfig<typeof removeBlockOperationSchema>;
    expect(() => defineEmailAction(invalidConfig)).toThrow(/unknown kind/);
  });

  it("rejects a missing run function (runtime callers)", () => {
    const invalidConfig = {
      ...contentConfig,
      run: undefined,
    } as unknown as ContentEmailActionConfig<typeof removeBlockOperationSchema>;
    expect(() => defineEmailAction(invalidConfig)).toThrow(/needs a run function/);
  });
});

describe("resolveNeedsApproval", () => {
  it("passes booleans through", () => {
    const gatedAction = defineEmailAction({ ...contentConfig, needsApproval: true });
    const ungatedAction = defineEmailAction(contentConfig);
    expect(resolveNeedsApproval({ action: gatedAction, input: {}, context: toolContext })).toBe(true);
    expect(resolveNeedsApproval({ action: ungatedAction, input: {}, context: toolContext })).toBe(false);
  });

  it("evaluates predicates with the validated input and caller provenance", () => {
    const action = defineEmailAction({
      ...contentConfig,
      needsApproval: (input, context) =>
        context.author === "agent" || input.blockId === "sec_a1b2",
    });
    expect(
      resolveNeedsApproval({
        action,
        input: { name: "removeBlock", blockId: "sec_zzzz" },
        context: toolContext,
      }),
    ).toBe(true);
    expect(
      resolveNeedsApproval({
        action,
        input: { name: "removeBlock", blockId: "sec_zzzz" },
        context: frontendContext,
      }),
    ).toBe(false);
    expect(
      resolveNeedsApproval({
        action,
        input: { name: "removeBlock", blockId: "sec_a1b2" },
        context: frontendContext,
      }),
    ).toBe(true);
  });
});
