import { isDynamicToolUIPart, isToolUIPart } from "ai";
import type { FlockChatMessage } from "@/lib/chat-contract";
import { unwrapStringifiedToolInput } from "./model-schema";

/**
 * Make the CLIENT'S message history physically replayable to the provider.
 *
 * THE BUG THIS CLOSES (reproduced live, 2026-08-13, gemini-3.5-flash-lite):
 * "Add design variation" died mid-email with a turn-level
 *
 *   Invalid value at 'contents[1].parts[0].function_call.args'
 *   (type.googleapis.com/google.protobuf.Struct), "{\"name\":\"addSection\", …
 *
 * whose top-level Gemini message is the opaque "Request contains an invalid
 * argument." — and every later send in that thread failed the same way, before
 * the model ran at all.
 *
 * The chain, in order:
 *
 * 1. The model emits a tool call whose ARGUMENT TEXT is not parseable as a
 *    JSON object — truncated JSON, or the whole object as one escaped string
 *    (the mangle `unwrapStringifiedToolInput` exists for). Deep nested inputs
 *    like addSection's `children` are where this happens, so the section-by-
 *    section composition flows hit it most.
 * 2. Validation rejects it and the repair round cannot save it, so the SDK
 *    degrades it to an invalid tool call and streams `tool-input-error` with
 *    `input` = the RAW TEXT. The client stores that as a tool part in state
 *    "output-error" with `rawInput` holding a STRING.
 * 3. That part now lives in the thread. The client reports content-op results
 *    back and auto-continues (use-flock-chat's sendAutomaticallyWhen), so the
 *    poisoned history returns to us IMMEDIATELY, on the next round of the same
 *    turn — and on every send afterwards.
 * 4. `convertToModelMessages` replays an "output-error" part as an assistant
 *    tool-call whose `input` is `input ?? rawInput` — the string. @ai-sdk/google
 *    passes it to `functionCall.args` verbatim, a protobuf Struct cannot hold a
 *    string, and Gemini rejects the WHOLE request with HTTP 400.
 *
 * So one unsalvageable tool call poisons the thread permanently. Note what is
 * NOT wrong: the tool schemas, the document, and the validation gate all did
 * their job — the failure is that a REJECTED call's raw text was kept in a slot
 * the wire format requires to be an object.
 *
 * THE SAME DEFENCE ALREADY EXISTS TWICE, which is the argument for it being
 * here too: the AI SDK applies it to its own in-loop response messages
 * (`part.invalid && typeof part.input !== "object" ? {} : part.input`), and
 * pipeline.ts's `toReplayableToolInput` applies it to the failed call it
 * replays into a repair prompt. The client round-trip is the third seam and
 * was the only one left open.
 *
 * WHAT IS PRESERVED. The unwrap runs first, so a double-encoded envelope is
 * replayed as the object the model actually meant — the best possible signal
 * for it to correct itself. Only text that cannot parse to an object at all
 * degrades to `{}`, and then it is quoted into the part's `errorText` (capped)
 * so the model still sees what it sent. Nothing is invented, and a part whose
 * input is already an object is returned by identity.
 */

/** Cap on raw argument text quoted into a part's errorText. */
const MAX_QUOTED_RAW_INPUT_LENGTH = 2_000;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The tool-part fields this module reads and writes. UIMessage types each
 * tool's `input` to that tool's own operation type, which a repaired value can
 * never satisfy structurally — the point of the repair is that the value is
 * NOT a valid input. So the walk is done through this shape and cast back at
 * the boundary, where the alternative would be one cast per tool name.
 */
interface ReplayableToolPart {
  state: string;
  input?: unknown;
  rawInput?: unknown;
  errorText?: string;
}

/**
 * The value `convertToModelMessages` will put in the assistant tool-call's
 * `input` slot for this part — `input ?? rawInput` for a failed call, `input`
 * otherwise. Mirroring that choice here is what keeps this module honest: we
 * repair exactly the value that travels, not a value that looks like it.
 */
function readReplayedInput(part: ReplayableToolPart): unknown {
  return part.state === "output-error" ? (part.input ?? part.rawInput) : part.input;
}

function sanitizeToolPart(part: ReplayableToolPart): ReplayableToolPart {
  const replayedInput = readReplayedInput(part);
  // `undefined` is fine: the provider simply omits `args`. An ARRAY is not —
  // a protobuf Struct is an object, so arrays fail exactly like strings do.
  if (replayedInput === undefined || isJsonObject(replayedInput)) {
    return part;
  }

  const unwrapped = unwrapStringifiedToolInput(replayedInput);
  if (isJsonObject(unwrapped)) {
    return { ...part, input: unwrapped };
  }

  const rawText =
    typeof replayedInput === "string" ? replayedInput : JSON.stringify(replayedInput) ?? "";
  const quotedRawText = rawText.slice(0, MAX_QUOTED_RAW_INPUT_LENGTH);
  return {
    ...part,
    input: {},
    ...(part.errorText === undefined
      ? {}
      : {
          errorText: `${part.errorText}\nYour arguments were not valid JSON. They began: ${quotedRawText}`,
        }),
  };
}

/**
 * Rewrite any tool part whose replayed input is not a JSON object. Returns the
 * message list — and each message inside it — by IDENTITY when there is
 * nothing to repair, which is the overwhelmingly common case: this runs on
 * every chat request, and an untouched history must cost nothing.
 */
export function sanitizeReplayedToolInputs(messages: FlockChatMessage[]): FlockChatMessage[] {
  let nextMessages = messages;

  for (const [messageIndex, message] of messages.entries()) {
    let nextParts = message.parts;

    for (const [partIndex, part] of message.parts.entries()) {
      if (!isToolUIPart(part) && !isDynamicToolUIPart(part)) {
        continue;
      }
      const sanitizedPart = sanitizeToolPart(part as unknown as ReplayableToolPart);
      if (sanitizedPart === (part as unknown as ReplayableToolPart)) {
        continue;
      }
      if (nextParts === message.parts) {
        nextParts = [...message.parts];
      }
      nextParts[partIndex] = sanitizedPart as unknown as FlockChatMessage["parts"][number];
    }

    if (nextParts === message.parts) {
      continue;
    }
    if (nextMessages === messages) {
      nextMessages = [...messages];
    }
    nextMessages[messageIndex] = { ...message, parts: nextParts };
  }

  return nextMessages;
}
