import type {
  BlockId,
  ScaffoldSectionInput,
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
 * - mentions "malformed tool calls" → the item-20 reliability probe: one
 *   tool call whose args arrive as a STRINGIFIED JSON envelope (the observed
 *   live Gemini mangle — must be silently recovered by the pre-validation
 *   unwrap) plus one with unparseable truncated args (must degrade to a
 *   single failure chip without killing the turn; the repair re-ask against
 *   this mock throws, exercising the repairer's never-throw path)
 * - mentions preview/mobile/desktop → showPreview editor tool call
 * - mentions "test email"           → sendTestEmail (exercises approval flow)
 * - contains a URL                  → fetchWebContent with that URL (the
 *   server then performs the REAL fetch + extraction — Phase 7.4a seam)
 * - asks for a "full email" (or whole/entire/complete email) → the
 *   per-section streaming script: FOUR sequential scaffoldSection calls
 *   (header, hero, feature-columns, footer), each streamed as its own
 *   tool-input-start → deltas → tool-call sequence with real inter-chunk
 *   delays — the probe that pins "section 1 is applied before section N is
 *   even generated" (see pipeline-streaming.test.ts)
 * - asks to add a section (e.g. "add a hero section") → scaffoldSection with
 *   the mentioned catalog templateId (exercises the Phase 7.2 scaffold seam)
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
  /**
   * True when this request is an auto-continuation carrying tool results
   * (the conversation already ends with an assistant message). The mock then
   * emits ONLY the closing text — without this, every continuation round
   * re-plans the same tool call and non-idempotent ops (scaffoldSection)
   * would apply once per round.
   */
  isContinuationRequest?: boolean;
}

interface MockToolCallPlan {
  toolName: string;
  input:
    | ShowPreviewInput
    | SendTestEmailInput
    | ScaffoldSectionInput
    | UpdateBlockPropertiesOperation
    | { url: string };
  acknowledgementText: string;
}

/** Catalog templateIds the mock recognizes by keyword in the user message. */
const MOCK_SCAFFOLD_TEMPLATE_IDS = [
  "header",
  "hero",
  "feature-columns",
  "article",
  "image-gallery",
  "testimonial",
  "stats",
  "footer",
] as const;

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
    // Sends are REAL since Phase 8.1 — never invent a third-party address.
    // Use the address in the message, else Resend's safe test inbox.
    const to =
      lastUserText.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0] ?? "delivered@resend.dev";
    return {
      toolName: "sendTestEmail",
      input: { to },
      acknowledgementText: `Requesting a test send to ${to}.`,
    };
  }
  // A URL in the message → fetchWebContent (Phase 7.4a). Checked BEFORE the
  // scaffold intent: "make a section from this article <url>" must fetch, not
  // scaffold placeholder content. The server executes the REAL fetch +
  // extraction, so tests exercise the whole read-only tool seam.
  const urlMatch = lastUserText.match(/https?:\/\/[^\s"'<>)]+/i);
  if (urlMatch !== null) {
    return {
      toolName: "fetchWebContent",
      input: { url: urlMatch[0] },
      acknowledgementText: "Reading that page now.",
    };
  }
  const hasScaffoldIntent = /\b(add|insert|scaffold)\b[\s\S]*\bsection\b/i.test(lastUserText);
  if (hasScaffoldIntent) {
    const templateId =
      MOCK_SCAFFOLD_TEMPLATE_IDS.find((candidate) =>
        new RegExp(`\\b${candidate.replace("-", "[ -]?")}`, "i").test(lastUserText),
      ) ?? "hero";
    const position = /\btop\b/i.test(lastUserText) ? ("top" as const) : ("bottom" as const);
    return {
      toolName: "scaffoldSection",
      input: { name: "scaffoldSection", templateId, position, params: {} },
      acknowledgementText: `Adding a ${templateId} section from the catalog.`,
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
    // Block ids are never user-facing — keep the prose generic.
    acknowledgementText: "Updating the selected block.",
  };
}

/**
 * Item-20 reliability probe (see the header): the EXACT malformed shapes from
 * the live failure, scripted. Call 1's raw argument text is a JSON-ENCODED
 * STRING of the whole envelope (name embedded) — the pre-validation unwrap
 * must recover it into a normally-applied op. Call 2's raw text is truncated
 * garbage — unrepairable by construction (this mock has no doGenerate, so the
 * repair re-ask throws), and must cost exactly one failure chip while the
 * turn survives.
 */
const MALFORMED_PROBE_REGEX = /\bmalformed tool calls\b/i;

/**
 * Full-email compose script: intent regex + the sections it streams, in
 * reading order. Checked BEFORE the single-section scaffold intent ("build
 * the whole email" must not degrade to one hero section).
 */
const COMPOSE_EMAIL_REGEX = /\b(?:full|whole|entire|complete)\s+email\b/i;

export const MOCK_COMPOSE_EMAIL_TEMPLATE_IDS = [
  "header",
  "hero",
  "feature-columns",
  "footer",
] as const;

/**
 * The per-section streaming chunk sequence: one scaffoldSection call per
 * template, each with its own tool-input-start → 16-char deltas →
 * tool-input-end → tool-call. With simulateReadableStream's per-chunk delay
 * this reproduces the shape (and pacing) of a real model composing a full
 * email section by section — downstream, section 1's validated call reaches
 * the client while section N's input is still being generated.
 */
function buildComposeEmailChunks() {
  const perSectionChunks = MOCK_COMPOSE_EMAIL_TEMPLATE_IDS.flatMap((templateId, index) => {
    const toolCallId = `call_${crypto.randomUUID()}`;
    const inputJson = JSON.stringify({
      name: "scaffoldSection",
      templateId,
      position: "bottom" as const,
      params: {},
    });
    const inputDeltas: string[] = [];
    for (let sliceStart = 0; sliceStart < inputJson.length; sliceStart += 16) {
      inputDeltas.push(inputJson.slice(sliceStart, sliceStart + 16));
    }
    return [
      ...(index === 0
        ? [
            { type: "text-start" as const, id: "text-1" },
            {
              type: "text-delta" as const,
              id: "text-1",
              delta: "Building the email one section at a time.",
            },
            { type: "text-end" as const, id: "text-1" },
          ]
        : []),
      { type: "tool-input-start" as const, id: toolCallId, toolName: "scaffoldSection" },
      ...inputDeltas.map((delta) => ({
        type: "tool-input-delta" as const,
        id: toolCallId,
        delta,
      })),
      { type: "tool-input-end" as const, id: toolCallId },
      {
        type: "tool-call" as const,
        toolCallId,
        toolName: "scaffoldSection",
        input: inputJson,
      },
    ];
  });
  return [
    ...perSectionChunks,
    {
      type: "finish" as const,
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 25, text: 10, reasoning: undefined },
      },
    },
  ];
}

