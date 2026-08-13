/**
 * The one logging module (Phase: production observability).
 *
 * WHY THIS SHAPE. Vercel Runtime Logs render ONE row per `console.*` call and
 * let you free-text search the message. A raw `console.error(error)` therefore
 * lands as a multi-line, unsearchable, uncountable blob. Every observability
 * record in this app is instead a SINGLE LINE of JSON with a leading `tag`
 * field, extending the convention `flock.chat.request` already established in
 * api/chat/pipeline.ts. One line = one row = greppable ("flock.model.failed")
 * and countable.
 *
 * WHERE IT GOES. stdout/stderr only — no network, no SDK, no account, no cost.
 * See docs/observability.md for the tooling decision and the Vercel menu path.
 *
 * REDACTION CONTRACT (deliberate exclusions — see docs/observability.md):
 *   - API keys, auth cookies, and the owner-override cookie value are NEVER
 *     read by this module and never appear in a record.
 *   - Email addresses are hashed by {@link hashIdentifier}, never logged raw.
 *   - `sessionId` is published to collaborators via presence so it is not a
 *     secret, but it is still logged as `sessionHash` because no diagnostic
 *     question needs it verbatim.
 *   - Prompts, message history, and document bodies are NEVER logged. The one
 *     exception is a REJECTED tool input, which is the whole point of the
 *     failure record and is truncated hard (see MAX_PAYLOAD_CHARS).
 */

// ---------------------------------------------------------------------------
// Truncation caps
// ---------------------------------------------------------------------------

/** Cap for a provider/exception message quoted into a record. */
export const MAX_MESSAGE_CHARS = 500;

/**
 * Cap for a serialized diagnostic payload (the rejected tool input). Chosen so
 * a whole 47k-character schema or a full email document can never reach a log
 * line, while still showing the shape of what the model actually sent —
 * roughly the first two dozen JSON fields, which is where a discriminator
 * mistake or a wrapper-shaped `children[0]` always shows up.
 */
export const MAX_PAYLOAD_CHARS = 1_000;

/** Cap on how many validation issues ride one record. */
export const MAX_ISSUE_COUNT = 10;

/** Cap for a single validation issue's message. */
export const MAX_ISSUE_MESSAGE_CHARS = 200;

/**
 * Truncate to `maxChars`, marking the cut so a reader never mistakes a clipped
 * value for a complete one. Returns the input unchanged when it already fits.
 */
