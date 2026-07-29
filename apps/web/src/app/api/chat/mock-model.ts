import type {
  BlockId,
  SendTestEmailInput,
  ShowPreviewInput,
  UpdateBlockPropertiesOperation,
} from "@tandem/email-sdk";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

/**
 * Deterministic mock chat model (no API key needed — CI/tests use this via
 * the x-tandem-mock header; it is also the automatic fallback when
 * GOOGLE_GENERATIVE_AI_API_KEY is absent).
 *
 * It emits the SAME provider-spec (LanguageModelV4) chunk sequence a real
 * Gemini stream produces — text deltas, then tool-input-start, repeated
 * tool-input-delta, tool-input-end, and a tool-call — so everything downstream
 * (streamText input validation, UI-chunk
 * conversion, SSE transport, editor-action execute, client gate) is the real
 * pipeline. Chunk shapes copied from node_modules/ai/docs (v4 finishReason /
 * usage shapes), per the Spike C finding: do not write these from memory.
 *
 * Scripted behavior, keyed off the last user message:
 * - mentions preview/mobile/desktop → showPreview editor tool call
 * - mentions "test email"           → sendTestEmail (exercises approval flow)
 * - otherwise → updateBlockProperties on the selected block (fallback
 *   btn_t9u0, the sample document's button), setting its label.
 *
 * The model is multi-step aware: the first doStream call emits the tool call;
 * any later call (e.g. the step after an editor tool executed) emits a short
 * closing text with finishReason "stop", so stopWhen loops terminate.
 */

export interface CreateMockChatModelInput {
  lastUserText: string;
  selectedBlockId?: BlockId;
}

interface MockToolCallPlan {
  toolName: string;
  input:
    | ShowPreviewInput
    | SendTestEmailInput
    | UpdateBlockPropertiesOperation;
  acknowledgementText: string;
}

function planMockToolCall({
  lastUserText,
  selectedBlockId,
}: CreateMockChatModelInput): MockToolCallPlan {
  const hasPreviewIntent = /\b(preview|mobile|desktop|viewport)\b/i.test(lastUserText);
  if (hasPreviewIntent) {
    const mode = /\bdesktop\b/i.test(lastUserText) ? ("desktop" as const) : ("mobile" as const);
    return {
      toolName: "showPreview",
      input: { mode },
      acknowledgementText: `Switching the canvas to the ${mode} preview.`,
    };
  }
  if (/\btest email\b/i.test(lastUserText)) {
    return {
      toolName: "sendTestEmail",
      input: { to: "test@example.com" },
      acknowledgementText: "Requesting a test send to test@example.com.",
    };
  }
  const blockId = selectedBlockId ?? ("btn_t9u0" as BlockId);
  return {
    toolName: "updateBlockProperties",
    input: {
      name: "updateBlockProperties",
      blockId,
      properties: { label: lastUserText.slice(0, 40) || "Updated" },
    },
    acknowledgementText: `Updating block ${blockId}.`,
  };
}

export function createMockChatModel(input: CreateMockChatModelInput) {
  const plan = planMockToolCall(input);
  const inputJson = JSON.stringify(plan.input);
  // Unique per request — clients dedupe applied ops by toolCallId (Spike C).
  const toolCallId = `call_${crypto.randomUUID()}`;
  const inputDeltas: string[] = [];
  for (let index = 0; index < inputJson.length; index += 16) {
    inputDeltas.push(inputJson.slice(index, index + 16));
  }

  let doStreamCallCount = 0;

  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 25, text: 10, reasoning: undefined },
  };

  return new MockLanguageModelV4({
    doStream: async () => {
      doStreamCallCount += 1;
      const isFirstStep = doStreamCallCount === 1;
      // One array literal (conditional spreads) so TS infers a single chunk
      // union for simulateReadableStream's generic across both step shapes.
      return {
        stream: simulateReadableStream({
          chunkDelayInMs: 20,
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            {
              type: "response-metadata" as const,
              id: `mock-response-${doStreamCallCount}`,
              modelId: "tandem-mock-chat-model",
              timestamp: new Date(0),
            },
            ...(isFirstStep
              ? [
                  { type: "text-start" as const, id: "text-1" },
                  { type: "text-delta" as const, id: "text-1", delta: plan.acknowledgementText },
                  { type: "text-end" as const, id: "text-1" },
                  { type: "tool-input-start" as const, id: toolCallId, toolName: plan.toolName },
                  ...inputDeltas.map((delta) => ({
                    type: "tool-input-delta" as const,
                    id: toolCallId,
                    delta,
                  })),
                  { type: "tool-input-end" as const, id: toolCallId },
                  {
                    type: "tool-call" as const,
                    toolCallId,
                    toolName: plan.toolName,
                    input: inputJson,
                  },
                  {
                    type: "finish" as const,
                    finishReason: { unified: "tool-calls" as const, raw: undefined },
                    usage,
                  },
                ]
              : [
                  { type: "text-start" as const, id: "text-2" },
                  { type: "text-delta" as const, id: "text-2", delta: "Done." },
                  { type: "text-end" as const, id: "text-2" },
                  {
                    type: "finish" as const,
                    finishReason: { unified: "stop" as const, raw: undefined },
                    usage,
                  },
                ]),
          ],
        }),
      };
    },
  });
}
