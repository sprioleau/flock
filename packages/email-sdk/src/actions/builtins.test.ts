import { describe, expect, it } from "vitest";
import { applyOperation } from "../operations/apply";
import { OPERATION_NAMES } from "../operations/ops";
import { createSampleDocument } from "../store/document";
import {
  contentEmailActions,
  applyThemeToDraftAction,
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
import { resolveAuthorize } from "./define";
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

/*
  The SAME agent turn, on a deployment where the server resolved who is behind
  it. `authorId` is unchanged — attribution does not move — and the added fact
  is the one no surface can write for itself.
*/
const verifiedAgentContext: ActionContext = {
  ...agentContext,
  verifiedCaller: { isVerified: true, ownerId: "user_9f2a" },
};

/* A deployment with identity switched off entirely: nobody has an id here. */
const noIdentitySystemContext: ActionContext = {
  ...agentContext,
  verifiedCaller: { isVerified: false, reason: "no_identity_system" },
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
      "applyThemeToDraft",
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
      applyThemeToDraftAction,
    ];
    for (const action of parityActions) {
      expect(action.parallelSafe).toBe(false);
      expect(action.readOnly).toBe(false);
    }
  });
});

/**
 * 11 op-mirroring content + styleTextSpan + scaffoldSection + 10 editor actions
 * + 1 analysis action (inspectRenderedEmail).
 */
