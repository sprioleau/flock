import { checkDocumentIntegrity } from "@flock/email-sdk";
import { sendTestEmailWithResend } from "../chat/send-test-email";
import {
  sendTestEmailRequestBodySchema,
  type SendTestEmailErrorResponseBody,
  type SendTestEmailResponseBody,
} from "./contract";

/**
 * POST /api/send-test-email — the HUMAN path's test-send endpoint (the agent
 * path executes the same core module from the /api/chat sendTestEmail
 * executor, mirroring how /api/generate-image pairs with its chat executor).
 *
 * The chat flow gates sends behind a user-approval round because an AGENT
 * proposes them; here the click on the header's Send-test button IS that
 * explicit human intent (the analogue of the persona sweep's isManualSweep),
 * so this route dispatches straight into {@link sendTestEmailWithResend} —
 * same renderer, same subject derivation, same payload-hash idempotency key
 * (a re-click on an unchanged draft replays Resend's original response
 * instead of sending again), same user-facing error copy. There is exactly
 * ONE send path.
 *
 * Audit trail: the module writes the same flock.sendTestEmail.sent/.failed
 * log lines it writes for agent sends; this route adds one provenance line
 * marking the send as user-authored. A test send is a side effect, not a
 * document edit, so (as in the chat flow) nothing enters the op-log spine.
 */

function errorResponse(status: number, body: SendTestEmailErrorResponseBody): Response {
  return Response.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return errorResponse(400, {
      error: "invalid_request",
      message: "Request body is not valid JSON.",
    });
  }

  const parsedBody = sendTestEmailRequestBodySchema.safeParse(json);
  if (!parsedBody.success) {
    return errorResponse(400, {
      error: "invalid_request",
      message: parsedBody.error.issues.map((issue) => issue.message).join("; "),
    });
  }
  const { document, to } = parsedBody.data;

  // Schema-valid but structurally broken documents (orphans, cycles, pointer
  // disagreements) are rejected before rendering — mirroring /api/chat.
  const integrity = checkDocumentIntegrity(document);
  if (!integrity.isValid) {
    return errorResponse(400, {
      error: "invalid_document",
      message: "This draft couldn't be sent because its document failed an integrity check.",
    });
  }

  // Provenance: user-initiated from the studio header (the chat path's
  // ActionContext records author "agent"; this is the human counterpart).
  console.log(
    JSON.stringify({
      tag: "flock.sendTestEmail.userInitiated",
      author: "user",
      caller: "studio-header",
      to,
    }),
  );

  const outcome = await sendTestEmailWithResend({ doc: document, to });
  if (!outcome.isSent) {
    // invalid_recipient is the caller's input (400). not_configured is this
    // deployment missing a capability rather than a provider fault, so it is a
    // 503 the client renders as "not set up" instead of a retryable error. The
    // rest are provider or server conditions (502). Copy is already user-facing
    // from the module — the missing env keys are logged there, never returned.
    if (outcome.reason === "invalid_recipient") {
      return errorResponse(400, { error: "invalid_recipient", message: outcome.message });
    }
    if (outcome.reason === "not_configured") {
      return errorResponse(503, {
        error: "not_configured",
        message: `The test email wasn't sent: ${outcome.message}`,
      });
    }
    return errorResponse(502, {
      error: "send_failed",
      message: `The test email wasn't sent: ${outcome.message}`,
    });
  }

  const body: SendTestEmailResponseBody = { messageId: outcome.messageId, to };
  return Response.json(body);
}