function buildMalformedProbeChunks(selectedBlockId: BlockId | undefined) {
  const blockId = selectedBlockId ?? ("btn_t9u0" as BlockId);
  const recoverableEnvelope = JSON.stringify(
    JSON.stringify({
      name: "updateBlockProperties",
      blockId,
      properties: { label: "Unwrapped OK" },
    }),
  );
  const unparseableArgs = '{"name":"updateBlockProperties","blockId":';
  return [
    { type: "text-start" as const, id: "text-1" },
    {
      type: "text-delta" as const,
      id: "text-1",
      delta: "Sending one recoverable and one broken tool call.",
    },
    { type: "text-end" as const, id: "text-1" },
    {
      type: "tool-call" as const,
      toolCallId: `call_${crypto.randomUUID()}`,
      toolName: "updateBlockProperties",
      input: recoverableEnvelope,
    },
    {
      type: "tool-call" as const,
      toolCallId: `call_${crypto.randomUUID()}`,
      toolName: "updateBlockProperties",
      input: unparseableArgs,
    },
    {
      type: "finish" as const,
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 25, text: 10, reasoning: undefined },
      },
    },
  ];
}

export function createMockChatModel(input: CreateMockChatModelInput) {
  const isContinuationRequest = input.isContinuationRequest ?? false;
  const isMalformedProbe = MALFORMED_PROBE_REGEX.test(input.lastUserText);
  const isComposeEmailProbe = COMPOSE_EMAIL_REGEX.test(input.lastUserText);
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
      const isFirstStep = doStreamCallCount === 1 && !isContinuationRequest;
      if (isMalformedProbe && isFirstStep) {
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
              ...buildMalformedProbeChunks(input.selectedBlockId),
            ],
          }),
        };
      }
      if (isComposeEmailProbe && isFirstStep) {
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
              ...buildComposeEmailChunks(),
            ],
          }),
        };
      }
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
