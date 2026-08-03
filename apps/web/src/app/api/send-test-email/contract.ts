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
   */
  error:
    | "invalid_request"
    | "invalid_document"
    | "invalid_recipient"
    | "not_configured"
    | "send_failed";
  /** User-facing copy — raw provider errors never reach this field. */
  message: string;
}
