import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ISSUE_COUNT,
  MAX_MESSAGE_CHARS,
  MAX_PAYLOAD_CHARS,
  classifyModelError,
  createTraceId,
  extractValidationIssues,
  hashIdentifier,
  logFailure,
  logRecord,
  summarizeError,
  toFailureSignature,
  truncate,
  truncateJson,
  unwrapThrown,
} from "./log";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("truncate", () => {
  it("leaves a value that already fits completely alone", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("exactly-10", 10)).toBe("exactly-10");
  });

  it("marks the cut so a clipped value can never be read as a complete one", () => {
    expect(truncate("abcdefghij", 4)).toBe("abcd…[+6]");
  });

  it("caps a 47k-character schema well under the payload limit", () => {
    const huge = "x".repeat(47_000);
    const capped = truncateJson(huge);
    expect(capped.startsWith("x".repeat(MAX_PAYLOAD_CHARS))).toBe(true);
    expect(capped).toContain("…[+46000]");
    expect(capped.length).toBeLessThan(MAX_PAYLOAD_CHARS + 40);
  });
});

describe("truncateJson", () => {
  it("serializes an object before truncating", () => {
    expect(truncateJson({ name: "hero" }, 100)).toBe('{"name":"hero"}');
  });

  it("passes a string through without re-quoting it", () => {
    expect(truncateJson("already text", 100)).toBe("already text");
  });

  it("degrades instead of throwing on a circular value", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(truncateJson(circular)).toBe("[unserializable]");
  });
});

describe("hashIdentifier", () => {
  it("returns null for an absent identifier", () => {
    expect(hashIdentifier(null)).toBeNull();
    expect(hashIdentifier(undefined)).toBeNull();
    expect(hashIdentifier("")).toBeNull();
  });

  it("is stable, so records for one session correlate", () => {
    expect(hashIdentifier("session_abc")).toBe(hashIdentifier("session_abc"));
  });

  it("separates different identifiers", () => {
    expect(hashIdentifier("session_abc")).not.toBe(hashIdentifier("session_abd"));
  });

  it("never contains the original value", () => {
    const sessionId = "session_9f2a41c0deadbeef";
    const hashed = hashIdentifier(sessionId)!;
    expect(sessionId).not.toContain(hashed);
    expect(hashed.length).toBeLessThanOrEqual(8);
  });
});

describe("unwrapThrown", () => {
  it("unwraps the { error } envelope the AI SDK hands telemetry integrations", () => {
    const real = new Error("the actual failure");
    expect(unwrapThrown({ error: real })).toBe(real);
  });

  it("stops at a value that carries its own message", () => {
    const carriesMessage = { error: "inner", message: "outer" };
    expect(unwrapThrown(carriesMessage)).toBe(carriesMessage);
  });

  it("leaves a plain Error alone", () => {
    const plain = new Error("plain");
    expect(unwrapThrown(plain)).toBe(plain);
  });

  it("classifies an enveloped error instead of reporting [object Object]", () => {
    // Observed live: without unwrapping this produced
    // name "object" / code "unknown" / message "[object Object]".
    const enveloped = { error: Object.assign(new Error("nope"), { statusCode: 429 }) };
    const summary = summarizeError(enveloped);
    expect(summary.code).toBe("rate_limited");
    expect(summary.message).toBe("nope");
    expect(summary.statusCode).toBe(429);
  });
});

describe("toFailureSignature", () => {
  it("matches the Error and the stringified form of the same failure", () => {
    const message = `Invalid input for tool addSection: ${"detail ".repeat(200)}`;
    const asError = Object.assign(new Error(message), { name: "AI_InvalidToolInputError" });
    const asString = `AI_InvalidToolInputError: ${message}`;
    expect(toFailureSignature(asError)).toBe(toFailureSignature(asString));
  });

  it("still separates two genuinely different failures", () => {
    expect(toFailureSignature(new Error("tool A broke"))).not.toBe(
      toFailureSignature(new Error("tool B broke")),
    );
  });
});

describe("classifyModelError", () => {
  it("reads the error name out of a stringified AI SDK error", () => {
    expect(classifyModelError("AI_InvalidToolInputError: Invalid input for tool x")).toBe(
      "invalid_tool_input",
    );
  });

  it("maps AI SDK error names to stable codes", () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["AI_InvalidToolInputError", "invalid_tool_input"],
      ["AI_NoSuchToolError", "no_such_tool"],
      ["AI_ToolCallRepairError", "tool_call_repair_failed"],
      ["AI_NoObjectGeneratedError", "no_object_generated"],
      ["AI_TypeValidationError", "type_validation_failed"],
      ["AI_RetryError", "retry_exhausted"],
    ];
    for (const [name, expectedCode] of cases) {
      const error = new Error("boom");
      error.name = name;
      expect(classifyModelError(error)).toBe(expectedCode);
    }
  });

  it("reads a 429 status code as rate_limited", () => {
    expect(classifyModelError(Object.assign(new Error("nope"), { statusCode: 429 }))).toBe(
      "rate_limited",
    );
  });

  it("recognises the Gemini free-tier quota wording", () => {
    expect(classifyModelError(new Error("RESOURCE_EXHAUSTED: quota exceeded"))).toBe(
      "rate_limited",
    );
  });

  it("recognises network and timeout failures", () => {
    expect(classifyModelError(new Error("fetch failed"))).toBe("network_failed");
    expect(classifyModelError(new Error("request timed out"))).toBe("timeout");
  });

  it("calls an unrecognised provider status provider_rejected", () => {
    expect(classifyModelError(Object.assign(new Error("bad"), { statusCode: 503 }))).toBe(
      "provider_rejected",
    );
  });

  it("falls back to unknown rather than guessing", () => {
    expect(classifyModelError(new Error("something went sideways"))).toBe("unknown");
    expect(classifyModelError("a bare string")).toBe("unknown");
  });
});

