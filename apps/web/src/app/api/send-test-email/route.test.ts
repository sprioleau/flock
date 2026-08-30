import { createEmptyDocument, ROOT_BLOCK_ID, type BlockId } from "@flock/email-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendTestEmailOutcome } from "../chat/send-test-email";

const sendTestEmailWithResendMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<SendTestEmailOutcome>>(),
);
vi.mock("../chat/send-test-email", () => ({
  sendTestEmailWithResend: sendTestEmailWithResendMock,
}));

type ResolvedIdentity = { id: string; email: string; name: string; isAnonymous: boolean };

const fetchAuthQueryMock = vi.hoisted(() =>
  vi.fn<(...args: never[]) => Promise<ResolvedIdentity | null>>(),
);
vi.mock("@/lib/auth/auth-server", () => ({ fetchAuthQuery: fetchAuthQueryMock }));

type Reservation = { isAllowed: boolean; message: string; retryAtMs: number | null };

const reserveTestSendMock = vi.hoisted(() =>
  vi.fn<(...args: never[]) => Promise<Reservation>>(),
);
vi.mock("@/lib/auth/send-meter", () => ({ reserveTestSend: reserveTestSendMock }));

import { POST } from "./route";

/**
 * Request-contract tests for the HUMAN test-send endpoint. The send module
 * itself (rendering, idempotency key, Resend error shaping) is exercised
 * against the real provider in dev — here it is mocked so the tests pin the
 * route's validation gates and outcome→HTTP mapping.
 */

