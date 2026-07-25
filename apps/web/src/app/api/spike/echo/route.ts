import { anthropic } from "@ai-sdk/anthropic";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  simulateReadableStream,
  streamText,
  toUIMessageStream,
  tool,
  type LanguageModel,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  echoOperationSchema,
  type EchoOperation,
  type SpikeChatMessage,
} from "@/app/spike/ai/schema";

/**
 * Spike C — ops-streaming transport.
 *
 * Natural language in → streamed, Zod-validated tool calls (operations) +
 * custom data parts (editor-operations channel) out, over the AI SDK v7
 * UI message stream (SSE).
 *
 * Model selection: real Anthropic when ANTHROPIC_API_KEY is set; otherwise a
 * scripted MockLanguageModelV4 that emits the SAME provider stream-part
 * sequence a real model would (tool-input-start → tool-input-delta* →
 * tool-call), so the entire pipeline downstream of the model — streamText
 * tool-input validation, UI message chunk conversion, SSE transport, client
 * incremental application — is exercised without a key.
 */

const tools = {
  echoOperation: tool({
    description:
      "Echo a message into a target block of the email document. " +
      "Call this exactly once with the user's message.",
    inputSchema: echoOperationSchema,
    // No execute(): this is a client-applied operation. The tool call streams
    // to the client, which validates and applies it (Phase 3.3 pattern).
  }),
};

/**
 * Deterministic mock: emits text deltas, then an echoOperation tool call whose
 * input JSON arrives in several tool-input-delta chunks — mirroring how
 * Anthropic streams tool_use input as partial JSON.
 */
function createMockEchoModel(lastUserText: string) {
  const operation: EchoOperation = {
    kind: "content",
    name: "echoOperation",
    blockId: "txt_a1",
    message: lastUserText,
  };
  const operationJson = JSON.stringify(operation);
  // Unique per request, like a real provider — the client dedupes applied
  // ops by toolCallId, so a fixed id would suppress later turns.
  const toolCallId = `call_${crypto.randomUUID()}`;
  // Split the tool input JSON into small deltas so partial-input streaming is
  // observable on the client.
  const inputDeltas: string[] = [];
  for (let i = 0; i < operationJson.length; i += 12) {
    inputDeltas.push(operationJson.slice(i, i + 12));
  }

  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: 80,
        chunks: [
          { type: "stream-start" as const, warnings: [] },
          {
            type: "response-metadata" as const,
            id: "mock-response-1",
            modelId: "mock-echo-model",
            timestamp: new Date(0),
          },
          { type: "text-start" as const, id: "text-1" },
          { type: "text-delta" as const, id: "text-1", delta: "Echoing" },
          { type: "text-delta" as const, id: "text-1", delta: " your message" },
          {
            type: "text-delta" as const,
            id: "text-1",
            delta: " into block txt_a1.",
          },
          { type: "text-end" as const, id: "text-1" },
          {
            type: "tool-input-start" as const,
            id: toolCallId,
            toolName: "echoOperation",
          },
          ...inputDeltas.map((delta) => ({
            type: "tool-input-delta" as const,
            id: toolCallId,
            delta,
          })),
          { type: "tool-input-end" as const, id: toolCallId },
          {
            type: "tool-call" as const,
            toolCallId,
            toolName: "echoOperation",
            input: operationJson,
          },
          {
            type: "finish" as const,
            finishReason: { unified: "tool-calls" as const, raw: undefined },
            usage: {
              inputTokens: {
                total: 10,
                noCache: 10,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 25, text: 10, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  });
}

function getLastUserText(messages: SpikeChatMessage[]): string {
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const text = lastUserMessage?.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");
  return text || "(empty message)";
}

export async function POST(request: Request) {
  const { messages }: { messages: SpikeChatMessage[] } = await request.json();

  const hasAnthropicApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const model: LanguageModel = hasAnthropicApiKey
    ? anthropic("claude-haiku-4-5-20251001")
    : createMockEchoModel(getLastUserText(messages));

  const stream = createUIMessageStream<SpikeChatMessage>({
    execute: async ({ writer }) => {
      // Phase 3.4 preview: the editor-operations channel is just a custom
      // data part written onto the same stream the model output flows over.
      // (Re-writing with the same `id` later would reconcile/update the part.)
      writer.write({
        type: "data-editor-operation",
        id: "editor-op-1",
        data: { kind: "editor", name: "showPreview", mode: "mobile" },
      });

      const result = streamText({
        model,
        system:
          "You are an email-editor agent. The user sends a message; you must " +
          "call the echoOperation tool exactly once to echo that message into " +
          'block "txt_a1", after a one-sentence acknowledgement.',
        // `ignoreIncompleteToolCalls` is required for client-applied ops:
        // the tool has no execute() and the client never sends a tool output
        // back, so prior assistant messages contain dangling tool calls that
        // would otherwise throw AI_MissingToolResultsError on the next turn.
        // (Phase 3: record an "applied" output per op instead — see decision doc.)
        messages: await convertToModelMessages(messages, {
          tools,
          ignoreIncompleteToolCalls: true,
        }),
        tools,
      });

      writer.merge(toUIMessageStream({ stream: result.stream, tools }));
    },
  });

  return createUIMessageStreamResponse({ stream });
}
