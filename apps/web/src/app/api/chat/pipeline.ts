import type { ActionContext, BlockId, EmailDocument } from "@tandem/email-sdk";
import {
  convertToModelMessages,
  generateText,
  NoSuchToolError,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type ModelMessage,
  type ToolCallRepairFunction,
  type ToolSet,
  type UIMessageStreamWriter,
} from "ai";
import type { TandemChatMessage } from "@/lib/chat-contract";
import { toChatErrorText } from "./errors";
import {
  MAX_REPAIR_ATTEMPTS_PER_TOOL_CALL,
  MAX_STEP_COUNT,
  PIPELINE_VARIANT,
  type PipelineVariant,
} from "./constants";
import { buildSystemContext } from "./system-context";
import { buildChatTools } from "./tools";

/**
 * The chat pipeline (Phase 3.2) — natural language in, streamed validated
 * operations out.
 *
 * A/B seam: {@link runChatPipeline} dispatches on PIPELINE_VARIANT (see
 * constants.ts). Both variants implement the same
 * `(ChatPipelineInput) => Promise<void>` interface: consume the request, write
 * UI-message chunks through `input.writer`, resolve when the model stream has
 * been merged. "single-pass" is built; "triage-execute" is the documented
 * drop-in slot.
 */

export interface ChatPipelineInput {
  model: LanguageModel;
  /** For the latency log line (the LanguageModel object hides its id). */
  modelId: string;
  isUsingMockModel: boolean;
  messages: TandemChatMessage[];
  doc: EmailDocument;
  selectedBlockId?: BlockId;
  /** Chat/thread id from the client transport, used for op provenance. */
  threadId?: string;
  writer: UIMessageStreamWriter<TandemChatMessage>;
}

// ---------------------------------------------------------------------------
// Validation gate, layer 2: one repair round-trip (Phase 3.3)
// ---------------------------------------------------------------------------

interface CreateToolCallRepairerInput {
  model: LanguageModel;
  /** Tools WITHOUT execute() — a repair round must not re-run side effects. */
  schemaOnlyTools: ToolSet;
  staticInstructions: string;
  onRepairAttempt: () => void;
}

/**
 * repairToolCall hook: when the model emits a tool call that fails inputSchema
 * validation (InvalidToolInputError → the SDK analogue of the registry's
 * retryable `op_validation_failed`), re-ask the SAME model once, feeding the
 * Zod error message back as a tool result — exactly the plan's "one repair
 * round-trip with the error message".
 *
 * Terminal-equivalent cases return null, which lets the SDK surface the
 * original error (→ shaped into a structured error part by the route's
 * onError):
 * - NoSuchToolError — a hallucinated tool name; per SDK guidance we do not
 *   guess a replacement (the registry's `unknown_action` stays retryable for
 *   DISPATCH, but at parse time there is no input worth repairing).
 * - The repair budget (MAX_REPAIR_ATTEMPTS_PER_TOOL_CALL) is exhausted.
 * - The re-ask did not produce a call to the same tool.
 */
function createToolCallRepairer({
  model,
  schemaOnlyTools,
  staticInstructions,
  onRepairAttempt,
}: CreateToolCallRepairerInput): ToolCallRepairFunction<ToolSet> {
  const repairAttemptCountsByToolCallId = new Map<string, number>();

  return async ({ toolCall, messages, error }) => {
    if (NoSuchToolError.isInstance(error)) {
      return null;
    }
    const previousAttemptCount = repairAttemptCountsByToolCallId.get(toolCall.toolCallId) ?? 0;
    if (previousAttemptCount >= MAX_REPAIR_ATTEMPTS_PER_TOOL_CALL) {
      return null;
    }
    repairAttemptCountsByToolCallId.set(toolCall.toolCallId, previousAttemptCount + 1);
    onRepairAttempt();

    // Re-ask strategy (bundled AI SDK docs, tools-and-tool-calling): replay
    // the step's messages plus the failed call and its validation error as a
    // tool result, and take the corrected call from the response.
    const repairMessages: ModelMessage[] = [
      ...messages,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: toolCall.input,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            output: {
              type: "text",
              value: `The tool input failed validation. ${error.message}\nCall ${toolCall.toolName} again with corrected input.`,
            },
          },
        ],
      },
    ];

    const repairResult = await generateText({
      model,
      system: staticInstructions,
      messages: repairMessages,
      tools: schemaOnlyTools,
    });

    const repairedToolCall = repairResult.toolCalls.find(
      (candidate) => candidate.toolName === toolCall.toolName,
    );
    if (repairedToolCall === undefined) {
      return null;
    }
    return {
      type: "tool-call",
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      input: JSON.stringify(repairedToolCall.input),
    };
  };
}

