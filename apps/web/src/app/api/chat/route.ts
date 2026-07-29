import { google } from "@ai-sdk/google";
import { checkDocumentIntegrity } from "@tandem/email-sdk";
import { createUIMessageStream, createUIMessageStreamResponse, type LanguageModel } from "ai";
import {
  chatRequestBodySchema,
  MOCK_MODEL_HEADER,
  type ChatRequestErrorResponse,
  type TandemChatMessage,
} from "@/lib/chat-contract";
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
 * whenever the request carries `x-tandem-mock: 1` (CI/tests never need a key).
 */

function badRequest(body: ChatRequestErrorResponse): Response {
  return Response.json(body, { status: 400 });
}

function getLastUserText(messages: TandemChatMessage[]): string {
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
  const model: LanguageModel = isUsingMockModel
    ? createMockChatModel({ lastUserText: getLastUserText(messages), selectedBlockId })
    : google(DEFAULT_GEMINI_MODEL_ID);

  const stream = createUIMessageStream<TandemChatMessage>({
    execute: ({ writer }) =>
      runChatPipeline({
        model,
        modelId: isUsingMockModel ? MOCK_MODEL_ID : DEFAULT_GEMINI_MODEL_ID,
        isUsingMockModel,
        messages,
        doc: document,
        selectedBlockId,
        threadId,
        writer,
      }),
    onError: toChatErrorText,
  });

  return createUIMessageStreamResponse({ stream });
}
