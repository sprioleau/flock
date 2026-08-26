import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyOperation } from "../operations/apply";
import { removeBlockOperationSchema } from "../operations/ops";
import type { EmailDocument } from "../store/document";
import type { ActionContext } from "./context";
import {
  ActionAuthorizationError,
  EMAIL_ACTION_KINDS,
  defineEmailAction,
  resolveAuthorize,
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
      resultSource: "server" as const,
      schema: showPreviewInputSchema,
      readOnly: false,
      parallelSafe: false,
      needsApproval: false,
      run: (input): ShowPreviewCommand => ({ type: "showPreview", mode: input.mode }),
    });
    expect(action.run({ input: { mode: "mobile" }, context: toolContext })).toEqual({
      type: "showPreview",
      mode: "mobile",
    });
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
    expect(action.run({ doc: {}, input: {}, context: toolContext })).toBe(0);
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

/**
 * The authorization gate. What each test here is pinning:
 *
 * The gate is composed INTO `run`, so these assertions are about the callable
 * every dispatch site reaches, not about a flag someone has to remember to
 * consult. The load-bearing assertion in the denial cases is `hasRunBody`
 * staying false — "an error came back" would also be true of a gate that ran
 * the body and complained afterwards, which is not a gate.
 */
describe("authorize", () => {
  it("leaves an action with no authorize exactly as it was", () => {
    let hasRunBody = false;
    const action = defineEmailAction({
      name: "ungated",
      description: "An action with no authorize gate.",
      kind: "editor",
      resultSource: "server" as const,
      schema: showPreviewInputSchema,
      readOnly: false,
      parallelSafe: false,
      needsApproval: false,
      run: (input): ShowPreviewCommand => {
        hasRunBody = true;
        return { type: "showPreview", mode: input.mode };
      },
    });
    /*
      Allowed by default: the invocation goes straight through to the body.
    */
    expect(action.run({ input: { mode: "mobile" }, context: toolContext })).toEqual({
      type: "showPreview",
      mode: "mobile",
    });
    expect(hasRunBody).toBe(true);
    expect(action.authorize).toBeUndefined();
    expect(resolveAuthorize({ action, input: { mode: "mobile" }, context: toolContext })).toBe(true);
  });

  it("refuses before the body runs when a predicate denies", () => {
    let hasRunBody = false;
    const action = defineEmailAction({
      name: "humansOnly",
      description: "An action only a human may invoke.",
      kind: "editor",
      resultSource: "server" as const,
      schema: showPreviewInputSchema,
      readOnly: false,
      parallelSafe: false,
      needsApproval: false,
      authorize: (_input, context) => context.author === "user",
      run: (input): ShowPreviewCommand => {
        hasRunBody = true;
        return { type: "showPreview", mode: input.mode };
      },
    });
    expect(() => action.run({ input: { mode: "mobile" }, context: toolContext })).toThrow(
      ActionAuthorizationError,
    );
    /*
      The point of the gate: the body never executed.
    */
    expect(hasRunBody).toBe(false);
    /*
      The same action, an allowed caller: the body does run.
    */
    expect(action.run({ input: { mode: "mobile" }, context: frontendContext })).toEqual({
      type: "showPreview",
      mode: "mobile",
    });
    expect(hasRunBody).toBe(true);
  });

  it("refuses a gated action invoked with no context at all", () => {
    let hasRunBody = false;
    const action = defineEmailAction({
      name: "needsCaller",
      description: "An action that must know who is calling.",
      kind: "analysis",
      schema: z.strictObject({}),
      readOnly: true,
      parallelSafe: true,
      needsApproval: false,
      authorize: (_input, context) => context.authorId.length > 0,
      run: () => {
        hasRunBody = true;
        return 1;
      },
    });
    /*
      The invocation type REQUIRES a context, so no TS caller can reach this
      branch at all — which is the strongest form of the guarantee. What is
      left to pin is the JS-caller path, tested the same way the neighbouring
      runtime-caller invariants are: it FAILS CLOSED rather than defaulting
      open, because a gate that opens when it cannot see is not a gate.
    */
    const uncheckedRun = action.run as unknown as (invocation: {
      doc: EmailDocument;
      input: object;
    }) => number;
    expect(() => uncheckedRun({ doc: {}, input: {} })).toThrow(/without an ActionContext/);
    expect(hasRunBody).toBe(false);
  });

  it("carries a terminal not_authorized code on the refusal", () => {
    const action = defineEmailAction({
      name: "neverAllowed",
      description: "An action nobody may invoke.",
      kind: "editor",
      resultSource: "server" as const,
      schema: showPreviewInputSchema,
      readOnly: false,
      parallelSafe: false,
      needsApproval: false,
      authorize: false,
      run: (input): ShowPreviewCommand => ({ type: "showPreview", mode: input.mode }),
    });
    try {
      action.run({ input: { mode: "desktop" }, context: toolContext });
      expect.unreachable("the gate should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(ActionAuthorizationError);
      if (!(error instanceof ActionAuthorizationError)) return;
      expect(error.code).toBe("not_authorized");
      expect(error.actionName).toBe("neverAllowed");
    }
  });

  it("gates content and analysis runs too, not just editor ones", () => {
    let hasRunContentBody = false;
    const contentAction = defineEmailAction({
      ...contentConfig,
      name: "gatedRemoveBlock",
      authorize: false,
      run: (doc, op) => {
        hasRunContentBody = true;
        return applyOperation(doc, op);
      },
    });
    expect(() =>
      contentAction.run({
        doc: {},
        input: { name: "removeBlock", blockId: "sec_a1b2" },
        context: toolContext,
      }),
    ).toThrow(ActionAuthorizationError);
    expect(hasRunContentBody).toBe(false);

    let hasRunAnalysisBody = false;
    const analysisAction = defineEmailAction({
      name: "gatedCountBlocks",
      description: "Count the blocks, if allowed.",
      kind: "analysis",
      schema: z.strictObject({}),
      readOnly: true,
      parallelSafe: true,
      needsApproval: false,
      authorize: false,
      run: (doc) => {
        hasRunAnalysisBody = true;
        return Object.keys(doc).length;
      },
    });
    expect(() => analysisAction.run({ doc: {}, input: {}, context: toolContext })).toThrow(
      ActionAuthorizationError,
    );
    expect(hasRunAnalysisBody).toBe(false);
  });

  it("does not put the ungated body on the action for a caller to find", () => {
    const bodySentinel = (input: { mode: "desktop" | "mobile" }): ShowPreviewCommand => ({
      type: "showPreview",
      mode: input.mode,
    });
    const action = defineEmailAction({
      name: "wrappedBody",
      description: "An action whose raw body must not be reachable.",
      kind: "editor",
      resultSource: "server" as const,
      schema: showPreviewInputSchema,
      readOnly: false,
      parallelSafe: false,
      needsApproval: false,
      authorize: false,
      run: bodySentinel,
    });
    /*
      `run` is the WRAPPER, not the hook that was handed in — the raw hook
      lives only in the factory's closure. If this ever becomes `toBe`, the
      gate has been un-composed and every dispatch site is bypassable again.
    */
    expect(action.run).not.toBe(bodySentinel);
    expect(Object.values(action)).not.toContain(bodySentinel);
  });
});

describe("resolveAuthorize", () => {
  it("treats an absent gate as allowed and passes booleans through", () => {
    const ungatedAction = defineEmailAction(contentConfig);
    const deniedAction = defineEmailAction({ ...contentConfig, authorize: false });
    const allowedAction = defineEmailAction({ ...contentConfig, authorize: true });
    expect(resolveAuthorize({ action: ungatedAction, input: {}, context: toolContext })).toBe(true);
    expect(resolveAuthorize({ action: deniedAction, input: {}, context: toolContext })).toBe(false);
    expect(resolveAuthorize({ action: allowedAction, input: {}, context: toolContext })).toBe(true);
  });

  it("evaluates predicates with the validated input and caller provenance", () => {
    const action = defineEmailAction({
      ...contentConfig,
      authorize: (input, context) => context.author === "user" && input.blockId !== "sec_a1b2",
    });
    const input = { name: "removeBlock", blockId: "sec_zzzz" };
    expect(resolveAuthorize({ action, input, context: frontendContext })).toBe(true);
    expect(resolveAuthorize({ action, input, context: toolContext })).toBe(false);
    expect(
      resolveAuthorize({
        action,
        input: { name: "removeBlock", blockId: "sec_a1b2" },
        context: frontendContext,
      }),
    ).toBe(false);
  });
});
