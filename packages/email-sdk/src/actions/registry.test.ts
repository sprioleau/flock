import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyOperation, type OperationErrorCode } from "../operations/apply";
import { removeBlockOperationSchema, updateBlockPropertiesOperationSchema } from "../operations/ops";
import { createSampleDocument } from "../store/document";
import type { ActionContext } from "./context";
import { defineEmailAction } from "./define";
import { sendTestEmailInputSchema, showPreviewInputSchema } from "./editor-commands";
import {
  createActionRegistry,
  dispatchAnalysisAction,
  dispatchContentAction,
  dispatchEditorAction,
  getAction,
  toAISDKToolDefinitions,
} from "./registry";
import {
  ACTION_ERROR_FAILURE_KINDS,
  DISPATCH_ERROR_FAILURE_KINDS,
  OPERATION_ERROR_FAILURE_KINDS,
  classifyActionErrors,
} from "./taxonomy";

const agentContext: ActionContext = {
  caller: "tool",
  authorId: "agent_thread_42",
  author: "agent",
  batchId: "batch_7",
  threadId: "thread_42",
};

const userContext: ActionContext = {
  caller: "frontend",
  authorId: "user_123",
  author: "user",
};

const updateBlockPropertiesAction = defineEmailAction({
  name: "updateBlockProperties",
  description: "Update named properties on a block.",
  kind: "content",
  schema: updateBlockPropertiesOperationSchema,
  readOnly: false,
  parallelSafe: true,
  needsApproval: false,
  run: applyOperation,
});

const removeBlockAction = defineEmailAction({
  name: "removeBlock",
  description: "Remove a block and its descendants.",
  kind: "content",
  schema: removeBlockOperationSchema,
  readOnly: false,
  parallelSafe: false,
  needsApproval: false,
  run: applyOperation,
});

const showPreviewAction = defineEmailAction({
  name: "showPreview",
  description: "Switch the canvas preview viewport.",
  kind: "editor",
  schema: showPreviewInputSchema,
  readOnly: false,
  parallelSafe: false,
  needsApproval: false,
  run: (input) => ({ type: "showPreview" as const, mode: input.mode }),
});

const sendTestEmailAction = defineEmailAction({
  name: "sendTestEmail",
  description: "Send a test email to a recipient.",
  kind: "editor",
  schema: sendTestEmailInputSchema,
  readOnly: false,
  parallelSafe: false,
  needsApproval: (input, context) =>
    context.author === "agent" || !input.to.endsWith("@flock.test"),
  run: (input) => ({ type: "sendTestEmail" as const, to: input.to }),
});

const registry = createActionRegistry([
  updateBlockPropertiesAction,
  removeBlockAction,
  showPreviewAction,
  sendTestEmailAction,
]);

describe("createActionRegistry / getAction", () => {
  it("looks actions up by name and returns undefined for unknown names", () => {
    expect(getAction(registry, "removeBlock")).toBe(removeBlockAction);
    expect(getAction(registry, "showPreview")).toBe(showPreviewAction);
    expect(getAction(registry, "nope")).toBeUndefined();
  });

  it("preserves registration order in actions", () => {
    expect(registry.actions.map((action) => action.name)).toEqual([
      "updateBlockProperties",
      "removeBlock",
      "showPreview",
      "sendTestEmail",
    ]);
  });

  it("throws on duplicate action names", () => {
    expect(() => createActionRegistry([removeBlockAction, removeBlockAction])).toThrow(
      /duplicate action name "removeBlock"/,
    );
  });
});

describe("toAISDKToolDefinitions", () => {
  it("emits one plain-data tool definition per action", () => {
    const definitions = toAISDKToolDefinitions(registry);
    expect(definitions).toHaveLength(4);
    for (const definition of definitions) {
      expect(definition.name).toBeTruthy();
      expect(definition.description).toBeTruthy();
      expect(definition.inputSchema).toBeInstanceOf(z.ZodType);
    }
  });

  it("advertises the COMPACT agentInputSchema, not the full schema", () => {
    const compactSchema = z.object({ blockId: z.string() });
    const divergentAction = defineEmailAction({
      name: "removeBlockCompact",
      description: "Remove a block, advertised compactly.",
      kind: "content",
      schema: removeBlockOperationSchema,
      agentInputSchema: compactSchema,
      readOnly: false,
      parallelSafe: false,
      needsApproval: false,
      run: applyOperation,
    });
    const [definition] = toAISDKToolDefinitions(createActionRegistry([divergentAction]));
    expect(definition!.inputSchema).toBe(compactSchema);
    expect(definition!.inputSchema).not.toBe(removeBlockOperationSchema);
  });

  it("passes needsApproval through, boolean or predicate", () => {
    const definitions = toAISDKToolDefinitions(registry);
    const showPreviewDefinition = definitions.find((d) => d.name === "showPreview");
    const sendTestEmailDefinition = definitions.find((d) => d.name === "sendTestEmail");
    expect(showPreviewDefinition!.needsApproval).toBe(false);
    expect(typeof sendTestEmailDefinition!.needsApproval).toBe("function");
  });
});

