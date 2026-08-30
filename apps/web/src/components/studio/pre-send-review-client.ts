import type { EmailDocument } from "@flock/email-sdk";
import {
  PRE_SEND_REVIEW_API_PATH,
  type PreSendReviewFinding,
} from "@/app/api/pre-send-review/contract";

/*
  The React-free half of the pre-send review: asking the server, and deciding
  what a given answer means. Kept out of the component for the same reason
  `send-test-email-client` is — every decision worth a test lives here, and
  the component becomes something that only renders.
*/

/*
  What the dialog knows at any moment.
*/
export type PreSendReviewOutcome =
  | { status: "checking" }
  /*
    The review ran. `findings` may be empty, which is the good answer.
  */
  | { status: "ready"; findings: PreSendReviewFinding[]; checkedClientLabels: string[] }
  /*
    The review did not produce an answer — the server was unreachable, the
    response was malformed, or the document would not render.

    There is deliberately no message and no retry. This panel is advisory, and
    an advisory that cannot advise should get out of the way rather than take
    up room in a send dialog explaining its own failure. A user came here to
    send an email; a broken checker is not their problem, and the send path
    does not consult this result in any case.
  */
  | { status: "unavailable" };

export async function requestPreSendReview(
  document: EmailDocument,
): Promise<PreSendReviewOutcome> {
  try {
    const response = await fetch(PRE_SEND_REVIEW_API_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document }),
    });
    if (!response.ok) {
      return { status: "unavailable" };
    }
    const body: unknown = await response.json();
    return interpretPreSendReviewResponse(body);
  } catch {
    return { status: "unavailable" };
  }
}

/*
  Read a parsed response body.

  Split out from the fetch so the interpretation can be tested without a
  network, and written defensively because a body that is not the shape this
  client expects is indistinguishable, from here, from a server that is
  broken — both mean "no advice", and neither is worth an error message in a
  send dialog.
*/
function isFinding(value: unknown): value is PreSendReviewFinding {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record: Record<string, unknown> = { ...value };
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.description === "string"
  );
}

export function interpretPreSendReviewResponse(body: unknown): PreSendReviewOutcome {
  if (typeof body !== "object" || body === null) {
    return { status: "unavailable" };
  }
  const record: Record<string, unknown> = { ...body };
  /*
    `isChecked: false` is a well-formed answer meaning "nothing was checked",
    which is the same thing to this panel as not reaching the server at all.
  */
  if (record.isChecked !== true) {
    return { status: "unavailable" };
  }
  const { findings, checkedClientLabels } = record;
  if (!Array.isArray(findings) || !findings.every(isFinding)) {
    return { status: "unavailable" };
  }
  return {
    status: "ready",
    findings,
    checkedClientLabels: Array.isArray(checkedClientLabels)
      ? checkedClientLabels.filter((label) => typeof label === "string")
      : [],
  };
}

/*
  The one line above the findings, or none at all.

  A CLEAN RESULT IS WORTH SAYING OUT LOUD, and this is the only place the
  scope of the check is stated. "No problems found" with no scope is a claim
  the tool cannot support — it looked at nine clients, not at every inbox in
  the world — and a user who later finds a rendering bug in a client that was
  never examined should be able to see that it was never examined.
*/
export function summarisePreSendReview(outcome: PreSendReviewOutcome): string | null {
  if (outcome.status !== "ready") {
    return null;
  }
  const clientCount = outcome.checkedClientLabels.length;
  if (outcome.findings.length === 0) {
    return `No client-support problems in ${clientCount} major email clients.`;
  }
  const problemCount = outcome.findings.length;
  return `${problemCount === 1 ? "1 thing" : `${problemCount} things`} to know before you send — none of them stops the send.`;
}