// ---------------------------------------------------------------------------
// Variant: single-pass (implemented)
// ---------------------------------------------------------------------------

async function runSinglePassPipeline(input: ChatPipelineInput): Promise<void> {
  const { model, modelId, isUsingMockModel, messages, doc, selectedBlockId, threadId, writer } =
    input;

  const requestStartMs = performance.now();
  let firstChunkMs: number | undefined;
  let repairAttemptCount = 0;

  // Provenance for everything this turn dispatches (op-log ready, Phase 4).
  const actionContext: ActionContext = {
    caller: "tool",
    authorId: threadId ?? "tandem-agent",
    author: "agent",
    batchId: crypto.randomUUID(),
    threadId,
  };

  const { tools, schemaOnlyTools, toolApproval } = buildChatTools({ writer, actionContext, doc });
  const { staticInstructions, documentContext } = buildSystemContext({ doc, selectedBlockId });

  // Message order for Gemini implicit context caching: static system text
  // FIRST (stable prefix), conversation next, per-request document context as
  // the LAST user message (fresh tokens that never invalidate the prefix).
  //
  // ignoreIncompleteToolCalls: content-op tools have no execute() and the
  // client does not (yet) report apply results back, so prior assistant
  // messages contain dangling tool calls that would otherwise throw
  // AI_MissingToolResultsError (Spike C finding 2).
  const modelMessages: ModelMessage[] = [
    ...(await convertToModelMessages(messages, { tools, ignoreIncompleteToolCalls: true })),
    { role: "user", content: documentContext },
  ];

  const result = streamText({
    model,
    system: staticInstructions,
    messages: modelMessages,
    tools,
    toolApproval,
    stopWhen: stepCountIs(MAX_STEP_COUNT),
    repairToolCall: createToolCallRepairer({
      model,
      schemaOnlyTools,
      staticInstructions,
      onRepairAttempt: () => {
        repairAttemptCount += 1;
      },
    }),
    onChunk: ({ chunk }) => {
      // "start"/"start-step" are synthetic local chunks emitted before the
      // provider responds — skip them so ttft measures real first output.
      const isPreResponseChunk = chunk.type === "start" || chunk.type === "start-step";
      if (!isPreResponseChunk) {
        firstChunkMs ??= performance.now();
      }
    },
    // Per-request latency/cost log line (plan §4.4 brought forward): one JSON
    // object per request on stdout — greppable, ingestible.
    onEnd: ({ finishReason, usage, toolCalls }) => {
      console.log(
        JSON.stringify({
          tag: "tandem.chat.request",
          variant: "single-pass" satisfies PipelineVariant,
          model: modelId,
          isMock: isUsingMockModel,
          ttftMs: firstChunkMs === undefined ? null : Math.round(firstChunkMs - requestStartMs),
          totalMs: Math.round(performance.now() - requestStartMs),
          toolCallCount: toolCalls.length,
          repairAttemptCount,
          finishReason,
          usage,
        }),
      );
    },
  });

  writer.merge(
    toUIMessageStream<ToolSet, TandemChatMessage>({
      stream: result.stream,
      tools,
      // Model-stream errors funnel through here (createUIMessageStream's
      // onError only sees pipeline/setup failures).
      onError: toChatErrorText,
    }),
  );
}

// ---------------------------------------------------------------------------
// Variant: triage-execute (A/B slot — NOT built)
// ---------------------------------------------------------------------------

/**
 * Two-step variant (plan §3.2 option a): a cheap triage call classifies the
 * request and selects the relevant block types/actions; the execute call then
 * receives only those schemas (smaller toolset, tighter validation). Implement
 * with the same contract as {@link runSinglePassPipeline} — reuse
 * buildChatTools (filtered), buildSystemContext, and the repairer — then set
 * TANDEM_PIPELINE_VARIANT=triage-execute to compare latency via the
 * tandem.chat.request log lines.
 */
async function runTriageExecutePipeline(): Promise<void> {
  throw new Error(
    'Pipeline variant "triage-execute" is not implemented yet — unset TANDEM_PIPELINE_VARIANT or use "single-pass".',
  );
}

const chatPipelinesByVariant: Record<PipelineVariant, (input: ChatPipelineInput) => Promise<void>> =
  {
    "single-pass": runSinglePassPipeline,
    "triage-execute": runTriageExecutePipeline,
  };

/** Run the flag-selected pipeline variant for one request. */
export async function runChatPipeline(input: ChatPipelineInput): Promise<void> {
  await chatPipelinesByVariant[PIPELINE_VARIANT](input);
}
