import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PAYLOAD_CHARS } from "./log";
import {
  createModelTelemetry,
  logModelCall,
  logModelFailure,
  logToolInputRejected,
  logToolInputUnrepaired,
  modelTelemetryFor,
  newModelContext,
  type ModelTelemetryContext,
} from "./model-telemetry";

const context: ModelTelemetryContext = {
  operation: "chat.main",
  traceId: "trace123",
  isMock: false,
  sessionHash: "abc1234",
};

let infoLines: string[];
let errorLines: string[];

beforeEach(() => {
  infoLines = [];
  errorLines = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    infoLines.push(String(line));
  });
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    errorLines.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const parseOnly = (lines: string[]): Record<string, unknown>[] =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);

describe("logModelCall", () => {
  it("emits one flock.model.call carrying route, provider, model, latency and usage", () => {
    logModelCall(context, {
      provider: "google.generative-ai",
      modelId: "gemini-3.5-flash",
      latencyMs: 812.6,
      finishReason: "tool-calls",
      usage: { inputTokens: 1200, outputTokens: 88 },
      callId: "call-1",
    });
    expect(parseOnly(infoLines)).toEqual([
      {
        tag: "flock.model.call",
        operation: "chat.main",
        traceId: "trace123",
        isMock: false,
        sessionHash: "abc1234",
        provider: "google.generative-ai",
        model: "gemini-3.5-flash",
        latencyMs: 813,
        callId: "call-1",
        finishReason: "tool-calls",
        usage: { inputTokens: 1200, outputTokens: 88 },
      },
    ]);
  });

  it("records a null sessionHash rather than omitting the field", () => {
    logModelCall(
      { operation: "brandKit.extract", traceId: "t", isMock: true },
      { provider: "google", modelId: "m", latencyMs: 1 },
    );
    expect(parseOnly(infoLines)[0]).toMatchObject({ sessionHash: null, isMock: true });
  });
});

describe("logModelFailure", () => {
  it("classifies the failure and writes it to stderr", () => {
    logModelFailure(context, Object.assign(new Error("quota exceeded"), { statusCode: 429 }));
    expect(infoLines).toHaveLength(0);
    expect(parseOnly(errorLines)[0]).toMatchObject({
      tag: "flock.model.failed",
      operation: "chat.main",
      traceId: "trace123",
      errorCode: "rate_limited",
      statusCode: 429,
      message: "quota exceeded",
    });
  });
});

describe("createModelTelemetry", () => {
  it("logs one call record per provider round-trip", () => {
    const telemetry = createModelTelemetry(context);
    telemetry.onLanguageModelCallEnd?.({
      provider: "google.generative-ai",
      modelId: "gemini-3.5-flash",
      callId: "call-9",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 2 },
      performance: { responseTimeMs: 240.4 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow stub of the SDK event
    } as any);
    expect(parseOnly(infoLines)[0]).toMatchObject({
      tag: "flock.model.call",
      provider: "google.generative-ai",
      model: "gemini-3.5-flash",
      latencyMs: 240,
      finishReason: "stop",
    });
  });

  it("logs a failure record when the generation throws", () => {
    const telemetry = createModelTelemetry(context);
    telemetry.onError?.(Object.assign(new Error("boom"), { name: "AI_APICallError" }));
    expect(parseOnly(errorLines)[0]).toMatchObject({
      tag: "flock.model.failed",
      errorName: "AI_APICallError",
      errorCode: "provider_rejected",
    });
  });

  it("logs a failed tool execution and stays silent on a successful one", () => {
    const telemetry = createModelTelemetry(context);
    telemetry.onToolExecutionEnd?.({
      toolCall: { toolName: "sendTestEmail", toolCallId: "tc-1" },
      toolExecutionMs: 51.7,
      toolOutput: { type: "tool-error", error: new Error("SMTP refused") },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow stub of the SDK event
    } as any);
    telemetry.onToolExecutionEnd?.({
      toolCall: { toolName: "addSection", toolCallId: "tc-2" },
      toolExecutionMs: 3,
      toolOutput: { type: "tool-result", output: {} },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow stub of the SDK event
    } as any);
    expect(errorLines).toHaveLength(1);
    expect(parseOnly(errorLines)[0]).toMatchObject({
      tag: "flock.model.toolFailed",
      toolName: "sendTestEmail",
      toolCallId: "tc-1",
      toolExecutionMs: 52,
      message: "SMTP refused",
    });
  });
});