export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…[+${text.length - maxChars}]`;
}

/**
 * Serialize any value for a log field and truncate it. Values that cannot be
 * serialized (cycles, BigInt) degrade to a marker rather than throwing — a
 * logging call must never be the thing that fails a request.
 */
export function truncateJson(value: unknown, maxChars: number = MAX_PAYLOAD_CHARS): string {
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    serialized = "[unserializable]";
  }
  return truncate(serialized, maxChars);
}

// ---------------------------------------------------------------------------
// Identifier hashing
// ---------------------------------------------------------------------------

/**
 * A short, stable, non-reversible tag for an identifier (session id, email).
 * Same input → same tag, so records CORRELATE, but the original value is not
 * in the log. FNV-1a: not cryptographic, and it does not need to be — this is
 * a correlation key, not an authentication token.
 */
export function hashIdentifier(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.length === 0) {
    return null;
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Stable, low-cardinality codes. These are what the owner FILTERS and COUNTS
 * on ("how many rate_limited yesterday"), so they must not drift with provider
 * copy — the human-readable prose lives in the separate `message` field.
 */
export type ModelErrorCode =
  | "invalid_tool_input"
  | "no_such_tool"
  | "tool_call_repair_failed"
  | "no_object_generated"
  | "type_validation_failed"
  | "rate_limited"
  | "provider_rejected"
  | "network_failed"
  | "timeout"
  | "aborted"
  | "retry_exhausted"
  | "unknown";

export interface ErrorSummary {
  /** Stable classification — filter and count on this. */
  code: ModelErrorCode;
  /** The constructor/AI-SDK name, e.g. "AI_InvalidToolInputError". */
  name: string;
  /** Truncated human-readable text. Never used for filtering. */
  message: string;
  /** HTTP status when the provider supplied one. */
  statusCode?: number;
  /**
   * The provider's own response body, truncated. Present only on an
   * APICallError that carried one.
   *
   * WHY IT EARNS A FIELD. `message` for a rejected Gemini request is the
   * generic "Request contains an invalid argument." — true and useless. The
   * body under it names the offending field:
   *
   *   Invalid value at 'contents[1].parts[0].function_call.args'
   *   (type.googleapis.com/google.protobuf.Struct), "{\"name\":\"addSection\"…
   *
   * That sentence is the entire difference between a diagnosable 400 and an
   * afternoon of bisecting, and it was previously discarded.
   */
  providerDetail?: string;
}

/**
 * Reach the real thrown value.
 *
 * The AI SDK hands telemetry integrations an ENVELOPE — `{ error }` — rather
 * than the error itself, and its stream funnels re-emit an already-formatted
 * failure as a bare STRING. Without this, both land as
 * `name: "object" / "string"`, `code: "unknown"`, `message: "[object Object]"`
 * — which was exactly what the first live run produced.
 */
export function unwrapThrown(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth++) {
    const isEnvelope =
      typeof current === "object" &&
      current !== null &&
      "error" in current &&
      !("message" in current);
    if (!isEnvelope) {
      return current;
    }
    current = (current as { error: unknown }).error;
  }
  return current;
}

/** `"AI_InvalidToolInputError: Invalid input for tool …"` → the name prefix. */
const STRINGIFIED_ERROR_PREFIX = /^((?:AI_)?[A-Za-z]*Error):/;

function readErrorName(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  if (typeof error === "object" && error !== null && "name" in error) {
    return String((error as { name: unknown }).name);
  }
  if (typeof error === "string") {
    return STRINGIFIED_ERROR_PREFIX.exec(error)?.[1] ?? "string";
  }
  return typeof error;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function readStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : undefined;
}

/**
 * Map a thrown value to a stable code. Name-first (AI SDK error classes carry
 * a stable `name` and survive being re-thrown across module instances, which
 * `instanceof` does not), then status code, then message shape.
 */
export function classifyModelError(thrown: unknown): ModelErrorCode {
  const error = unwrapThrown(thrown);
  const name = readErrorName(error);
  const nameCodes: Record<string, ModelErrorCode> = {
    AI_InvalidToolInputError: "invalid_tool_input",
    AI_NoSuchToolError: "no_such_tool",
    AI_ToolCallRepairError: "tool_call_repair_failed",
    AI_NoObjectGeneratedError: "no_object_generated",
    AI_TypeValidationError: "type_validation_failed",
    AI_JSONParseError: "type_validation_failed",
    AI_RetryError: "retry_exhausted",
    TimeoutError: "timeout",
    AbortError: "aborted",
  };
  const byName = nameCodes[name];
  if (byName !== undefined) {
    return byName;
  }

  const statusCode = readStatusCode(error);
  if (statusCode === 429) {
    return "rate_limited";
  }

  const message = readErrorMessage(error);
  if (/quota|RESOURCE_EXHAUSTED|rate.?limit|\b429\b/i.test(message)) {
    return "rate_limited";
  }
  if (/timed? ?out|ETIMEDOUT|deadline/i.test(message)) {
    return "timeout";
  }
  if (/abort/i.test(message)) {
    return "aborted";
  }
  if (/ENOTFOUND|ECONNRE|ECONNRESET|EAI_AGAIN|fetch failed|network/i.test(message)) {
    return "network_failed";
  }
  if (statusCode !== undefined || name === "AI_APICallError") {
    return "provider_rejected";
  }
  return "unknown";
}

/**
 * The provider's raw response body, when the thrown value is an APICallError
 * that carried one. Non-string bodies are serialized; `requestBodyValues` is
 * deliberately NOT read — it is the whole request, tool schemas included.
 */
function readProviderDetail(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const responseBody = (error as { responseBody?: unknown }).responseBody;
  if (responseBody === undefined || responseBody === null) {
    return undefined;
  }
  const detail = truncateJson(responseBody);
  return detail.length === 0 ? undefined : detail;
}

/** Classify + truncate a thrown value into the fields every failure record carries. */
export function summarizeError(thrown: unknown): ErrorSummary {
  const error = unwrapThrown(thrown);
  const statusCode = readStatusCode(error);
  const providerDetail = readProviderDetail(error);
  return {
    code: classifyModelError(error),
    name: readErrorName(error),
    message: truncate(readErrorMessage(error), MAX_MESSAGE_CHARS),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(providerDetail === undefined ? {} : { providerDetail }),
  };
}

/**
 * A signature that is equal for two records describing the SAME failure.
 *
 * The AI SDK re-reports one failure twice — once as the Error, once as the
 * string `"AI_InvalidToolInputError: <the same message>"` — so the leading
 * error-name prefix has to come off before the two can be compared.
 *
 * Takes the THROWN VALUE, not an {@link ErrorSummary}: the summary's message
 * is already truncated, and the extra 26-character prefix on the string
 * variant shifts the cut, so two truncated forms of one failure never match.
 * Observed live before this was fixed.
 */
export function toFailureSignature(thrown: unknown): string {
  const error = unwrapThrown(thrown);
  const normalizedMessage = readErrorMessage(error)
    .replace(STRINGIFIED_ERROR_PREFIX, "")
    .trimStart();
  return `${classifyModelError(error)}|${normalizedMessage.slice(0, MAX_MESSAGE_CHARS)}`;
}

// ---------------------------------------------------------------------------
// Validation issues
// ---------------------------------------------------------------------------

export interface LoggedValidationIssue {
  /** Zod issue code, e.g. "invalid_type" / "invalid_union". */
  code: string;
  /** Dotted path into the rejected input, e.g. "children.0.text". */
  path: string;
  message: string;
}

interface RawIssueShape {
  code?: unknown;
  path?: unknown;
  message?: unknown;
}

function toDottedPath(path: unknown): string {
  return Array.isArray(path) ? path.map(String).join(".") : "";
}

/**
 * Pull the Zod issue list off an AI SDK tool-input validation failure.
 *
 * The issues are the single most diagnostic thing in the whole pipeline — the
 * production failure this module exists for (`addSection` rejected because the
 * model wrapped `children[0].text` in a `type:"text"` envelope, omitted
 * `childrenIds` and `properties`, and got the `name` discriminator wrong) is
 * ONE GLANCE at codes + paths and completely invisible without them.
 *
 * Digs through the AI SDK's wrapping: InvalidToolInputError → `cause`
 * (TypeValidationError) → `cause` (ZodError with `.issues`).
 */
export function extractValidationIssues(thrown: unknown): LoggedValidationIssue[] {
  const seen = new Set<unknown>();
  let current: unknown = unwrapThrown(thrown);
  for (let depth = 0; depth < 5; depth++) {
    if (current === null || typeof current !== "object" || seen.has(current)) {
      break;
    }
    seen.add(current);
    const issues = (current as { issues?: unknown }).issues;
    if (Array.isArray(issues)) {
      return issues.slice(0, MAX_ISSUE_COUNT).map((issue: RawIssueShape) => ({
        code: typeof issue?.code === "string" ? issue.code : "unknown",
        path: toDottedPath(issue?.path),
        message: truncate(
          typeof issue?.message === "string" ? issue.message : "",
          MAX_ISSUE_MESSAGE_CHARS,
        ),
      }));
    }
    current = (current as { cause?: unknown }).cause;
  }
  return [];
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

/** Every record carries a `tag`; the rest is per-record. */
export interface LogRecord {
  tag: string;
  [field: string]: unknown;
}

/**
 * `console.error` (Vercel level "error") for failures, `console.log` (level
 * "info") for everything else. Vercel's Level filter reads stderr vs stdout,
 * so this is what makes "show me only failures" work in the dashboard.
 */
export type LogSeverity = "info" | "error";

/**
 * Drop undefined fields so a record's key set stays meaningful — a present key
 * always carries a real value, and `null` always means "known to be absent".
 */
function compact(record: LogRecord): LogRecord {
  const compacted: LogRecord = { tag: record.tag };
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      compacted[key] = value;
    }
  }
  return compacted;
}

/**
 * Write one single-line JSON record. Never throws: an observability failure
 * must not be able to fail the request it is observing.
 */
export function logRecord(record: LogRecord, severity: LogSeverity = "info"): void {
  let line: string;
  try {
    line = JSON.stringify(compact(record));
  } catch {
    line = JSON.stringify({ tag: record.tag, logError: "record_not_serializable" });
  }
  if (severity === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

/** Shorthand for the failure half — reads at the call site as what it is. */
export function logFailure(record: LogRecord): void {
  logRecord(record, "error");
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

/**
 * Mint the id that ties one request's records together. A single chat turn
 * produces a main-call record, zero or more repair records, and zero or more
 * per-tool failure records; they all carry the same `traceId`, so pasting it
 * into the Vercel Logs search box pulls exactly that turn and nothing else.
 */
export function createTraceId(): string {
  return crypto.randomUUID().slice(0, 8);
}
