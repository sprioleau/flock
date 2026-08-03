import { google } from "@ai-sdk/google";
import { checkDocumentIntegrity, ROOT_BLOCK_ID } from "@flock/email-sdk";
import { createUIMessageStream, createUIMessageStreamResponse, type LanguageModel } from "ai";
import {
  chatRequestBodySchema,
  MOCK_MODEL_HEADER,
  type ChatRequestErrorResponse,
  type FlockChatMessage,
} from "@/lib/chat-contract";
import { getSessionIdFromCookieHeader } from "@/lib/session-cookie";
import { chargeCreditForRequest } from "@/lib/auth/credits";
import { DEFAULT_GEMINI_MODEL_ID, MOCK_MODEL_ID } from "./constants";
import { toChatErrorText } from "./errors";
import { createMockChatModel } from "./mock-model";
import { runChatPipeline } from "./pipeline";

/**
 * POST /api/chat — Phase 3.2/3.3: natural language in, streamed validated
 * operations out (AI SDK v7 UI-message stream over SSE).
 *
 * Wire contract: src/lib/chat-contract.ts (request body, part types, error
 * payloads — the chat UI imports the same module).
 *
 * Model selection: Gemini (DEFAULT_GEMINI_MODEL_ID) when
 * GOOGLE_GENERATIVE_AI_API_KEY is set; the deterministic mock otherwise, or
 * whenever the request carries `x-flock-mock: 1` (CI/tests never need a key).
 */

function badRequest(body: ChatRequestErrorResponse): Response {
  return Response.json(body, { status: 400 });
}

function getLastUserText(messages: FlockChatMessage[]): string {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const text = lastUserMessage?.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");
  return text ?? "";
}

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return badRequest({
      error: "invalid_json",
      issues: [{ code: "invalid_json", message: "Request body is not valid JSON.", path: "" }],
    });
  }

  const parsedBody = chatRequestBodySchema.safeParse(json);
  if (!parsedBody.success) {
    return badRequest({
      error: "invalid_request",
      issues: parsedBody.error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path.map(String).join("."),
      })),
    });
  }
  const { id: threadId, messages, document, selectedBlockId } = parsedBody.data;
  // The anonymous session id rides the same-origin cookie (lib/session.ts
  // mirrors localStorage into it) — the generateImage executor registers
  // every generation under this session's library (Content Studio Stage S).
  const sessionId = getSessionIdFromCookieHeader(request.headers.get("cookie"));

  // Schema-valid but structurally broken documents (orphans, cycles, pointer
  // disagreements) are rejected before any model call — integrity failures
  // are terminal in the action taxonomy.
  const integrity = checkDocumentIntegrity(document);
  if (!integrity.isValid) {
    return badRequest({
      error: "invalid_document",
      issues: integrity.errors.map((error) => ({
        code: error.code,
        message: error.message,
        path: error.blockId ?? "",
      })),
    });
  }

  const hasGoogleApiKey = Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
  const isMockForced = request.headers.get(MOCK_MODEL_HEADER) === "1";
  const isUsingMockModel = isMockForced || !hasGoogleApiKey;

  // A chat turn is the primary inference path — it costs a credit. Charged
  // here, AFTER the request is known to be well-formed and BEFORE any stream
  // opens, so a rejected turn never bills and a billed turn always runs. Mock
  // runs spend no provider quota and are free (see lib/auth/credits.ts).
  const charge = await chargeCreditForRequest({ request, isMockRun: isUsingMockModel });
  if (!charge.isAllowed) {
    return Response.json(
      { error: "out_of_credits", message: charge.message },
      { status: 429 },
    );
  }

  const model: LanguageModel = isUsingMockModel
    ? createMockChatModel({
        lastUserText: getLastUserText(messages),
        selectedBlockId,
        // A trailing assistant message means this request is a continuation
        // round (tool results coming back) — the mock must close, not re-plan.
        isContinuationRequest: messages[messages.length - 1]?.role === "assistant",
        // Where a composed Phase 7.4 section is appended (the mock has no
        // document of its own — it only ever appends to the end).
        rootSectionCount: document[ROOT_BLOCK_ID]?.childrenIds.length ?? 0,
      })
    : google(DEFAULT_GEMINI_MODEL_ID);

  const stream = createUIMessageStream<FlockChatMessage>({
    // Reusing the incoming message history lets continuation rounds (tool
    // results, approval responses) merge into the SAME assistant message id
    // instead of replaying prior tool parts as a fresh message — without
    // this, every approve/deny re-renders duplicate chips client-side.
    originalMessages: messages,
    execute: ({ writer }) =>
      runChatPipeline({
        model,
        modelId: isUsingMockModel ? MOCK_MODEL_ID : DEFAULT_GEMINI_MODEL_ID,
        isUsingMockModel,
        messages,
        doc: document,
        selectedBlockId,
        threadId,
        sessionId,
        writer,
      }),
    onError: toChatErrorText,
  });

  return createUIMessageStreamResponse({ stream });
}
