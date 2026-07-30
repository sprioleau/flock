import { describe, expect, it } from "vitest";
import { applyOperation } from "../operations/apply";
import { OPERATION_NAMES } from "../operations/ops";
import { createSampleDocument } from "../store/document";
import {
  contentEmailActions,
  editorEmailActions,
  emailActionRegistry,
  sendTestEmailAction,
  showPreviewAction,
} from "./builtins";
import type { ActionContext } from "./context";
import {
  dispatchContentAction,
  dispatchEditorAction,
  getAction,
  toAISDKToolDefinitions,
} from "./registry";

const agentContext: ActionContext = {
  caller: "tool",
  authorId: "agent_thread_1",
  author: "agent",
  batchId: "batch_1",
  threadId: "thread_1",
};

describe("built-in content actions", () => {
  it("covers every 1.3 operation, one action per op, named after it", () => {
    expect(contentEmailActions.map((action) => action.name)).toEqual([...OPERATION_NAMES]);
  });

  it("all are non-readOnly, unapproved content actions with the op schema as full schema", () => {
    for (const action of contentEmailActions) {
      expect(action.kind).toBe("content");
      expect(action.readOnly).toBe(false);
      expect(action.needsApproval).toBe(false);
      // No compact variants yet — Phase 3 tunes these; advertise = validate for now.
      expect(action.agentInputSchema).toBe(action.schema);
      // Descriptions are single-sourced from the op schemas' .describe() text.
      expect(action.description.length).toBeGreaterThan(0);
    }
  });

  it("marks exactly the distinct-target ops parallelSafe", () => {
    const parallelSafeNames = contentEmailActions
      .filter((action) => action.parallelSafe)
      .map((action) => action.name);
    expect(parallelSafeNames.sort()).toEqual([
      "replaceBlockProperties",
      "updateBlockProperties",
      "updateText",
    ]);
  });
});

describe("built-in editor actions", () => {
  it("ships the two §3.4 stubs", () => {
    expect(editorEmailActions.map((action) => action.name)).toEqual([
      "showPreview",
      "sendTestEmail",
    ]);
    expect(showPreviewAction.kind).toBe("editor");
    expect(sendTestEmailAction.kind).toBe("editor");
  });

  it("gates sendTestEmail behind approval, but not showPreview", () => {
    expect(sendTestEmailAction.needsApproval).toBe(true);
    expect(showPreviewAction.needsApproval).toBe(false);
  });
});

describe("emailActionRegistry", () => {
  it("registers all 14 built-ins and looks them up by name", () => {
    expect(emailActionRegistry.actions).toHaveLength(14);
    expect(getAction(emailActionRegistry, "updateText")?.kind).toBe("content");
    expect(getAction(emailActionRegistry, "styleTextSpan")?.kind).toBe("content");
    expect(getAction(emailActionRegistry, "sendTestEmail")?.kind).toBe("editor");
  });

  it("generates a tool definition for every action", () => {
    const definitions = toAISDKToolDefinitions(emailActionRegistry);
    expect(definitions).toHaveLength(14);
    expect(new Set(definitions.map((definition) => definition.name)).size).toBe(14);
  });

  it("dispatches a content action end to end and its inverse restores the doc", () => {
    const doc = createSampleDocument();
    const result = dispatchContentAction({
      registry: emailActionRegistry,
      doc,
      name: "updateBlockProperties",
      input: { name: "updateBlockProperties", blockId: "txt_e5f6", properties: { paddingTop: 32 } },
      context: agentContext,
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect((result.doc.txt_e5f6!.properties as { paddingTop?: number }).paddingTop).toBe(32);
    expect(result.logEntry.batchId).toBe("batch_1");
    // Undo via the generated inverse round-trips exactly.
    const undone = applyOperation(result.doc, result.inverse);
    expect(undone.isOk).toBe(true);
    if (!undone.isOk) return;
    expect(undone.doc).toEqual(doc);
  });

  it("surfaces 1.3 repair hints through dispatch (root removal is retryable)", () => {
    const result = dispatchContentAction({
      registry: emailActionRegistry,
      doc: createSampleDocument(),
      name: "removeBlock",
      input: { name: "removeBlock", blockId: "root" },
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("retryable");
    expect(result.errors[0]!.code).toBe("root_not_allowed");
  });

  it("dispatches the editor stubs into typed commands", () => {
    const previewResult = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "showPreview",
      input: { mode: "desktop" },
      context: agentContext,
    });
    expect(previewResult.isOk).toBe(true);
    if (!previewResult.isOk) return;
    expect(previewResult.command).toEqual({ type: "showPreview", mode: "desktop" });
    expect(previewResult.isApprovalRequired).toBe(false);

    const sendResult = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "sendTestEmail",
      input: { to: "reviewer@example.com" },
      context: agentContext,
    });
    expect(sendResult.isOk).toBe(true);
    if (!sendResult.isOk) return;
    expect(sendResult.command).toEqual({ type: "sendTestEmail", to: "reviewer@example.com" });
    expect(sendResult.isApprovalRequired).toBe(true);
  });

  it("rejects a sendTestEmail input that is not an email address", () => {
    const result = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "sendTestEmail",
      input: { to: "not-an-email" },
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("retryable");
    expect(result.errors[0]!.code).toBe("op_validation_failed");
  });
});