/** An anonymous visitor: the weakest identity the gate is meant to admit. */
const ANONYMOUS_VISITOR: ResolvedIdentity = {
  id: "user_anon_1",
  email: "temp-user_anon_1@flockto.email",
  name: "",
  isAnonymous: true,
};

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/send-test-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/send-test-email", () => {
  beforeEach(() => {
    sendTestEmailWithResendMock.mockReset();
    // Auth ON for the whole suite, so every case below goes through the real
    // identity gate rather than the auth-off bypass (which has its own test).
    vi.stubEnv("NEXT_PUBLIC_FLOCK_AUTH_ENABLED", "true");
    fetchAuthQueryMock.mockReset();
    fetchAuthQueryMock.mockResolvedValue(ANONYMOUS_VISITOR);
    // The meter allows by default so the cases below test what they name; the
    // metered cases set their own refusal. Its own arithmetic is tested against
    // a real backend in lib/auth/test-send-limits.test.ts.
    reserveTestSendMock.mockReset();
    reserveTestSendMock.mockResolvedValue({ isAllowed: true, message: "", retryAtMs: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * The identity gate. A click on the Send-test button and a curl at the same
   * URL are indistinguishable by the time they reach this handler, so "no
   * verified session" has to mean "no send" — and the assertion that carries
   * the security property is that the SEND MODULE was never reached, not that
   * some status code came back.
   */
  it("refuses a caller with no identity, and never reaches the send module", async () => {
    fetchAuthQueryMock.mockResolvedValue(null);
    const response = await POST(
      makeRequest({ document: createEmptyDocument(), to: ["stranger@example.com"] }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "not_signed_in" });
    expect(sendTestEmailWithResendMock).not.toHaveBeenCalled();
  });

  it("refuses the send when the identity check itself fails", async () => {
    // Fails CLOSED: an unreachable Convex must not reopen the anonymous-send
    // hole for the length of the outage.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchAuthQueryMock.mockRejectedValue(new Error("convex unreachable"));
    const response = await POST(
      makeRequest({ document: createEmptyDocument(), to: ["delivered@resend.dev"] }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "not_signed_in" });
    expect(sendTestEmailWithResendMock).not.toHaveBeenCalled();
    vi.mocked(console.warn).mockRestore();
  });

  it("admits an anonymous visitor and records their id as the send's owner", async () => {
    // Anonymous is the identity every browser gets on arrival, /demo included,
    // so this is the case that proves the gate costs a visitor nothing.
    sendTestEmailWithResendMock.mockResolvedValue({
      isSent: true,
      messageId: "em_test_anon",
      idempotencyKey: "test-send/anon",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await POST(
      makeRequest({ document: createEmptyDocument(), to: ["delivered@resend.dev"] }),
    );
    expect(response.status).toBe(200);
    expect(sendTestEmailWithResendMock).toHaveBeenCalledTimes(1);
    const provenance = logSpy.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.includes("flock.sendTestEmail.userInitiated"));
    expect(provenance).toBeDefined();
    expect(JSON.parse(provenance ?? "{}")).toMatchObject({
      caller: "http",
      ownerId: ANONYMOUS_VISITOR.id,
    });
    logSpy.mockRestore();
  });

  it("sends without an identity on a deployment with auth switched off", async () => {
    // No identities exist at all in that state, so a gate here would be a
    // permanently broken button rather than a control.
    vi.stubEnv("NEXT_PUBLIC_FLOCK_AUTH_ENABLED", "false");
    sendTestEmailWithResendMock.mockResolvedValue({
      isSent: true,
      messageId: "em_test_no_auth",
      idempotencyKey: "test-send/no-auth",
    });
    const response = await POST(
      makeRequest({ document: createEmptyDocument(), to: ["delivered@resend.dev"] }),
    );
    expect(response.status).toBe(200);
    expect(sendTestEmailWithResendMock).toHaveBeenCalledTimes(1);
    // Nothing was asked of Convex — there is nobody to ask about.
    expect(fetchAuthQueryMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON without touching the send module", async () => {
    const response = await POST(makeRequest("{not json"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(sendTestEmailWithResendMock).not.toHaveBeenCalled();
  });

  it("rejects a body without a document", async () => {
    const response = await POST(makeRequest({ to: ["delivered@resend.dev"] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(sendTestEmailWithResendMock).not.toHaveBeenCalled();
  });

  it("rejects a blank recipient", async () => {
    const response = await POST(makeRequest({ document: createEmptyDocument(), to: ["   "] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(sendTestEmailWithResendMock).not.toHaveBeenCalled();
  });

  it("rejects a structurally broken document (dangling child pointer)", async () => {
    const doc = createEmptyDocument();
    const brokenDoc = {
      ...doc,
      [ROOT_BLOCK_ID]: {
        ...doc[ROOT_BLOCK_ID]!,
        // Schema-valid id shape (prefix + 4 alphanumerics) that no block has
        // — schema passes, checkDocumentIntegrity flags the dangling pointer.
        childrenIds: ["sec_gone" as BlockId],
      },
    };
    const response = await POST(makeRequest({ document: brokenDoc, to: ["delivered@resend.dev"] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_document" });
    expect(sendTestEmailWithResendMock).not.toHaveBeenCalled();
  });

  it("sends through the shared module and returns the provider message id", async () => {
    sendTestEmailWithResendMock.mockResolvedValue({
      isSent: true,
      messageId: "em_test_123",
      idempotencyKey: "test-send/abc",
    });
    const document = createEmptyDocument();
    const response = await POST(makeRequest({ document, to: ["  delivered@resend.dev  "] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messageId: "em_test_123", to: ["delivered@resend.dev"] });
    // The recipient reaches the module trimmed; the doc rides through as-is.
    expect(sendTestEmailWithResendMock).toHaveBeenCalledWith({
      doc: document,
      to: ["delivered@resend.dev"],
      subject: undefined,
      previewText: undefined,
    });
  });

  it("carries several recipients, the subject and the preview text through to the module", async () => {
    // The dialog's full payload: up to five addresses plus an explicit subject
    // and preheader. The route threads all of them into the send module and
    // echoes the (trimmed) recipient list back in the response.
    sendTestEmailWithResendMock.mockResolvedValue({
      isSent: true,
      messageId: "em_multi",
      idempotencyKey: "test-send/multi",
    });
    const document = createEmptyDocument();
    const response = await POST(
      makeRequest({
        document,
        to: [" a@example.com ", "b@example.com", "c@example.com"],
        subject: "  Quarter in review  ",
        previewText: "  What changed  ",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      messageId: "em_multi",
      to: ["a@example.com", "b@example.com", "c@example.com"],
    });
    expect(sendTestEmailWithResendMock).toHaveBeenCalledWith({
      doc: document,
      to: ["a@example.com", "b@example.com", "c@example.com"],
      // The schema trims the optional fields before they reach the module.
      subject: "Quarter in review",
      previewText: "What changed",
    });
  });

  it("rejects a recipient list longer than the cap without touching the send module", async () => {
    const response = await POST(
      makeRequest({
        document: createEmptyDocument(),
        to: [
          "one@example.com",
          "two@example.com",
          "three@example.com",
          "four@example.com",
          "five@example.com",
          "six@example.com",
        ],
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(sendTestEmailWithResendMock).not.toHaveBeenCalled();
  });

  it("maps an invalid_recipient outcome to a 400 with the module's copy", async () => {
    sendTestEmailWithResendMock.mockResolvedValue({
      isSent: false,
      reason: "invalid_recipient",
      message: '"nope" doesn\'t look like a valid email address.',
    });
    const response = await POST(makeRequest({ document: createEmptyDocument(), to: ["nope"] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_recipient",
      message: '"nope" doesn\'t look like a valid email address.',
    });
  });

  it("maps a not_configured outcome to a 503 the client can tell apart", async () => {
    // Not a retryable provider fault — this deployment has no email service
    // connected, so the UI says "not set up" instead of "try again".
    sendTestEmailWithResendMock.mockResolvedValue({
      isSent: false,
      reason: "not_configured",
      message: "this server can't send email yet — no email service has been connected.",
    });
    const response = await POST(
      makeRequest({ document: createEmptyDocument(), to: ["delivered@resend.dev"] }),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("not_configured");
    // Missing env keys are logged server-side, never returned to the browser.
    expect(body.message).not.toContain("RESEND");
  });

  it("maps provider/server failures to a 502 with user-facing copy", async () => {
    sendTestEmailWithResendMock.mockResolvedValue({
      isSent: false,
      reason: "send_failed",
      message: "the email service returned an unexpected error.",
    });
    const response = await POST(
      makeRequest({ document: createEmptyDocument(), to: ["delivered@resend.dev"] }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "send_failed",
      message: "The test email wasn't sent: the email service returned an unexpected error.",
    });
  });

  /*
    THE SEND METER, at the route's own altitude. Its bucket arithmetic is proven
    against a real Convex backend in lib/auth/test-send-limits.test.ts; what
    these four pin is the part only this file can see — that the meter is wired
    into the path at all, in the right place, and that a refusal stops the send.
  */

  it("refuses a capped caller with a 429, and never reaches the send module", async () => {
    // The security property is the same one the identity gate's test carries:
    // not the status code, but that no mail was handed to the provider.
    reserveTestSendMock.mockResolvedValue({
      isAllowed: false,
      message: "You've used today's test sends — the allowance refills in about 3 hours.",
      retryAtMs: Date.now() + 3 * 60 * 60 * 1000,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await POST(
      makeRequest({ document: createEmptyDocument(), to: ["delivered@resend.dev"] }),
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "send_limit_reached",
      message: "You've used today's test sends — the allowance refills in about 3 hours.",
    });
    expect(sendTestEmailWithResendMock).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("meters the address the mail would actually go to", async () => {
    // The recipient bucket is only worth having if it is keyed to the inbox
    // that would receive the mail — the trimmed one the send module is given,
    // not the raw string the caller typed.
    sendTestEmailWithResendMock.mockResolvedValue({
      isSent: true,
      messageId: "em_metered",
      idempotencyKey: "test-send/metered",
    });
    await POST(makeRequest({ document: createEmptyDocument(), to: ["  delivered@resend.dev  "] }));

    expect(reserveTestSendMock).toHaveBeenCalledTimes(1);
    expect(reserveTestSendMock.mock.calls[0]?.[0]).toMatchObject({ to: ["delivered@resend.dev"] });
  });

  it("does not spend an allowance on a request it was going to reject anyway", async () => {
    // A broken draft never reaches an inbox, so charging for it would let a
    // malformed-body loop burn a real user's day out from under them.
    const doc = createEmptyDocument();
    const response = await POST(
      makeRequest({
        document: { ...doc, [ROOT_BLOCK_ID]: { ...doc[ROOT_BLOCK_ID]!, childrenIds: ["sec_gone" as BlockId] } },
        to: ["delivered@resend.dev"],
      }),
    );
    expect(response.status).toBe(400);
    expect(reserveTestSendMock).not.toHaveBeenCalled();
  });

  it("still meters when auth is switched off, where the identity gate does not apply", async () => {
    // The gate short-circuits on that deployment because no identity exists to
    // check. The METER must not: there is still an origin and still a
    // recipient, and leaving the one posture with no gate also unmetered would
    // be the most exposed configuration of the two.
    vi.stubEnv("NEXT_PUBLIC_FLOCK_AUTH_ENABLED", "false");
    reserveTestSendMock.mockResolvedValue({
      isAllowed: false,
      message: "That address has had a lot of test emails today.",
      retryAtMs: null,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await POST(
      makeRequest({ document: createEmptyDocument(), to: ["delivered@resend.dev"] }),
    );

    expect(fetchAuthQueryMock).not.toHaveBeenCalled();
    expect(reserveTestSendMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(429);
    expect(sendTestEmailWithResendMock).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
