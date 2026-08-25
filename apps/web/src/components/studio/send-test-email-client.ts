import type { EmailDocument } from "@flock/email-sdk";
import { z } from "zod";
import {
  SEND_TEST_EMAIL_API_PATH,
  type SendTestEmailErrorResponseBody,
  type SendTestEmailResponseBody,
} from "@/app/api/send-test-email/contract";

/**
 * The client half of the test-send flow, as plain functions.
 *
 * Every surface that can send a test (the frame toolbar's Send-test dialog and
 * the HTML preview dialog's inline send row) goes through THIS module, which in
 * turn goes through POST /api/send-test-email — the one human send path, which
 * itself dispatches into the same `sendTestEmailWithResend` the chat approval
 * flow executes. Two entry points in the UI, one send path underneath.
 *
 * Deliberately React-free: the app's vitest environment is `node`, so keeping
 * recipient resolution, validation and response mapping out of components is
 * what makes the success / failure / not-configured paths testable at all.
 */

// ---------------------------------------------------------------------------
// Remembering the last recipient
// ---------------------------------------------------------------------------

/** Shared by every send surface, so they agree on "the address you last used". */
export const LAST_RECIPIENT_STORAGE_KEY = "flock:send-test-email:last-recipient";

/** Empty string when unset or when storage is unavailable (private mode). */
export function readLastUsedRecipient(): string {
  try {
    return window.localStorage.getItem(LAST_RECIPIENT_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveLastUsedRecipient(recipient: string): void {
  try {
    window.localStorage.setItem(LAST_RECIPIENT_STORAGE_KEY, recipient);
  } catch {
    // Storage unavailable — the prefill nicety is skipped, the send stands.
  }
}

// ---------------------------------------------------------------------------
// The default recipient
// ---------------------------------------------------------------------------

export interface DefaultRecipientInput {
  /**
   * The signed-in identity, or null/undefined when signed out, still loading,
   * or when the auth roll-out flag is off.
   */
  identity: { email: string; isAnonymous: boolean } | null | undefined;
  /** Whatever {@link readLastUsedRecipient} produced. */
  lastUsedRecipient: string;
}

/**
 * Who a test send should go to before the user types anything.
 *
 * The signed-in user's own address wins: it is the address they can actually
 * check, and it is the one that cannot be a typo. ANONYMOUS identities are
 * skipped on purpose — Better Auth mints those a synthetic `temp-<id>@<domain>`
 * address that no inbox will ever receive, so prefilling it would look like a
 * working default and silently fail. Those users fall through to the address
 * they last sent to, and finally to an empty field.
 */
export function resolveDefaultRecipient({
  identity,
  lastUsedRecipient,
}: DefaultRecipientInput): string {
  if (identity !== null && identity !== undefined && !identity.isAnonymous) {
    const signedInEmail = identity.email.trim();
    if (signedInEmail.length > 0) {
      return signedInEmail;
    }
  }
  return lastUsedRecipient.trim();
}

// ---------------------------------------------------------------------------
// Recipient validation (the same gate the server re-runs)
// ---------------------------------------------------------------------------

export type RecipientValidation =
  | { isValid: true; recipient: string }
  | { isValid: false; message: string };

/**
 * Bad addresses never leave the browser. The server re-validates regardless —
 * this only spares the user a round trip and gives them the message instantly.
 */
export function validateRecipient(recipient: string): RecipientValidation {
  const trimmedRecipient = recipient.trim();
  if (trimmedRecipient === "") {
    return { isValid: false, message: "Enter the email address to send this test to." };
  }
  if (!z.email().safeParse(trimmedRecipient).success) {
    return {
      isValid: false,
      message: `“${trimmedRecipient}” doesn’t look like a valid email address.`,
    };
  }
  return { isValid: true, recipient: trimmedRecipient };
}

// ---------------------------------------------------------------------------
// The send
// ---------------------------------------------------------------------------

export type SendTestEmailFailureKind =
  | "invalid_recipient"
  | "not_configured"
  | "not_signed_in"
  | "send_failed"
  | "unreachable";

export type SendTestEmailResult =
  | { isSent: true; recipient: string }
  | { isSent: false; kind: SendTestEmailFailureKind; message: string };

/**
 * Plain-language copy for a server that has no email delivery wired up. The
 * route names the missing settings in its own response, but the person looking
 * at the dialog is not the person who sets them, so what they see says what
 * happened and who can fix it — never an environment variable name.
 */
const NOT_CONFIGURED_MESSAGE =
  "This Flock can’t send email yet — whoever set it up needs to connect an email service first.";

/**
 * The route refuses a send it can’t attribute to a signed-in session. Reaching
 * this from the dialog means the session went missing mid-visit — everyone is
 * signed in anonymously on arrival — so the copy names the one thing that
 * fixes it. Owned here rather than echoed from the response for the same
 * reason as {@link NOT_CONFIGURED_MESSAGE}: “reload the page” is a fact about
 * the browser this dialog lives in, not about the server.
 */
const NOT_SIGNED_IN_MESSAGE =
  "Your session expired before this could send — reload the page and try again.";

export interface RequestTestEmailSendInput {
  /** The document to send — read from the store at submit time by the caller. */
  document: EmailDocument;
  /** Already trimmed and validated by {@link validateRecipient}. */
  to: string;
  /** Injectable for tests; defaults to the ambient `fetch`. */
  fetchImpl?: typeof fetch;
}

/** POST the draft to the human send route and map the reply to UI-ready copy. */
export async function requestTestEmailSend({
  document,
  to,
  fetchImpl,
}: RequestTestEmailSendInput): Promise<SendTestEmailResult> {
  const runFetch = fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await runFetch(SEND_TEST_EMAIL_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document, to }),
    });
  } catch {
    return {
      isSent: false,
      kind: "unreachable",
      message: "The test email couldn’t be sent — check your connection and try again.",
    };
  }

  let payload: Partial<SendTestEmailResponseBody & SendTestEmailErrorResponseBody>;
  try {
    payload = (await response.json()) as Partial<
      SendTestEmailResponseBody & SendTestEmailErrorResponseBody
    >;
  } catch {
    payload = {};
  }

  if (response.ok && payload.messageId !== undefined) {
    return { isSent: true, recipient: payload.to ?? to };
  }

  if (payload.error === "not_configured") {
    return { isSent: false, kind: "not_configured", message: NOT_CONFIGURED_MESSAGE };
  }
  if (payload.error === "not_signed_in") {
    return { isSent: false, kind: "not_signed_in", message: NOT_SIGNED_IN_MESSAGE };
  }
  if (payload.error === "invalid_recipient") {
    return {
      isSent: false,
      kind: "invalid_recipient",
      message: payload.message ?? `“${to}” doesn’t look like a valid email address.`,
    };
  }
  return {
    isSent: false,
    kind: "send_failed",
    message: payload.message ?? "The test email wasn’t sent — please try again.",
  };
}
