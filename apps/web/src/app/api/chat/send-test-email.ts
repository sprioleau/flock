import { createHash } from "node:crypto";
import {
  renderToReactEmail,
  ROOT_BLOCK_ID,
  type BlockId,
  type EmailDocument,
  type InlineNode,
} from "@flock/email-sdk";
import { render } from "react-email";
import { Resend } from "resend";
import { z } from "zod";

/**
 * Phase 8.1 — REAL test sends via Resend.
 *
 * Server-only module (imported by the /api/chat editor-action seam). Renders
 * the CURRENT document to email HTML (+ plain-text fallback) with the SDK
 * renderer and sends it through Resend:
 *
 * - from    = RESEND_FROM_EMAIL (env default; per-document config is a future
 *             phase), reply-to = RESEND_REPLY_TO_EMAIL when set.
 * - subject = the document's first heading (the wire document carries no
 *             name/subject field), falling back to "Flock test email".
 * - Idempotency: the key is a hash of the exact send payload
 *   (from + to + subject + html). Resend replays the ORIGINAL response for
 *   the same key + same payload within 24h, so approval-loop double-fires
 *   (the scripted mock is known to re-emit approvals) can never double-send.
 *
 * The Resend Node SDK does NOT throw for API errors — it returns
 * `{ data, error }`; only network-level failures reject, which we catch.
 * Raw provider errors never leave this module: they go to the server log,
 * and callers get a clean human sentence in the outcome.
 */

export type SendTestEmailFailureReason =
  | "invalid_recipient"
  | "not_configured"
  | "render_failed"
  | "send_failed";

export type SendTestEmailOutcome =
  | { isSent: true; messageId: string; idempotencyKey: string }
  | { isSent: false; reason: SendTestEmailFailureReason; message: string };

// ---------------------------------------------------------------------------
// Configuration (env default only — per-document from-address is a future phase)
// ---------------------------------------------------------------------------

interface ResendSendConfig {
  apiKey: string;
  /** `"Display Name <a@b.c>"` or a bare address — passed to Resend verbatim. */
  fromEmail: string;
  replyToEmail?: string;
}

/** Undefined when sending is not configured (missing key or from address). */
function getResendSendConfig(env: Record<string, string | undefined>): ResendSendConfig | undefined {
  const apiKey = env.RESEND_API_KEY?.trim();
  const fromEmail = env.RESEND_FROM_EMAIL?.trim();
  if (apiKey === undefined || apiKey === "" || fromEmail === undefined || fromEmail === "") {
    return undefined;
  }
  const replyToEmail = env.RESEND_REPLY_TO_EMAIL?.trim();
  return {
    apiKey,
    fromEmail,
    ...(replyToEmail === undefined || replyToEmail === "" ? {} : { replyToEmail }),
  };
}

// ---------------------------------------------------------------------------
// Subject derivation
// ---------------------------------------------------------------------------

const FALLBACK_SUBJECT = "Flock test email";
const MAX_SUBJECT_LENGTH = 90;

function getInlineNodesText(nodes: InlineNode[] | undefined): string {
  if (nodes === undefined) {
    return "";
  }
  return nodes
    .map((node) => (node.type === "text" ? node.text : " "))
    .join("")
    .trim();
}

/**
 * The first heading's text, walking blocks in document order (depth-first via
 * childrenIds from the root). The wire document has no name/subject field, so
 * the lead heading is the most sensible subject; falls back to a constant.
 */
function deriveTestSendSubject(doc: EmailDocument): string {
  const rootBlock = doc[ROOT_BLOCK_ID];
  if (rootBlock === undefined) {
    return FALLBACK_SUBJECT;
  }
  const blockIdsToVisit: BlockId[] = [...rootBlock.childrenIds];
  while (blockIdsToVisit.length > 0) {
    const blockId = blockIdsToVisit.shift();
    const block = blockId === undefined ? undefined : doc[blockId];
    if (block === undefined) {
      continue;
    }
    if (block.type === "text") {
      for (const node of block.properties.text.content) {
        if (node.type === "heading") {
          const headingText = getInlineNodesText(node.content);
          if (headingText.length > 0) {
            return headingText.slice(0, MAX_SUBJECT_LENGTH);
          }
        }
      }
    }
    blockIdsToVisit.unshift(...block.childrenIds);
  }
  return FALLBACK_SUBJECT;
}

// ---------------------------------------------------------------------------
// Error shaping (raw provider errors stay server-side)
// ---------------------------------------------------------------------------

/**
 * Map a Resend API error to one clean human sentence fragment (no raw
 * provider text). 400/422-class errors are not retryable; 403 means a
 * domain/sandbox problem; 429 means backoff.
 */
