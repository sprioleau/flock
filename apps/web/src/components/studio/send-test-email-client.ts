import { ROOT_BLOCK_ID, type BlockId, type EmailDocument, type InlineNode } from "@flock/email-sdk";
import { z } from "zod";
import {
  MAX_TEST_SEND_RECIPIENTS,
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

export type RecipientsValidation =
  | { isValid: true; recipients: string[] }
  | { isValid: false; message: string };

/**
 * The gate for the whole recipient LIST — a test send goes to one-to-five
 * inboxes in a single email, so the form collects an ordered set of rows and
 * this decides whether that set may leave the browser.
 *
 * The rows are normalised before they are judged, because the person filling
 * them in should not be scolded for the shape of their own typing:
 *
 *   - each row is trimmed, and BLANK rows are dropped — an empty second row is
 *     "I only wanted one recipient", not an error to report;
 *   - the survivors are DEDUPED case-insensitively, first occurrence winning
 *     (order and the first row's own casing are preserved) — mailing the same
 *     inbox twice from one send is never the intent, and the send meter would
 *     otherwise bill it twice;
 *   - then, and only then, the structural limits apply: at least one address
 *     must remain, no more than {@link MAX_TEST_SEND_RECIPIENTS} may, and every
 *     survivor must pass the same per-address check the server re-runs.
 *
 * The count check is deliberately measured AFTER the dedupe, so "five distinct
 * addresses, one pasted twice" is six typed rows that resolve to a legal send
 * rather than a rejected one.
 *
 * Messages are returned, not thrown, so the form can render exactly one line of
 * copy beside the field the same way {@link validateRecipient} does.
 */
export function validateRecipients(recipients: string[]): RecipientsValidation {
  const trimmedRecipients = recipients.map((recipient) => recipient.trim());
  const seenRecipients = new Set<string>();
  const dedupedRecipients: string[] = [];
  for (const recipient of trimmedRecipients) {
    if (recipient === "") {
      continue;
    }
    const dedupeKey = recipient.toLowerCase();
    if (seenRecipients.has(dedupeKey)) {
      continue;
    }
    seenRecipients.add(dedupeKey);
    dedupedRecipients.push(recipient);
  }

  if (dedupedRecipients.length === 0) {
    return {
      isValid: false,
      message: "Enter at least one email address to send this test to.",
    };
  }

  if (dedupedRecipients.length > MAX_TEST_SEND_RECIPIENTS) {
    return {
      isValid: false,
      message: `A test send goes to at most ${MAX_TEST_SEND_RECIPIENTS} recipients.`,
    };
  }

  for (const recipient of dedupedRecipients) {
    const singleValidation = validateRecipient(recipient);
    if (!singleValidation.isValid) {
      return { isValid: false, message: singleValidation.message };
    }
  }

  return { isValid: true, recipients: dedupedRecipients };
}

// ---------------------------------------------------------------------------
// Deriving a subject from the draft (no server import)
// ---------------------------------------------------------------------------

/**
 * The longest subject we prefill from a heading. The canvas mutation caps the
 * stored value too (see convex/canvases.ts); this only bounds what we suggest.
 */
const MAX_DERIVED_SUBJECT_LENGTH = 90;

/** The visible text of a run of inline nodes; non-text nodes read as a space. */
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
 * The draft's first heading, in document order — the subject we prefill when
 * the canvas has none saved.
 *
 * This intentionally MIRRORS the server's `deriveTestSendSubject` walk rather
 * than importing it: that helper lives in a server-only module (it pulls in the
 * Resend SDK and `node:crypto`), and this module is the React-free half that
 * runs in the browser and under a `node` vitest with no server deps. The one
 * behavioural difference is the fallback: the server returns its "Flock test
 * email" constant, whereas this returns "" so an empty field defers to exactly
 * that server fallback instead of duplicating the constant here — the wire
 * contract makes `subject` optional precisely so an absent one derives server
 * side (see send-test-email/contract.ts).
 */
export function deriveSubjectFromDocument(document: EmailDocument): string {
  const rootBlock = document[ROOT_BLOCK_ID];
  if (rootBlock === undefined) {
    return "";
  }
  const blockIdsToVisit: BlockId[] = [...rootBlock.childrenIds];
  while (blockIdsToVisit.length > 0) {
    const blockId = blockIdsToVisit.shift();
    const block = blockId === undefined ? undefined : document[blockId];
    if (block === undefined) {
      continue;
    }
    if (block.type === "text") {
      for (const node of block.properties.text.content) {
        if (node.type === "heading") {
          const headingText = getInlineNodesText(node.content);
          if (headingText.length > 0) {
            return headingText.slice(0, MAX_DERIVED_SUBJECT_LENGTH);
          }
        }
      }
    }
    blockIdsToVisit.unshift(...block.childrenIds);
  }
  return "";
}

/**
 * The success line, phrased for how many inboxes the send actually reached: the
 * single-recipient case names the address (the one thing worth confirming),
 * while several recipients read as a count — five addresses spelled out would
 * be noise, and the list is already on screen in the form above.
 */
export function describeSentRecipients(recipients: string[]): string {
  if (recipients.length === 1) {
    return `Sent to ${recipients[0]}.`;
  }
  return `Sent to ${recipients.length} recipients.`;
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
  | { isSent: true; recipients: string[] }
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
  /** One to five, already trimmed and validated by {@link validateRecipients}. */
  to: string[];
  /**
   * The subject to send. Trimmed here; an empty/whitespace value is OMITTED
   * from the body entirely so the server derives one from the draft (the wire
   * contract makes it optional for exactly this reason).
   */
  subject?: string;
  /** Inbox-preview text. Trimmed and omitted when empty, same as `subject`. */
  previewText?: string;
  /** Injectable for tests; defaults to the ambient `fetch`. */
  fetchImpl?: typeof fetch;
}

/** POST the draft to the human send route and map the reply to UI-ready copy. */
export async function requestTestEmailSend({
  document,
  to,
  subject,
  previewText,
  fetchImpl,
}: RequestTestEmailSendInput): Promise<SendTestEmailResult> {
  const runFetch = fetchImpl ?? globalThis.fetch;
  const trimmedSubject = subject?.trim();
  const trimmedPreviewText = previewText?.trim();
  let response: Response;
  try {
    response = await runFetch(SEND_TEST_EMAIL_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        document,
        to,
        // Only sent when the user actually has one — an absent field lets the
        // server fall back rather than us shipping an empty subject/preview.
        ...(trimmedSubject !== undefined && trimmedSubject !== ""
          ? { subject: trimmedSubject }
          : {}),
        ...(trimmedPreviewText !== undefined && trimmedPreviewText !== ""
          ? { previewText: trimmedPreviewText }
          : {}),
      }),
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
    // The server echoes the trimmed `to` array it actually sent to; fall back
    // to what we posted if an older/edge reply omits it.
    return { isSent: true, recipients: payload.to ?? to };
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
      message: payload.message ?? "One of these addresses doesn’t look like a valid email address.",
    };
  }
  return {
    isSent: false,
    kind: "send_failed",
    message: payload.message ?? "The test email wasn’t sent — please try again.",
  };
}