describe("summarizeError", () => {
  it("truncates the message and keeps the status code", () => {
    const error = Object.assign(new Error("z".repeat(2_000)), { statusCode: 429 });
    const summary = summarizeError(error);
    expect(summary.code).toBe("rate_limited");
    expect(summary.statusCode).toBe(429);
    expect(summary.message).toContain("…[+1500]");
    expect(summary.message.length).toBeLessThan(MAX_MESSAGE_CHARS + 20);
  });

  it("omits statusCode entirely when the provider gave none", () => {
    expect(summarizeError(new Error("plain"))).not.toHaveProperty("statusCode");
  });

  it("survives a non-Error being thrown", () => {
    expect(summarizeError({ weird: true }).message).toBe("[object Object]");
  });
});

describe("extractValidationIssues", () => {
  it("digs the Zod issue list out of the AI SDK's nested cause chain", () => {
    // The real production shape: InvalidToolInputError → TypeValidationError
    // → ZodError. Only the innermost link carries `issues`.
    const zodError = Object.assign(new Error("validation failed"), {
      issues: [
        { code: "invalid_type", path: ["children", 0, "text"], message: "Expected string" },
        { code: "invalid_literal", path: ["name"], message: 'Invalid discriminator "section"' },
      ],
    });
    const typeValidationError = Object.assign(new Error("type validation"), {
      name: "AI_TypeValidationError",
      cause: zodError,
    });
    const invalidToolInput = Object.assign(new Error("invalid tool input"), {
      name: "AI_InvalidToolInputError",
      cause: typeValidationError,
    });

    expect(extractValidationIssues(invalidToolInput)).toEqual([
      { code: "invalid_type", path: "children.0.text", message: "Expected string" },
      { code: "invalid_literal", path: "name", message: 'Invalid discriminator "section"' },
    ]);
  });

  it("returns an empty list for an error that carries no issues", () => {
    expect(extractValidationIssues(new Error("nothing structured here"))).toEqual([]);
    expect(extractValidationIssues(null)).toEqual([]);
  });

  it("caps the issue list so one wildly-wrong payload cannot flood a line", () => {
    const many = Object.assign(new Error("many"), {
      issues: Array.from({ length: 50 }, (_unused, index) => ({
        code: "invalid_type",
        path: ["field", index],
        message: "nope",
      })),
    });
    expect(extractValidationIssues(many)).toHaveLength(MAX_ISSUE_COUNT);
  });

  it("truncates an individual issue message", () => {
    const wordy = Object.assign(new Error("wordy"), {
      issues: [{ code: "invalid_union", path: [], message: "m".repeat(1_000) }],
    });
    expect(extractValidationIssues(wordy)[0]!.message).toContain("…[+800]");
  });

  it("does not hang on a self-referential cause chain", () => {
    const looping: Record<string, unknown> = { message: "loop" };
    looping.cause = looping;
    expect(extractValidationIssues(looping)).toEqual([]);
  });

  it("tolerates issue objects with missing fields", () => {
    const ragged = Object.assign(new Error("ragged"), { issues: [{}] });
    expect(extractValidationIssues(ragged)).toEqual([{ code: "unknown", path: "", message: "" }]);
  });
});

describe("logRecord", () => {
  it("writes exactly one line of JSON to stdout", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logRecord({ tag: "flock.test", count: 2 });
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0]![0] as string;
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ tag: "flock.test", count: 2 });
  });

  it("puts the tag first so a Vercel row is identifiable at a glance", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logRecord({ tag: "flock.test", zzz: 1 });
    expect(log.mock.calls[0]![0]).toMatch(/^\{"tag":"flock\.test"/);
  });

  it("drops undefined fields but keeps explicit nulls", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logRecord({ tag: "flock.test", absent: undefined, known: null });
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      tag: "flock.test",
      known: null,
    });
  });

  it("sends failures to stderr so the Vercel Level filter can find them", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logFailure({ tag: "flock.test.failed" });
    expect(error).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("still emits a line when the record itself cannot be serialized", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const circular: Record<string, unknown> = { tag: "flock.test" };
    circular.self = circular;
    expect(() => logRecord(circular as { tag: string })).not.toThrow();
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      tag: "flock.test",
      logError: "record_not_serializable",
    });
  });
});

describe("createTraceId", () => {
  it("is short and distinct per turn", () => {
    const first = createTraceId();
    expect(first).toHaveLength(8);
    expect(first).not.toBe(createTraceId());
  });
});
