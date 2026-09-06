import { describe, expect, it } from "vitest";
import { getNextQueuedMessage, type QueuedMessage } from "./use-message-queue";

function message(id: string, text: string): QueuedMessage {
  return { id, text };
}

describe("message queue dispatch", () => {
  it("dispatches queued prompts in FIFO order", () => {
    const first = message("first", "Make the headline warmer");
    const second = message("second", "Tighten the body copy");
    const third = message("third", "Add a clearer call to action");

    const firstDispatch = getNextQueuedMessage([first, second, third]);
    const secondDispatch = getNextQueuedMessage(firstDispatch.rest);
    const thirdDispatch = getNextQueuedMessage(secondDispatch.rest);

    expect(firstDispatch.head).toEqual(first);
    expect(secondDispatch.head).toEqual(second);
    expect(thirdDispatch.head).toEqual(third);
    expect(thirdDispatch.rest).toEqual([]);
  });

  it("does not fabricate a prompt when the queue is empty", () => {
    expect(getNextQueuedMessage([])).toEqual({ head: undefined, rest: [] });
  });
});
