import type { ActionContext, BlockId, EmailDocument } from "@flock/email-sdk";
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
import type { FlockChatMessage } from "@/lib/chat-contract";
import { toChatErrorText } from "./errors";
import {
  MAX_MODEL_CALL_RETRIES,
  MAX_REPAIR_ATTEMPTS_PER_TOOL_CALL,
  MAX_STEP_COUNT,
  PIPELINE_VARIANT,
  type PipelineVariant,
} from "./constants";
import { buildBrandContextBlock } from "./brand-context";
import { buildSavedSectionsContext } from "./saved-sections-context";
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
  messages: FlockChatMessage[];
  doc: EmailDocument;
  selectedBlockId?: BlockId;
  /** Chat/thread id from the client transport, used for op provenance. */
  threadId?: string;
  /**
   * The calling browser's anonymous session id (from the same-origin session
   * cookie), or null when absent. The generateImage executor registers every
   * generation under this session's asset library (Content Studio Stage S).
   */
  sessionId: string | null;
  writer: UIMessageStreamWriter<FlockChatMessage>;
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
 * The failed call's arguments as something the repair request can PHYSICALLY
 * carry. `toolCall.input` at repair time is the provider's RAW argument text —
 * for the calls that need repairing it is often a STRING (unparsed, sometimes
 * a JSON-escaped envelope, sometimes truncated JSON). Embedding that string
 * verbatim in a replayed assistant tool-call made the Google provider encode
 * `function_call.args` as a protobuf-Struct-invalid string and the REPAIR
 * REQUEST ITSELF was rejected (AI_APICallError inside AI_ToolCallRepairError —
 * observed live, terminal). Parse to an object when possible; otherwise
 * replay `{}` and carry the raw text inside the error prose instead.
 */
function toReplayableToolInput(rawInput: unknown): {
  input: Record<string, unknown>;
  unparseableRawText: string | null;
} {
  let current: unknown = rawInput;
  for (let unwrapAttempt = 0; unwrapAttempt < 2 && typeof current === "string"; unwrapAttempt++) {
    try {
      current = JSON.parse(current);
    } catch {
      break;
    }
  }
  if (typeof current === "object" && current !== null && !Array.isArray(current)) {
    return { input: current as Record<string, unknown>, unparseableRawText: null };
  }
  const rawText = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput);
  return { input: {}, unparseableRawText: rawText ?? "" };
}

/** Cap on raw argument text quoted back to the model in a repair prompt. */
const MAX_QUOTED_RAW_INPUT_LENGTH = 2_000;

/**
 * repairToolCall hook: when the model emits a tool call that fails inputSchema
 * validation (InvalidToolInputError → the SDK analogue of the registry's
 * retryable `op_validation_failed`), re-ask the SAME model once, feeding the
 * Zod error message back as a tool result — exactly the plan's "one repair
 * round-trip with the error message".
 *
 * Terminal-equivalent cases return null, which lets the SDK degrade the call
 * to an invalid-tool-call part: the client renders one failure chip, a
 * tool-error result goes back to the model, and THE TURN CONTINUES — one
 * unsalvageable call never fails the turn:
 * - NoSuchToolError — a hallucinated tool name; per SDK guidance we do not
 *   guess a replacement (the registry's `unknown_action` stays retryable for
 *   DISPATCH, but at parse time there is no input worth repairing).
 * - The repair budget (MAX_REPAIR_ATTEMPTS_PER_TOOL_CALL) is exhausted.
 * - The re-ask did not produce a call to the same tool.
 * - The re-ask itself failed (network, provider rejection). This hook must
 *   NEVER throw: a thrown repairer wraps into ToolCallRepairError and turns a
 *   one-call problem into a turn-level wall of JSON.
 */
