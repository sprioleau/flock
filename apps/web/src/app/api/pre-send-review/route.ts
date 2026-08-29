import { checkEmailCompatibility, CHECKED_EMAIL_CLIENT_LABELS } from "@flock/email-sdk/qa";
import {
  preSendReviewRequestBodySchema,
  type PreSendReviewErrorResponseBody,
  type PreSendReviewResponseBody,
} from "./contract";
import { toPreSendReviewFinding } from "./review-copy";

/**
 * POST /api/pre-send-review — the deterministic email QA pass, run before a
 * send rather than after one.
 *
 * Body: { "document": EmailDocument }.
 * 200 → { isChecked: true, findings, checkedClientLabels }
 *     → { isChecked: false, message }   (document could not be rendered)
 * 400 → invalid_json | invalid_document
 *
 * ZERO MODEL CALLS, which is why this route exists as its own endpoint rather
 * than as more work for the persona runner. The QA Reviewer persona spends
 * Gemini free-tier quota — 15 requests a minute, shared with production — to
 * form an opinion about renderability. This answers a strictly larger version
 * of that question from Can I Email's dataset, in single-digit milliseconds,
 * for nothing, and gives the same answer twice for the same document.
 *
 * NO IDENTITY GATE, following /api/render rather than /api/send-test-email.
 * The gate on the send route protects a real asset: a stranger with curl could
 * otherwise put arbitrary content in an arbitrary inbox over this project's
 * DKIM-signed domain. Nothing leaves the building here. The route renders the
 * caller's own document, reads it, and returns prose about it — it has no side
 * effects, writes nothing, and sends nothing, exactly like the preview
 * renderer the studio already calls on every preview.
 *
 * ADVISORY BY CONSTRUCTION. This route cannot block a send because it has no
 * connection to one: /api/send-test-email neither calls it nor waits for it,
 * and a client that never asks for a review sends exactly as it did before
 * this existed. The strongest form of "advisory, not autocratic" is a design
 * in which refusing is not expressible.
 */
export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    const body: PreSendReviewErrorResponseBody = {
      error: "invalid_json",
      message: "Request body must be valid JSON.",
    };
    return Response.json(body, { status: 400 });
  }

  const parsed = preSendReviewRequestBodySchema.safeParse(payload);
  if (!parsed.success) {
    const body: PreSendReviewErrorResponseBody = {
      error: "invalid_document",
      message: 'Request body must be an object of the form { "document": EmailDocument }.',
    };
    return Response.json(body, { status: 400 });
  }

  const doc = parsed.data.document;
  const result = await checkEmailCompatibility({ doc });

  /*
    An unrenderable document comes back 200 with `isChecked: false`. It is an
    outcome of reviewing, not a failed request — the caller asked a
    well-formed question and the honest answer is "this email does not render,
    so there was nothing to look at". Returning 5xx would make an advisory
    panel look like a broken server, and would tempt a caller into treating a
    review failure as a reason to stop.
  */
  if (!result.isChecked) {
    const body: PreSendReviewResponseBody = { isChecked: false, message: result.message };
    return Response.json(body);
  }

  const body: PreSendReviewResponseBody = {
    isChecked: true,
    findings: result.findings.map((finding) => toPreSendReviewFinding({ finding, doc })),
    checkedClientLabels: result.checkedClients.map(
      (client) => CHECKED_EMAIL_CLIENT_LABELS[client],
    ),
  };
  return Response.json(body);
}
