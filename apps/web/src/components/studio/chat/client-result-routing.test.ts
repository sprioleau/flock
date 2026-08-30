import { describe, expect, it } from "vitest";
import { emailActionRegistry } from "@flock/email-sdk";
import { getClientResultExecutorKind } from "./use-flock-chat";

/*
  EVERY CLIENT-RESULT ACTION MUST HAVE SOMEONE TO ANSWER IT.

  A `resultSource: "client"` action gets no server execute and no
  `data-editor-command` part — the browser's own branch is the only thing that
  ever writes its tool result. Miss one and the call arrives, does nothing, and
  is never reported: the model waits on an open tool call forever, no error is
  raised anywhere, and nothing turns red.

  That is not speculative. Deleting the applyThemeToDraft branch from the chat
  controller left all 1691 tests passing and `tsc` clean — the routing was
  entirely on trust. This test is the trust, made checkable: it reads the
  actions the SDK DECLARES client-result and insists each one maps to an
  executor, so adding the eleventh editor action without wiring it up fails
  here rather than in a chat window.
*/

const CLIENT_RESULT_ACTION_NAMES = emailActionRegistry.actions
  .filter((action) => action.kind === "editor" && action.resultSource === "client")
  .map((action) => action.name);

describe("client-result tool routing", () => {
  it("is derived from a registry that actually declares some", () => {
    /*
      Guards the census below against passing over an empty list.
    */
    expect(CLIENT_RESULT_ACTION_NAMES).toEqual([
      "undo",
      "redo",
      "createDraft",
      "applyThemeToDraft",
    ]);
  });

  it("routes every client-result action the SDK declares to an executor", () => {
    const unrouted = CLIENT_RESULT_ACTION_NAMES.filter(
      (name) => getClientResultExecutorKind(name) === null,
    );
    expect(unrouted).toEqual([]);
  });

  it("sends each one to its OWN executor, not merely to some executor", () => {
    expect(getClientResultExecutorKind("undo")).toBe("history");
    expect(getClientResultExecutorKind("redo")).toBe("history");
    expect(getClientResultExecutorKind("createDraft")).toBe("createDraft");
    expect(getClientResultExecutorKind("applyThemeToDraft")).toBe("applyThemeToDraft");
  });

  /*
    A server-result action must NOT be claimed here. Answering one in the
    browser would write a second, competing tool result over the one the
    server already sent.
  */
  it("claims nothing the server answers for", () => {
    for (const name of ["showPreview", "sendTestEmail", "goToVersion", "createPersona"]) {
      expect(getClientResultExecutorKind(name)).toBeNull();
    }
  });
});