describe("modelTelemetryFor", () => {
  it("keeps functionId identical to the operation so the two cannot drift", () => {
    const options = modelTelemetryFor(context);
    expect(options.functionId).toBe("chat.main");
    expect(options.integrations).toHaveLength(1);
  });
});

describe("newModelContext", () => {
  it("mints a fresh trace id per call", () => {
    const first = newModelContext("personas.review", { isMock: true });
    expect(first.operation).toBe("personas.review");
    expect(first.isMock).toBe(true);
    expect(first.sessionHash).toBeNull();
    expect(first.traceId).not.toBe(newModelContext("personas.review", { isMock: true }).traceId);
  });
});

describe("logToolInputRejected", () => {
  it("carries the issue codes and paths as their own filterable arrays", () => {
    logToolInputRejected({
      context,
      toolName: "addSection",
      toolCallId: "tc-77",
      issues: [
        { code: "invalid_type", path: "children.0.text", message: "Expected string" },
        { code: "invalid_literal", path: "name", message: "Invalid discriminator" },
      ],
      rejectedInput: { name: "section", children: [{ type: "text", text: "hi" }] },
      previousAttemptCount: 0,
    });
    const record = parseOnly(errorLines)[0]!;
    expect(record).toMatchObject({
      tag: "flock.chat.toolInputRejected",
      traceId: "trace123",
      toolName: "addSection",
      toolCallId: "tc-77",
      previousAttemptCount: 0,
      issueCount: 2,
      issueCodes: ["invalid_type", "invalid_literal"],
      issuePaths: ["children.0.text", "name"],
    });
    expect(record.rejectedInput).toBe(
      '{"name":"section","children":[{"type":"text","text":"hi"}]}',
    );
  });

  it("truncates a rejected input that would otherwise be enormous", () => {
    logToolInputRejected({
      context,
      toolName: "addBlock",
      toolCallId: "tc-78",
      issues: [],
      rejectedInput: { body: "y".repeat(50_000) },
      previousAttemptCount: 1,
    });
    const rejectedInput = parseOnly(errorLines)[0]!.rejectedInput as string;
    expect(rejectedInput.length).toBeLessThan(MAX_PAYLOAD_CHARS + 40);
    expect(rejectedInput).toContain("…[+");
  });

  it("logs the raw provider text unchanged when the model sent unparseable args", () => {
    logToolInputRejected({
      context,
      toolName: "addSection",
      toolCallId: "tc-79",
      issues: [],
      rejectedInput: '{"name":"sec',
      previousAttemptCount: 0,
    });
    expect(parseOnly(errorLines)[0]!.rejectedInput).toBe('{"name":"sec');
  });
});

describe("logToolInputUnrepaired", () => {
  it("distinguishes the four previously indistinguishable give-up paths", () => {
    for (const reason of [
      "no_such_tool",
      "repair_budget_exhausted",
      "repair_produced_no_call",
      "repair_request_failed",
    ] as const) {
      logToolInputUnrepaired({ context, toolName: "addSection", toolCallId: "tc", reason });
    }
    expect(parseOnly(errorLines).map((record) => record.reason)).toEqual([
      "no_such_tool",
      "repair_budget_exhausted",
      "repair_produced_no_call",
      "repair_request_failed",
    ]);
    expect(parseOnly(errorLines)[0]).toMatchObject({
      tag: "flock.chat.toolInputUnrepaired",
      traceId: "trace123",
      toolName: "addSection",
    });
  });
});
