import { emailDocumentSchema } from "@flock/email-sdk";
import { z } from "zod";

/**
 * /api/send-test-email wire contract — imported by both the route and the
 * studio header's Send-test dialog (isomorphic: Zod + types only).
 */

export const SEND_TEST_EMAIL_API_PATH = "/api/send-test-email";

export const sendTestEmailRequestBodySchema = z.strictObject({
  /** The draft to send — rendered server-side exactly as it will arrive. */
  document: emailDocumentSchema,
  /** Recipient address (format is validated by the send module itself). */
  to: z.string().trim().min(1, "Recipient address is required."),
});

export type SendTestEmailRequestBody = z.infer<typeof sendTestEmailRequestBodySchema>;

export interface SendTestEmailResponseBody {
  /** Resend's message id — proof the provider accepted the send. */
  messageId: string;
  /** The (trimmed) recipient the email went to — echoed for the success copy. */
  to: string;
}

export interface SendTestEmailErrorResponseBody {
  /**
   * `not_configured` is called out separately from `send_failed` because it is
   * not a failure the user can retry their way out of — this server has no
   * email service connected, so the UI says so instead of offering "try again".
   *
   * `not_signed_in` (401) is the route's identity gate. It is its own code
   * rather than a flavour of `send_failed` because the remedy is different in
   * kind: nothing about the draft or the address is wrong, the server just
   * doesn't know who is asking, and reloading the page fixes it (a visitor is
   * signed in anonymously on arrival). Rendering it as "try again" would send
   * the user hunting for a problem in copy that has none.
   *
   * `send_limit_reached` (429) is the send meter (convex/authTestSends.ts) —
   * the other half of that gate, since identity says who and never how many.
   * Distinct for the same reason again: the draft is fine, the address is fine,
   * the session is fine, and the only thing that changes the answer is time.
   * The `message` carries WHEN, computed from the window that actually blocked,
   * so it is the field to render — an "out of sends" of our own invention would
   * drop the one useful fact in it.
   */
  error:
    | "invalid_request"
    | "invalid_document"
    | "invalid_recipient"
    | "not_configured"
    | "not_signed_in"
    | "send_limit_reached"
    | "send_failed";
  /** User-facing copy — raw provider errors never reach this field. */
  message: string;
}
