import { emailDocumentSchema } from "@flock/email-sdk";
import { z } from "zod";

/*
  /api/pre-send-review wire contract — imported by both the route and the
  send-test surfaces (isomorphic: Zod + types only, no server imports).

  WHY THIS IS A SEPARATE ROUTE from /api/send-test-email rather than a field
  on its response. The review has to be readable BEFORE the send, and a
  result attached to the send arrives strictly after it. It is also the whole
  posture of the feature: the reviewing endpoint has no side effects at all
  and the sending endpoint cannot consult it, so there is no code path in
  which a compatibility finding can delay, gate, or refuse a send. Advisory
  is enforced by the shape of the system, not by remembering to allow it.
*/

export const PRE_SEND_REVIEW_API_PATH = "/api/pre-send-review";

export const preSendReviewRequestBodySchema = z.strictObject({
  /*
    The draft to review — rendered server-side exactly as it would send.
  */
  document: emailDocumentSchema,
});

export type PreSendReviewRequestBody = z.infer<typeof preSendReviewRequestBodySchema>;

/*
  One thing worth knowing before sending, already phrased for a person.
*/
export interface PreSendReviewFinding {
  /*
    Stable identity for React keys and for de-duplicating across refetches.
  */
  id: string;
  /*
    Card headline, e.g. `Rounded corners are ignored in Outlook (Windows)`.
  */
  title: string;
  /*
    One sentence: what is affected, where it breaks, and what happens.
  */
  description: string;
  /**
   * The block this is about, or undefined when it belongs to the email as a
   * whole. Carried so a future surface can highlight the block on the canvas;
   * the dialog itself shows {@link title} and {@link description}.
   */
  blockId: string | undefined;
}

export type PreSendReviewResponseBody =
  | {
      isChecked: true;
      findings: PreSendReviewFinding[];
      /*
        The clients that were actually examined — the scope of a clean result.
      */
      checkedClientLabels: string[];
    }
  | {
      /*
        The document could not be rendered, so nothing was checked. This is a
        200, not an error status: it is an OUTCOME of the review, and the
        send-side surfaces treat "we could not look" and "we looked and found
        nothing" as the same thing — neither one stops a send.
      */
      isChecked: false;
      message: string;
    };

export interface PreSendReviewErrorResponseBody {
  error: "invalid_json" | "invalid_document";
  message: string;
}