export function createToolCallRepairer({
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
    // tool result, and take the corrected call from the response. The failed
    // call's args are re-encoded first (toReplayableToolInput) — the raw
    // provider text must never ride in a tool-call slot.
    const { input: replayableInput, unparseableRawText } = toReplayableToolInput(toolCall.input);
    const rawInputNote =
      unparseableRawText === null
        ? ""
        : `\nYour arguments were not valid JSON. They began: ${unparseableRawText.slice(0, MAX_QUOTED_RAW_INPUT_LENGTH)}`;
    const repairMessages: ModelMessage[] = [
      ...messages,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: replayableInput,
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
              value: `The tool input failed validation. ${error.message}${rawInputNote}\nCall ${toolCall.toolName} again with corrected input.`,
            },
          },
        ],
      },
    ];

    try {
      const repairResult = await generateText({
        model,
        system: staticInstructions,
        messages: repairMessages,
        tools: schemaOnlyTools,
        maxRetries: MAX_MODEL_CALL_RETRIES,
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
    } catch (repairRequestError) {
      // Never throw (see the hook contract above): a failed re-ask degrades
      // to "unrepaired" and the SDK's invalid-call path keeps the turn alive.
      console.error(
        JSON.stringify({
          tag: "flock.chat.repairRequestFailed",
          toolName: toolCall.toolName,
          message:
            repairRequestError instanceof Error
              ? repairRequestError.message.slice(0, 500)
              : String(repairRequestError),
        }),
      );
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Variant: single-pass (implemented)
// ---------------------------------------------------------------------------

async function runSinglePassPipeline(input: ChatPipelineInput): Promise<void> {
  const {
    model,
    modelId,
    isUsingMockModel,
    messages,
    doc,
    selectedBlockId,
    threadId,
    sessionId,
    writer,
  } = input;

  const requestStartMs = performance.now();
  let firstChunkMs: number | undefined;
  let repairAttemptCount = 0;

  // Provenance for everything this turn dispatches (op-log ready, Phase 4).
  const actionContext: ActionContext = {
    caller: "tool",
    authorId: threadId ?? "flock-agent",
    author: "agent",
    batchId: crypto.randomUUID(),
    threadId,
  };

  const { tools, schemaOnlyTools, toolApproval } = buildChatTools({
    writer,
    actionContext,
    doc,
    sessionId,
    isUsingMockModel,
  });
  // Brand social links + saved sections ride the FRESH context layer only
  // (both fail soft to null; fetched concurrently — same Convex deployment).
  const [brandContextLine, savedSectionsContext] = await Promise.all([
    buildBrandContextBlock({ sessionId }),
    buildSavedSectionsContext({ sessionId }),
  ]);
  const { staticInstructions, documentContext } = buildSystemContext({
    doc,
    selectedBlockId,
    brandContextLine,
    savedSectionsContext,
  });

  // Message order for Gemini implicit context caching: static system text
  // FIRST (stable prefix), conversation next, per-request document context as
  // the LAST user message (fresh tokens that never invalidate the prefix).
  //
  // ignoreIncompleteToolCalls: content-op tools have no execute() and the
  // client does not (yet) report apply results back, so prior assistant
  // messages contain dangling tool calls that would otherwise throw
  // AI_MissingToolResultsError (Spike C finding 2).
  const convertedMessages = await convertToModelMessages(messages, {
    tools,
    ignoreIncompleteToolCalls: true,
  });

  // Approval collection (collectToolApprovals) only runs when the FINAL
  // message is a tool message; appending the doc context after it would
  // silently skip approved executions (e.g. sendTestEmail). An approval
  // resubmission round is just completing already-approved calls, so it
  // doesn't need fresh document context — skip the append in that case.
  const hasTrailingToolMessage = convertedMessages.at(-1)?.role === "tool";
  const modelMessages: ModelMessage[] = hasTrailingToolMessage
    ? convertedMessages
    : [...convertedMessages, { role: "user", content: documentContext }];

  const result = streamText({
    model,
    system: staticInstructions,
    messages: modelMessages,
    tools,
    toolApproval,
    maxRetries: MAX_MODEL_CALL_RETRIES,
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
          tag: "flock.chat.request",
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
    toUIMessageStream<ToolSet, FlockChatMessage>({
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
 * FLOCK_PIPELINE_VARIANT=triage-execute to compare latency via the
 * flock.chat.request log lines.
 */
async function runTriageExecutePipeline(): Promise<void> {
  throw new Error(
    'Pipeline variant "triage-execute" is not implemented yet — unset FLOCK_PIPELINE_VARIANT or use "single-pass".',
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