function toFriendlySendFailureMessage(error: { name?: string; message?: string }): string {
  const errorName = error.name ?? "";
  const errorMessage = error.message ?? "";
  if (/api_key|unauthorized|invalid_access|restricted/i.test(errorName)) {
    return "the email service rejected this server's API key.";
  }
  if (/rate_limit/i.test(errorName)) {
    return "the email service is rate-limiting requests — try again in a moment.";
  }
  if (/domain|verif/i.test(errorMessage) || /forbidden|invalid_from_address/i.test(errorName)) {
    return "the configured sender address isn't verified with the email service.";
  }
  if (/testing email address|your own email/i.test(errorMessage)) {
    return "the sandbox sender can only deliver to the account owner's own address.";
  }
  if (/validation|invalid_parameter|missing_required_field/i.test(errorName)) {
    return "the email service rejected the request — double-check the recipient address.";
  }
  if (/idempoten/i.test(errorName)) {
    return "an identical send is already in flight — wait a moment before retrying.";
  }
  return "the email service returned an unexpected error.";
}

// ---------------------------------------------------------------------------
// The send
// ---------------------------------------------------------------------------

export interface SendTestEmailWithResendInput {
  /** The CURRENT document (this request's body) — rendered as sent. */
  doc: EmailDocument;
  /** Recipient — re-validated here so scripted callers get the same gate. */
  to: string;
  /** Env source, overridable in tests (e.g. `{}` to exercise not-configured). */
  env?: Record<string, string | undefined>;
}

/** Render the document and send it as a test email through Resend. */
export async function sendTestEmailWithResend({
  doc,
  to,
  env = process.env,
}: SendTestEmailWithResendInput): Promise<SendTestEmailOutcome> {
  const parsedRecipient = z.email().safeParse(to.trim());
  if (!parsedRecipient.success) {
    return {
      isSent: false,
      reason: "invalid_recipient",
      message: `"${to}" doesn't look like a valid email address.`,
    };
  }
  const recipient = parsedRecipient.data;

  const config = getResendSendConfig(env);
  if (config === undefined) {
    return {
      isSent: false,
      reason: "not_configured",
      message:
        "email sending isn't configured on this server yet (RESEND_API_KEY / RESEND_FROM_EMAIL are not set).",
    };
  }

  let subject: string;
  let html: string;
  let text: string;
  try {
    const email = renderToReactEmail(doc);
    subject = deriveTestSendSubject(doc);
    html = await render(email);
    text = await render(email, { plainText: true });
  } catch (error) {
    console.error(
      JSON.stringify({
        tag: "flock.sendTestEmail.renderFailed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return {
      isSent: false,
      reason: "render_failed",
      message: "the email couldn't be rendered to HTML.",
    };
  }

  // Same document + same recipient + same sender ⇒ same key ⇒ Resend returns
  // the original response instead of sending again (24h window). Any edit to
  // the document changes the html hash, so a genuinely new test send goes out.
  const payloadFingerprint = createHash("sha256")
    .update(JSON.stringify({ from: config.fromEmail, to: recipient, subject, html }))
    .digest("hex")
    .slice(0, 40);
  const idempotencyKey = `test-send/${payloadFingerprint}`;

  const resend = new Resend(config.apiKey);
  try {
    const { data, error } = await resend.emails.send(
      {
        from: config.fromEmail,
        to: [recipient],
        subject,
        html,
        text,
        ...(config.replyToEmail === undefined ? {} : { replyTo: config.replyToEmail }),
      },
      { idempotencyKey },
    );
    if (error !== null) {
      // Raw provider error: server log only — never the user-facing outcome.
      console.error(
        JSON.stringify({
          tag: "flock.sendTestEmail.failed",
          to: recipient,
          idempotencyKey,
          errorName: error.name,
          errorMessage: error.message,
        }),
      );
      return { isSent: false, reason: "send_failed", message: toFriendlySendFailureMessage(error) };
    }
    if (data === null) {
      return {
        isSent: false,
        reason: "send_failed",
        message: "the email service returned an unexpected empty response.",
      };
    }
    console.log(
      JSON.stringify({
        tag: "flock.sendTestEmail.sent",
        to: recipient,
        messageId: data.id,
        idempotencyKey,
      }),
    );
    return { isSent: true, messageId: data.id, idempotencyKey };
  } catch (error) {
    // The SDK only rejects for transport-level failures (DNS, TLS, proxy).
    console.error(
      JSON.stringify({
        tag: "flock.sendTestEmail.networkError",
        to: recipient,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return {
      isSent: false,
      reason: "send_failed",
      message: "the email service couldn't be reached from this server.",
    };
  }
}
