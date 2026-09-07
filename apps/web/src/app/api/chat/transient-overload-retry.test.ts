import {
  APICallError,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isTransientOverloadError,
  wrapModelWithTransientOverloadRetry,
} from "./transient-overload-retry";

function createTransientOverloadError(): APICallError {
  return new APICallError({
    message: "This model is currently experiencing high demand.",
    url: "https://generativelanguage.googleapis.com/v1beta/models/test:streamGenerateContent",
    requestBodyValues: {},
    statusCode: 503,
    isRetryable: false,
  });
}

function createTextStream(text: string) {
  const chunks = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: text },
    { type: "text-end", id: "text-1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  ];
  return {
    stream: simulateReadableStream({
      chunks,
    }),
  } as never;
}

describe("transient provider overload recovery", () => {
  it("recognizes a Google high-demand response even when the provider marks it non-retryable", () => {
    expect(isTransientOverloadError(createTransientOverloadError())).toBe(true);
  });

  it("does not retry a permanent provider rejection", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({
          message: "Invalid request",
          url: "https://generativelanguage.googleapis.com/v1beta/models/test:streamGenerateContent",
          requestBodyValues: {},
          statusCode: 400,
          isRetryable: false,
        });
      },
    });
    const wrappedModel = wrapModelWithTransientOverloadRetry(model, { delayMs: 0 });

    const call = (wrappedModel as unknown as {
      doStream(options: never): Promise<unknown>;
    }).doStream({} as never);
    await expect(call).rejects.toMatchObject({ statusCode: 400 });
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("retries one failed continuation without executing a preceding tool twice", async () => {
    let callCount = 0;
    let readPageCallCount = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        callCount += 1;
        if (callCount === 2) {
          throw createTransientOverloadError();
        }
        if (callCount === 1) {
          const chunks = [
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "tool-1",
              toolName: "readWebPage",
              input: JSON.stringify({ url: "https://sprioleau.dev" }),
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ];
          return {
            stream: simulateReadableStream({
              chunks,
            }),
          } as never;
        }
        return createTextStream("Draft created.");
      },
    });

    const result = streamText({
      model: wrapModelWithTransientOverloadRetry(model, { delayMs: 0 }),
      tools: {
        readWebPage: tool({
          inputSchema: z.object({ url: z.string().url() }),
          execute: async () => {
            readPageCallCount += 1;
            return { title: "Example" };
          },
        }),
      },
      messages: [{ role: "user", content: "Read the page and create a draft." }],
      stopWhen: stepCountIs(3),
      maxRetries: 0,
    });

    await result.text;
    expect(callCount).toBe(3);
    expect(readPageCallCount).toBe(1);
    expect(await result.text).toBe("Draft created.");
    expect(model.doStreamCalls).toHaveLength(3);
  });
});