const BUILTIN_ACTION_COUNT = 26;

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
    expect(getAction(emailActionRegistry, "applyThemeToDraft")?.kind).toBe("editor");
    expect(getAction(emailActionRegistry, "inspectRenderedEmail")?.kind).toBe("analysis");
  });

  /*
    WHO IS ALLOWED TO ANSWER FOR EACH EDITOR ACTION. The chat route branches on
    this declaration to decide whether to register a server execute at all, so
    a wrong value here is a fabricated tool result: undo declared "server"
    would put the server back to reporting a history step it never took, which
    is exactly how the agent came to say "I've undone that change for you" over
    an unchanged draft.

    The split is not a taxonomy of "UI-ish" actions — it is a question about
    each action's OUTCOME: can the server observe it? showPreview and openPanel
    are server-result because their command IS the whole outcome; there is no
    fact about them the browser could contradict. undo, redo and createDraft
    are client-result because their outcome is a fact the server cannot see —
    whether a history step existed to take, and which drafts landed under which
    (deduped) names with which sections carrying real copy.
  */
  it("declares the actions whose outcome only the browser can see as client-result", () => {
    const resultSourceByName = Object.fromEntries(
      editorEmailActions.map((action) => [action.name, action.resultSource]),
    );
    expect(resultSourceByName).toEqual({
      showPreview: "server",
      sendTestEmail: "server",
      generateImage: "server",
      openPanel: "server",
      undo: "client",
      redo: "client",
      goToVersion: "server",
      createDraft: "client",
      createPersona: "server",
      /*
        The browser holds the canvas's draft list, the kit's live themes and
        the page this turn read — so it is the only party that can say which
        draft was reached, which theme resolved, and whether that draft's
        globals actually changed. The server could only repeat the reference.
      */
      applyThemeToDraft: "client",
    });
  });

  /*
    The declaration and the RUN must agree, or the flip is cosmetic. A
    client-result editor action's `run` may only produce an intent for the
    browser to carry out — never a report of an outcome — because nothing has
    happened yet at the moment it returns. createDraft's run resolves the
    command; it says nothing about drafts, names, or sections.
  */
  it("gives client-result actions a run that states intent, not outcome", () => {
    const clientResultActions = editorEmailActions.filter(
      (action) => action.resultSource === "client",
    );
    expect(clientResultActions.map((action) => action.name)).toEqual([
      "undo",
      "redo",
      "createDraft",
      "applyThemeToDraft",
    ]);
    const dispatched = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "createDraft",
      input: {
        drafts: [
          { name: "Portfolio", sections: [{ templateId: "hero", params: { headline: "Hello" } }] },
        ],
      },
      context: agentContext,
    });
    expect(dispatched.isOk).toBe(true);
    if (!dispatched.isOk) return;
    /* An intent the browser will carry out — no createdDrafts, no note. */
    expect(Object.keys(dispatched.command).sort()).toEqual([
      "count",
      "drafts",
      "shouldInheritTheme",
      "type",
    ]);
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
    expect(result.context.batchId).toBe("batch_1");
    // Undo via the generated inverse round-trips exactly.
    const undone = applyOperation(result.doc, result.inverse);
    expect(undone.isOk).toBe(true);
    if (!undone.isOk) return;
    expect(undone.doc).toEqual(doc);
  });

  it("dispatching removeBlock defaults the empty-container cascade and returns the explicit flag", () => {
    const doc = createSampleDocument();
    const result = dispatchContentAction({
      registry: emailActionRegistry,
      doc,
      name: "removeBlock",
      // The caller states no cascade choice — the registry resolves it to true.
      input: { name: "removeBlock", blockId: "txt_r7s8" },
      context: agentContext,
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // txt_r7s8 was col_m3n4's only block: the column collapses with it and
    // the surviving column resets to the equal split (width stripped).
    expect(result.doc.col_m3n4).toBeUndefined();
    expect(result.doc.row_k1l2!.childrenIds).toEqual(["col_p5q6"]);
    expect(
      (result.doc.col_p5q6!.properties as { widthPercent?: number }).widthPercent,
    ).toBeUndefined();
    // The RESOLVED op (explicit flag) is what reaches the replayable log.
    expect(result.op).toEqual({
      name: "removeBlock",
      blockId: "txt_r7s8",
      shouldRemoveEmptyAncestors: true,
    });
    // Still one undo step: the single inverse restores the doc exactly.
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
      /* sendTestEmail requires a verified caller; see its own describe block. */
      context: verifiedAgentContext,
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
    // The bare form is unchanged apart from the resolved theme flag: one
    // empty starter draft, no composition plan.
    expect(withDefault.command).toEqual({
      type: "createDraft",
      count: 1,
      shouldInheritTheme: true,
    });

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

/**
 * `sendTestEmail`'s authorization gate — the first `authorize` consumer.
 *
 * `needsApproval` already asks a human to bless a send, but only where a human
 * is present to ask, which is the agent loop and nowhere else. These pin the
 * property that does NOT depend on a chat window being attached.
 */
describe("sendTestEmail authorization", () => {
  it("admits a caller the server verified", () => {
    const result = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "sendTestEmail",
      input: { to: "reviewer@example.com" },
      context: verifiedAgentContext,
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.command).toEqual({ type: "sendTestEmail", to: "reviewer@example.com" });
    /*
      The two gates are independent: authorized AND still human-approved.
    */
    expect(result.isApprovalRequired).toBe(true);
  });

  it("refuses an unattributable caller, terminally, with no command produced", () => {
    const anonymousContext: ActionContext = {
      caller: "tool",
      authorId: "   ",
      author: "agent",
    };
    const result = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "sendTestEmail",
      input: { to: "reviewer@example.com" },
      context: anonymousContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    /*
      Terminal, not retryable: the recipient address was perfectly valid, so
      there is nothing for the model to repair and no reason to invite it to.
    */
    expect(result.failureKind).toBe("terminal");
    expect(result.errors[0]!.code).toBe("not_authorized");
  });

  /*
    THE CASE THIS EXISTS TO CLOSE. A context carrying only a self-asserted
    `authorId` is exactly what the agent path stamps — pipeline.ts writes
    `threadId ?? "flock-agent"` and nothing anywhere verifies it. Before
    `requiresVerifiedCaller`, that context PASSED the send gate, which made the
    gate's own bar ("name a caller") one the agent path could never fail.

    A verified caller is a different fact from an attributed one, and this pins
    that the send action now asks for the fact a surface cannot make up.
  */
  it("refuses a caller that is only self-asserted, however well attributed", () => {
    const result = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "sendTestEmail",
      input: { to: "reviewer@example.com" },
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("terminal");
    expect(result.errors[0]!.code).toBe("not_authorized");
    expect(result.errors[0]!.message).toMatch(/requires a VERIFIED caller/);
  });

  it("leaves every other built-in ungated, so nothing else changed behaviour", () => {
    /*
      The additive guarantee across the whole shipped registry: exactly one
      action declares a gate of EITHER kind, and each of the others authorizes
      by default because it has neither to consult. Pinned over both options so
      adding the declarative one cannot quietly gate a second action.
    */
    const gatedNames = emailActionRegistry.actions
      .filter(
        (action) => action.authorize !== undefined || action.requiresVerifiedCaller !== undefined,
      )
      .map((action) => action.name);
    expect(gatedNames).toEqual(["sendTestEmail"]);
    for (const action of emailActionRegistry.actions) {
      if (action.name === "sendTestEmail") continue;
      expect(resolveAuthorize({ action, input: {}, context: agentContext })).toBe(true);
    }
  });

  /*
    The read-only view and the enforced gate are the same decision. A surface
    that greys out a control on `resolveAuthorize` must not offer a send that
    `run` would then refuse — nor hide one that would have worked.
  */
  it("answers the same through resolveAuthorize as through run", () => {
    expect(
      resolveAuthorize({
        action: sendTestEmailAction,
        input: { to: "reviewer@example.com" },
        context: agentContext,
      }),
    ).toBe(false);
    expect(
      resolveAuthorize({
        action: sendTestEmailAction,
        input: { to: "reviewer@example.com" },
        context: verifiedAgentContext,
      }),
    ).toBe(true);
  });

  /*
    The auth-off deployment, declared with `whenNoIdentitySystem: "allow"`.
    There are no identities here to verify, so refusing would mean a Send-test
    button that can never work — the same reading of the flag the HTTP send
    route already takes. What remains is the attribution bar.
  */
  it("still sends on a deployment that has no identity system at all", () => {
    const result = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "sendTestEmail",
      input: { to: "reviewer@example.com" },
      context: noIdentitySystemContext,
    });
    expect(result.isOk).toBe(true);
  });

  it("refuses when the deployment has identity and this caller has no session", () => {
    const result = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "sendTestEmail",
      input: { to: "reviewer@example.com" },
      context: {
        ...agentContext,
        verifiedCaller: { isVerified: false, reason: "no_verified_session" },
      },
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("terminal");
    expect(result.errors[0]!.code).toBe("not_authorized");
  });

  /*
    Both gates still hold, independently. A verified caller that the surface
    could not attribute is refused too — verification answers "who", the op log
    still needs "under what name".
  */
  it("refuses a verified caller the surface could not attribute", () => {
    const result = dispatchEditorAction({
      registry: emailActionRegistry,
      name: "sendTestEmail",
      input: { to: "reviewer@example.com" },
      context: { ...verifiedAgentContext, authorId: "   " },
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.errors[0]!.code).toBe("not_authorized");
  });
});