describe("dispatchContentAction", () => {
  it("applies the op and returns doc + canonical op + inverse", () => {
    const doc = createSampleDocument();
    const input = {
      name: "updateBlockProperties",
      blockId: "txt_e5f6",
      properties: { paddingTop: 32 },
    };
    const result = dispatchContentAction({
      registry,
      doc,
      name: "updateBlockProperties",
      input,
      context: agentContext,
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect((result.doc.txt_e5f6!.properties as { paddingTop?: number }).paddingTop).toBe(32);
    // The input document is untouched.
    expect((doc.txt_e5f6!.properties as { paddingTop?: number }).paddingTop).toBe(24);
    expect(result.op).toEqual(input);
    expect(result.inverse.name).toBe("replaceBlockProperties");
  });

  /*
    The dispatcher used to hand back a "ready-to-persist" op-log entry: a
    second representation of the row that only the write path ever authors.
    Nothing persisted it, and it could not even carry `undoOwnerId`, so a
    caller reading provenance off it read a strictly lossy copy of the context
    it had itself just passed in. These two tests pin the replacement: the
    provenance comes back BY IDENTITY, whole, so persisting is a forward of
    one value rather than a re-assembly from two.
  */
  it("echoes the dispatch context back by identity, undoOwnerId included", () => {
    const doc = createSampleDocument();
    const contextWithUndoOwner: ActionContext = { ...agentContext, undoOwnerId: "user_123" };
    const result = dispatchContentAction({
      registry,
      doc,
      name: "updateBlockProperties",
      input: { name: "updateBlockProperties", blockId: "txt_e5f6", properties: { paddingTop: 32 } },
      context: contextWithUndoOwner,
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.context).toBe(contextWithUndoOwner);
    expect(result.context.undoOwnerId).toBe("user_123");
  });

  it("returns nothing shaped like a persistable row", () => {
    const doc = createSampleDocument();
    const result = dispatchContentAction({
      registry,
      doc,
      name: "removeBlock",
      input: { name: "removeBlock", blockId: "sec_c3d4" },
      context: userContext,
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result).not.toHaveProperty("logEntry");
    // No entry id, no timestamp, no version — the write path owns all three.
    expect(Object.keys(result).sort()).toEqual(["context", "doc", "inverse", "isOk", "op"]);
  });

  it("fails retryable with unknown_action for an unregistered name", () => {
    const result = dispatchContentAction({
      registry,
      doc: createSampleDocument(),
      name: "nope",
      input: {},
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("retryable");
    expect(result.errors[0]!.code).toBe("unknown_action");
    expect(result.errors[0]!.message).toContain("updateBlockProperties");
  });

  it("fails terminal with wrong_action_kind when given an editor action", () => {
    const result = dispatchContentAction({
      registry,
      doc: createSampleDocument(),
      name: "showPreview",
      input: { mode: "mobile" },
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("terminal");
    expect(result.errors[0]!.code).toBe("wrong_action_kind");
  });

  it("validates against the FULL schema even when the compact schema would accept the input", () => {
    const compactSchema = z.object({ blockId: z.string() });
    const divergentAction = defineEmailAction({
      name: "removeBlockCompact",
      description: "Remove a block, advertised compactly.",
      kind: "content",
      schema: removeBlockOperationSchema,
      agentInputSchema: compactSchema,
      readOnly: false,
      parallelSafe: false,
      needsApproval: false,
      run: applyOperation,
    });
    const divergentRegistry = createActionRegistry([divergentAction]);
    const compactOnlyInput = { blockId: "sec_a1b2" }; // passes compact, missing `name` for full
    expect(compactSchema.safeParse(compactOnlyInput).success).toBe(true);
    const result = dispatchContentAction({
      registry: divergentRegistry,
      doc: createSampleDocument(),
      name: "removeBlockCompact",
      input: compactOnlyInput,
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("retryable");
    expect(result.errors[0]!.code).toBe("op_validation_failed");
  });

  it("classifies apply failures as retryable with the structured 1.3 errors", () => {
    const result = dispatchContentAction({
      registry,
      doc: createSampleDocument(),
      name: "removeBlock",
      input: { name: "removeBlock", blockId: "sec_none" },
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("retryable");
    expect(result.errors[0]!.code).toBe("target_not_found");
    expect(result.errors[0]!.blockId).toBe("sec_none");
  });

  it("classifies integrity_check_failed as terminal", () => {
    const brokenAction = defineEmailAction({
      name: "alwaysBreaksIntegrity",
      description: "Always reports an integrity breach (test double).",
      kind: "content",
      schema: removeBlockOperationSchema,
      readOnly: false,
      parallelSafe: false,
      needsApproval: false,
      run: () => ({
        isOk: false,
        errors: [{ code: "integrity_check_failed", message: "invariant breach" }],
      }),
    });
    const result = dispatchContentAction({
      registry: createActionRegistry([brokenAction]),
      doc: createSampleDocument(),
      name: "alwaysBreaksIntegrity",
      input: { name: "removeBlock", blockId: "sec_a1b2" },
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("terminal");
    expect(result.errors[0]!.code).toBe("integrity_check_failed");
  });
});

describe("dispatchEditorAction", () => {
  it("produces the typed client command and resolves the approval gate", () => {
    const result = dispatchEditorAction({
      registry,
      name: "showPreview",
      input: { mode: "mobile" },
      context: userContext,
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.command).toEqual({ type: "showPreview", mode: "mobile" });
    expect(result.isApprovalRequired).toBe(false);
  });

  it("resolves a needsApproval predicate against input and provenance", () => {
    const internalSend = dispatchEditorAction({
      registry,
      name: "sendTestEmail",
      input: { to: "me@flock.test" },
      context: userContext,
    });
    expect(internalSend.isOk).toBe(true);
    if (!internalSend.isOk) return;
    expect(internalSend.isApprovalRequired).toBe(false);

    const externalSend = dispatchEditorAction({
      registry,
      name: "sendTestEmail",
      input: { to: "someone@example.com" },
      context: userContext,
    });
    expect(externalSend.isOk).toBe(true);
    if (!externalSend.isOk) return;
    expect(externalSend.isApprovalRequired).toBe(true);

    const agentSend = dispatchEditorAction({
      registry,
      name: "sendTestEmail",
      input: { to: "me@flock.test" },
      context: agentContext,
    });
    expect(agentSend.isOk).toBe(true);
    if (!agentSend.isOk) return;
    expect(agentSend.isApprovalRequired).toBe(true);
  });

  it("fails retryable on input that misses the full schema", () => {
    const result = dispatchEditorAction({
      registry,
      name: "showPreview",
      input: { mode: "tablet" },
      context: userContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("retryable");
    expect(result.errors[0]!.code).toBe("op_validation_failed");
  });

  it("fails terminal with wrong_action_kind when given a content action", () => {
    const result = dispatchEditorAction({
      registry,
      name: "removeBlock",
      input: { name: "removeBlock", blockId: "sec_a1b2" },
      context: userContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("terminal");
    expect(result.errors[0]!.code).toBe("wrong_action_kind");
  });

  it("fails retryable with unknown_action for an unregistered name", () => {
    const result = dispatchEditorAction({ registry, name: "nope", input: {}, context: userContext });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("retryable");
    expect(result.errors[0]!.code).toBe("unknown_action");
  });
});

describe("stop-vs-retry taxonomy", () => {
  it("maps every 1.3 error code, with only integrity_check_failed terminal", () => {
    const operationErrorCodes: OperationErrorCode[] = [
      "op_validation_failed",
      "target_not_found",
      "duplicate_block_id",
      "index_out_of_range",
      "nesting_violation",
      "root_not_allowed",
      "children_not_permutation",
      "wrong_block_type",
      "schema_validation_failed",
      "integrity_check_failed",
    ];
    expect(Object.keys(OPERATION_ERROR_FAILURE_KINDS).sort()).toEqual(
      [...operationErrorCodes].sort(),
    );
    for (const code of operationErrorCodes) {
      expect(OPERATION_ERROR_FAILURE_KINDS[code]).toBe(
        code === "integrity_check_failed" ? "terminal" : "retryable",
      );
    }
  });

  it("adds the dispatch-level codes to the combined map", () => {
    expect(DISPATCH_ERROR_FAILURE_KINDS.unknown_action).toBe("retryable");
    expect(DISPATCH_ERROR_FAILURE_KINDS.wrong_action_kind).toBe("terminal");
    expect(DISPATCH_ERROR_FAILURE_KINDS.span_not_found).toBe("retryable");
    expect(DISPATCH_ERROR_FAILURE_KINDS.unknown_section_template).toBe("retryable");
    /*
      An authorization denial is a STOP, not a repair hint: the arguments were
      never the problem, so a retry round would only teach the model to
      rephrase its way at a permission check.
    */
    expect(DISPATCH_ERROR_FAILURE_KINDS.not_authorized).toBe("terminal");
    expect(Object.keys(ACTION_ERROR_FAILURE_KINDS)).toHaveLength(15);
  });

  it("classifies a batch as terminal when ANY error is terminal", () => {
    expect(classifyActionErrors([{ code: "target_not_found" }])).toBe("retryable");
    expect(
      classifyActionErrors([{ code: "target_not_found" }, { code: "integrity_check_failed" }]),
    ).toBe("terminal");
    expect(classifyActionErrors([])).toBe("retryable");
  });
});

// ---------------------------------------------------------------------------
// Analysis dispatch + the authorization gate on EVERY path
// ---------------------------------------------------------------------------

const countBlocksInputSchema = z.strictObject({ prefix: z.string() });

/** Records whether the action body executed — the assertion that matters. */
interface RunSpy {
  hasRun: boolean;
}

function defineAnalysisSpy(spy: RunSpy, shouldAuthorize: boolean | undefined) {
  return defineEmailAction({
    name: "countBlocks",
    description: "Count blocks whose id starts with a prefix.",
    kind: "analysis",
    schema: countBlocksInputSchema,
    readOnly: true,
    parallelSafe: true,
    needsApproval: false,
    ...(shouldAuthorize === undefined ? {} : { authorize: shouldAuthorize }),
    run: (doc, input) => {
      spy.hasRun = true;
      return Object.keys(doc).filter((blockId) => blockId.startsWith(input.prefix)).length;
    },
  });
}

describe("dispatchAnalysisAction", () => {
  it("validates against the FULL schema and returns the run result", () => {
    const spy: RunSpy = { hasRun: false };
    const analysisRegistry = createActionRegistry([defineAnalysisSpy(spy, undefined)]);
    const result = dispatchAnalysisAction({
      registry: analysisRegistry,
      doc: createSampleDocument(),
      name: "countBlocks",
      input: { prefix: "sec_" },
      context: agentContext,
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(spy.hasRun).toBe(true);
    expect(result.data).toBe(
      Object.keys(createSampleDocument()).filter((blockId) => blockId.startsWith("sec_")).length,
    );
    expect(result.isApprovalRequired).toBe(false);
  });

  it("fails retryable on input that misses the full schema, without running", () => {
    /*
      This is the gap the missing dispatcher left open: the chat route called
      `run` itself, so nothing re-validated the model's payload against the
      FULL schema the way the other two kinds do.
    */
    const spy: RunSpy = { hasRun: false };
    const analysisRegistry = createActionRegistry([defineAnalysisSpy(spy, undefined)]);
    const result = dispatchAnalysisAction({
      registry: analysisRegistry,
      doc: createSampleDocument(),
      name: "countBlocks",
      input: { prefix: 7 },
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("retryable");
    expect(result.errors[0]!.code).toBe("op_validation_failed");
    expect(spy.hasRun).toBe(false);
  });

  it("fails terminal with wrong_action_kind when given an editor action", () => {
    const result = dispatchAnalysisAction({
      registry,
      doc: createSampleDocument(),
      name: "showPreview",
      input: { mode: "desktop" },
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("terminal");
    expect(result.errors[0]!.code).toBe("wrong_action_kind");
  });

  it("fails retryable with unknown_action for an unregistered name", () => {
    const result = dispatchAnalysisAction({
      registry,
      doc: createSampleDocument(),
      name: "nope",
      input: {},
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("retryable");
    expect(result.errors[0]!.code).toBe("unknown_action");
  });

  it("hands an async run result back unawaited, so async analysis keeps working", () => {
    /*
      fetchWebContent and friends are typed AnalysisEmailAction<S, Promise<T>>
      and do real network I/O. Dispatch stays synchronous — `run` must not
      become async — so the promise itself is what comes back.
    */
    const asyncAction = defineEmailAction({
      name: "fetchSomething",
      description: "An analysis action that does I/O.",
      kind: "analysis",
      schema: z.strictObject({}),
      readOnly: true,
      parallelSafe: true,
      needsApproval: false,
      run: (): Promise<string> => Promise.resolve("fetched"),
    });
    const result = dispatchAnalysisAction({
      registry: createActionRegistry([asyncAction]),
      doc: createSampleDocument(),
      name: "fetchSomething",
      input: {},
      context: agentContext,
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    return expect(result.data).resolves.toBe("fetched");
  });
});

/**
 * The regression that would undo the whole point: a gate honoured on two of
 * three dispatch paths is not a gate, it is a coincidence. One denying action
 * per kind, dispatched through its own dispatcher, asserting the body never
 * ran and the failure is a STOP.
 */
describe("the authorization gate holds on every dispatch path", () => {
  it("denies a content action through dispatchContentAction", () => {
    const spy: RunSpy = { hasRun: false };
    const deniedAction = defineEmailAction({
      name: "removeBlock",
      description: "Remove a block, if allowed.",
      kind: "content",
      schema: removeBlockOperationSchema,
      readOnly: false,
      parallelSafe: false,
      needsApproval: false,
      authorize: (_input, context) => context.author === "user",
      run: (doc, op) => {
        spy.hasRun = true;
        return applyOperation(doc, op);
      },
    });
    const doc = createSampleDocument();
    const result = dispatchContentAction({
      registry: createActionRegistry([deniedAction]),
      doc,
      name: "removeBlock",
      input: { name: "removeBlock", blockId: "sec_a1b2" },
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(spy.hasRun).toBe(false);
    expect(result.failureKind).toBe("terminal");
    expect(result.errors[0]!.code).toBe("not_authorized");
  });

  it("denies an editor action through dispatchEditorAction", () => {
    const spy: RunSpy = { hasRun: false };
    const deniedAction = defineEmailAction({
      name: "showPreview",
      description: "Switch the preview, if allowed.",
      kind: "editor",
      schema: showPreviewInputSchema,
      readOnly: false,
      parallelSafe: false,
      needsApproval: false,
      authorize: (_input, context) => context.author === "user",
      run: (input) => {
        spy.hasRun = true;
        return { type: "showPreview" as const, mode: input.mode };
      },
    });
    const result = dispatchEditorAction({
      registry: createActionRegistry([deniedAction]),
      name: "showPreview",
      input: { mode: "mobile" },
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(spy.hasRun).toBe(false);
    expect(result.failureKind).toBe("terminal");
    expect(result.errors[0]!.code).toBe("not_authorized");
  });

  it("denies an analysis action through dispatchAnalysisAction", () => {
    const spy: RunSpy = { hasRun: false };
    const result = dispatchAnalysisAction({
      registry: createActionRegistry([defineAnalysisSpy(spy, false)]),
      doc: createSampleDocument(),
      name: "countBlocks",
      input: { prefix: "sec_" },
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(spy.hasRun).toBe(false);
    expect(result.failureKind).toBe("terminal");
    expect(result.errors[0]!.code).toBe("not_authorized");
  });

  it("lets an allowed caller through on all three paths, unchanged", () => {
    /*
      The additive guarantee, stated positively: a gate that authorizes is
      invisible — same results the ungated actions above produce.
    */
    const contentResult = dispatchContentAction({
      registry,
      doc: createSampleDocument(),
      name: "removeBlock",
      input: { name: "removeBlock", blockId: "sec_a1b2" },
      context: userContext,
    });
    expect(contentResult.isOk).toBe(true);

    const editorResult = dispatchEditorAction({
      registry,
      name: "showPreview",
      input: { mode: "mobile" },
      context: userContext,
    });
    expect(editorResult.isOk).toBe(true);

    const spy: RunSpy = { hasRun: false };
    const analysisResult = dispatchAnalysisAction({
      registry: createActionRegistry([defineAnalysisSpy(spy, true)]),
      doc: createSampleDocument(),
      name: "countBlocks",
      input: { prefix: "sec_" },
      context: userContext,
    });
    expect(analysisResult.isOk).toBe(true);
    expect(spy.hasRun).toBe(true);
  });
});
