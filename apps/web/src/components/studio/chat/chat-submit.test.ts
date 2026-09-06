import { describe, expect, it } from "vitest";
import { getPromptDispatchAction } from "./chat-submit";

describe("chat prompt dispatch", () => {
  it("sends immediately when the agent is idle and no prompt is queued", () => {
    expect(
      getPromptDispatchAction({ isAgentBusy: false, hasQueuedMessages: false }),
    ).toBe("send");
  });

  it("queues a prompt while the agent is working", () => {
    expect(getPromptDispatchAction({ isAgentBusy: true, hasQueuedMessages: false })).toBe("queue");
  });

  it("keeps later prompts behind an existing queue even after a turn settles", () => {
    expect(getPromptDispatchAction({ isAgentBusy: false, hasQueuedMessages: true })).toBe("queue");
  });
});
