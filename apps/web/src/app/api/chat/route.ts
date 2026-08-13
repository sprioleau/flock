import { checkDocumentIntegrity, ROOT_BLOCK_ID } from "@flock/email-sdk";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import {
  chatRequestBodySchema,
  MOCK_MODEL_HEADER,
  type ChatRequestErrorResponse,
  type FlockChatMessage,
} from "@/lib/chat-contract";
import { getSessionIdFromCookieHeader } from "@/lib/session-cookie";
import { chargeCreditForRequest } from "@/lib/auth/credits";
import { hasOwnerOverride } from "@/lib/auth/owner-override";
import { createTraceId } from "@/lib/observability/log";
import { createChatErrorLogger } from "./errors";
import { createMockChatModel, readMockIntentText } from "./mock-model";
import { runChatPipeline } from "./pipeline";
import { resolveChatModel } from "./provider";

/**
 * POST /api/chat — Phase 3.2/3.3: natural language in, streamed validated
 * operations out (AI SDK v7 UI-message stream over SSE).
 *
 * Wire contract: src/lib/chat-contract.ts (request body, part types, error
 * payloads — the chat UI imports the same module).
 *
 * Model selection lives entirely in ./provider.ts — this route makes no
 * provider decision of its own. In one line: Gemini by default, OpenRouter
 * when the deployment (FLOCK_CHAT_PROVIDER) or an OWNER-OVERRIDDEN request
 * asks for it and its key is set, and the deterministic mock whenever the
 * request carries `x-flock-mock: 1` or no provider key exists at all (so CI
 * and tests never need a key). A request's `providerId` from an ordinary
 * visitor is ignored — see the security rule in ./provider.ts.
 */

function badRequest(body: ChatRequestErrorResponse): Response {
  return Response.json(body, { status: 400 });
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

  const { id: threadId, messages, document, selectedBlockId, providerId } = parsedBody.data;
  // The anonymous session id rides the same-origin cookie (lib/session.ts
  // mirrors localStorage into it) — the generateImage executor registers
  // every generation under this session's library (Content Studio Stage S).
  const sessionId = getSessionIdFromCookieHeader(request.headers.get("cookie"));
  // One id for the whole turn. Minted here rather than in the pipeline so the
  // route-level error funnel below shares it with everything the pipeline logs.
  const traceId = createTraceId();

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

  // The whole provider decision, in one call. Resolved BEFORE the charge
  // because `isUsingMockModel` decides whether this turn is billable at all.
  const { model, modelId, isUsingMockModel } = resolveChatModel({
    requestedProviderId: providerId,
    // A client-supplied providerId is honoured only for the owner; everyone
    // else gets the deployment default no matter what they send.
    hasOwnerOverride: hasOwnerOverride(request.headers.get("cookie")),
    isMockForced: request.headers.get(MOCK_MODEL_HEADER) === "1",
    createMockModel: () =>
      createMockChatModel({
        lastUserText: readMockIntentText(messages),
        selectedBlockId,
        // A trailing assistant message means this request is a continuation
        // round (tool results coming back) — the mock must close, not re-plan.
        isContinuationRequest: messages[messages.length - 1]?.role === "assistant",
        // Where a composed Phase 7.4 section is appended (the mock has no
        // document of its own — it only ever appends to the end).
        rootSectionCount: document[ROOT_BLOCK_ID]?.childrenIds.length ?? 0,
      }),
  });

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

  const stream = createUIMessageStream<FlockChatMessage>({
    // Reusing the incoming message history lets continuation rounds (tool
    // results, approval responses) merge into the SAME assistant message id
    // instead of replaying prior tool parts as a fresh message — without
    // this, every approve/deny re-renders duplicate chips client-side.
    originalMessages: messages,
    execute: ({ writer }) =>
      runChatPipeline({
        model,
        modelId,
        isUsingMockModel,
        messages,
        doc: document,
        selectedBlockId,
        threadId,
        sessionId,
        traceId,
        writer,
      }),
    onError: createChatErrorLogger({ traceId, source: "pipeline" }),
  });

  return createUIMessageStreamResponse({ stream });
}

