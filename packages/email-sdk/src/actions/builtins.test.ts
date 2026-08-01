import { describe, expect, it } from "vitest";
import { applyOperation } from "../operations/apply";
import { OPERATION_NAMES } from "../operations/ops";
import { createSampleDocument } from "../store/document";
import {
  contentEmailActions,
  createDraftAction,
  createPersonaAction,
  editorEmailActions,
  emailActionRegistry,
  generateImageAction,
  goToVersionAction,
  openPanelAction,
  redoAction,
  sendTestEmailAction,
  showPreviewAction,
  undoAction,
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
  it("ships the §3.4 stubs, generateImage, and the agent-parity UI actions", () => {
    expect(editorEmailActions.map((action) => action.name)).toEqual([
      "showPreview",
      "sendTestEmail",
      "generateImage",
      "openPanel",
      "undo",
      "redo",
      "goToVersion",
      "createDraft",
      "createPersona",
    ]);
    for (const action of editorEmailActions) {
      expect(action.kind).toBe("editor");
    }
  });

  it("gates exactly sendTestEmail and goToVersion behind approval", () => {
    const approvalGatedNames = editorEmailActions
      .filter((action) => action.needsApproval !== false)
      .map((action) => action.name);
    expect(approvalGatedNames.sort()).toEqual(["goToVersion", "sendTestEmail"]);
  });

  it("keeps generateImage sequential (one billed model call at a time)", () => {
    expect(generateImageAction.parallelSafe).toBe(false);
    expect(generateImageAction.readOnly).toBe(false);
  });

  it("keeps every agent-parity UI action sequential and non-readOnly", () => {
    const parityActions = [
      openPanelAction,
      undoAction,
      redoAction,
      goToVersionAction,
      createDraftAction,
      createPersonaAction,
    ];
    for (const action of parityActions) {
      expect(action.parallelSafe).toBe(false);
      expect(action.readOnly).toBe(false);
    }
  });
});

/** 11 op-mirroring content + styleTextSpan + scaffoldSection + 9 editor actions. */
const BUILTIN_ACTION_COUNT = 24;

describe("emailActionRegistry", () => {
  it(`registers all ${BUILTIN_ACTION_COUNT} built-ins and looks them up by name`, () => {
    expect(emailActionRegistry.actions).toHaveLength(BUILTIN_ACTION_COUNT);
    expect(getAction(emailActionRegistry, "updateText")?.kind).toBe("content");
    expect(getAction(emailActionRegistry, "styleTextSpan")?.kind).toBe("content");
    expect(getAction(emailActionRegistry, "scaffoldSection")?.kind).toBe("content");
    expect(getAction(emailActionRegistry, "sendTestEmail")?.kind).toBe("editor");
    expect(getAction(emailActionRegistry, "generateImage")?.kind).toBe("editor");
    expect(getAction(emailActionRegistry, "openPanel")?.kind).toBe("editor");
    expect(getAction(emailActionRegistry, "undo")?.kind).toBe("editor");
    expect(getAction(emailActionRegistry, "redo")?.kind).toBe("editor");
    expect(getAction(emailActionRegistry, "goToVersion")?.kind).toBe("editor");
    expect(getAction(emailActionRegistry, "createDraft")?.kind).toBe("editor");
    expect(getAction(emailActionRegistry, "createPersona")?.kind).toBe("editor");
  });

  it("generates a tool definition for every action", () => {
    const definitions = toAISDKToolDefinitions(emailActionRegistry);
    expect(definitions).toHaveLength(BUILTIN_ACTION_COUNT);
    expect(new Set(definitions.map((definition) => definition.name)).size).toBe(
      BUILTIN_ACTION_COUNT,
    );
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

  it("dispatches generateImage into the unfulfilled intent command", () => {
    const result = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "generateImage",
      input: { blockId: "img_a1b2", prompt: "A sunrise over mountains" },
      context: agentContext,
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // No src/alt yet — the app executor fulfills those after generation+upload.
    expect(result.command).toEqual({
      type: "generateImage",
      blockId: "img_a1b2",
      prompt: "A sunrise over mountains",
    });
    expect(result.isApprovalRequired).toBe(false);
  });

  it("rejects generateImage inputs with a non-image block id or empty prompt", () => {
    const withWrongBlockKind = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "generateImage",
      input: { blockId: "txt_e5f6", prompt: "A sunrise" },
      context: agentContext,
    });
    expect(withWrongBlockKind.isOk).toBe(false);

    const withEmptyPrompt = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "generateImage",
      input: { blockId: "img_a1b2", prompt: "" },
      context: agentContext,
    });
    expect(withEmptyPrompt.isOk).toBe(false);
    if (withEmptyPrompt.isOk) return;
    expect(withEmptyPrompt.failureKind).toBe("retryable");
    expect(withEmptyPrompt.errors[0]!.code).toBe("op_validation_failed");
  });

  it("dispatches openPanel into a typed command and rejects unknown panels", () => {
    const opened = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "openPanel",
      input: { panel: "theme" },
      context: agentContext,
    });
    expect(opened.isOk).toBe(true);
    if (!opened.isOk) return;
    expect(opened.command).toEqual({ type: "openPanel", panel: "theme" });
    expect(opened.isApprovalRequired).toBe(false);

    const unknownPanel = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "openPanel",
      input: { panel: "settings" },
      context: agentContext,
    });
    expect(unknownPanel.isOk).toBe(false);
    if (unknownPanel.isOk) return;
    expect(unknownPanel.failureKind).toBe("retryable");
    expect(unknownPanel.errors[0]!.code).toBe("op_validation_failed");
  });

  it("dispatches undo/redo (empty input) into their typed commands", () => {
    const undone = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "undo",
      input: {},
      context: agentContext,
    });
    expect(undone.isOk).toBe(true);
    if (!undone.isOk) return;
    expect(undone.command).toEqual({ type: "undo" });

    const redone = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "redo",
      input: {},
      context: agentContext,
    });
    expect(redone.isOk).toBe(true);
    if (!redone.isOk) return;
    expect(redone.command).toEqual({ type: "redo" });
  });

  it("dispatches goToVersion with the approval gate resolved true", () => {
    const result = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "goToVersion",
      input: { version: 12 },
      context: agentContext,
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.command).toEqual({ type: "goToVersion", version: 12 });
    expect(result.isApprovalRequired).toBe(true);
  });

  it("resolves createDraft's count (default 1) and caps it at 5", () => {
    const withDefault = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "createDraft",
      input: {},
      context: agentContext,
    });
    expect(withDefault.isOk).toBe(true);
    if (!withDefault.isOk) return;
    expect(withDefault.command).toEqual({ type: "createDraft", count: 1 });

    const overCap = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "createDraft",
      input: { count: 9 },
      context: agentContext,
    });
    expect(overCap.isOk).toBe(false);
    if (overCap.isOk) return;
    expect(overCap.failureKind).toBe("retryable");
  });

  it("dispatches createPersona into the unfulfilled intent command (no slug yet)", () => {
    const result = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "createPersona",
      input: {
        name: "Accessibility Advocate",
        description: "Reviews the email for accessibility problems.",
        behavior: "Watch for missing alt text and low-contrast color pairs.",
      },
      context: agentContext,
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // No slug yet — the app executor fulfills it after the Convex insert.
    expect(result.command).toEqual({
      type: "createPersona",
      name: "Accessibility Advocate",
      description: "Reviews the email for accessibility problems.",
      behavior: "Watch for missing alt text and low-contrast color pairs.",
    });
    expect(result.isApprovalRequired).toBe(false);
  });
});
