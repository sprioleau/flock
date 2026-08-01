import { createEmptyDocument, ROOT_BLOCK_ID, type BlockId } from "@flock/email-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SendTestEmailOutcome } from "../chat/send-test-email";

const sendTestEmailWithResendMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<SendTestEmailOutcome>>(),
);
vi.mock("../chat/send-test-email", () => ({
  sendTestEmailWithResend: sendTestEmailWithResendMock,
}));

import { POST } from "./route";

/**
 * Request-contract tests for the HUMAN test-send endpoint. The send module
 * itself (rendering, idempotency key, Resend error shaping) is exercised
 * against the real provider in dev — here it is mocked so the tests pin the
 * route's validation gates and outcome→HTTP mapping.
 */

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
  });

  it("rejects malformed JSON without touching the send module", async () => {
    const response = await POST(makeRequest("{not json"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(sendTestEmailWithResendMock).not.toHaveBeenCalled();
  });

  it("rejects a body without a document", async () => {
    const response = await POST(makeRequest({ to: "delivered@resend.dev" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(sendTestEmailWithResendMock).not.toHaveBeenCalled();
  });

  it("rejects a blank recipient", async () => {
    const response = await POST(makeRequest({ document: createEmptyDocument(), to: "   " }));
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
    const response = await POST(makeRequest({ document: brokenDoc, to: "delivered@resend.dev" }));
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
    const response = await POST(makeRequest({ document, to: "  delivered@resend.dev  " }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messageId: "em_test_123", to: "delivered@resend.dev" });
    // The recipient reaches the module trimmed; the doc rides through as-is.
    expect(sendTestEmailWithResendMock).toHaveBeenCalledWith({
      doc: document,
      to: "delivered@resend.dev",
    });
  });

  it("maps an invalid_recipient outcome to a 400 with the module's copy", async () => {
    sendTestEmailWithResendMock.mockResolvedValue({
      isSent: false,
      reason: "invalid_recipient",
      message: '"nope" doesn\'t look like a valid email address.',
    });
    const response = await POST(makeRequest({ document: createEmptyDocument(), to: "nope" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_recipient",
      message: '"nope" doesn\'t look like a valid email address.',
    });
  });

  it("maps provider/server failures to a 502 with user-facing copy", async () => {
    sendTestEmailWithResendMock.mockResolvedValue({
      isSent: false,
      reason: "send_failed",
      message: "the email service returned an unexpected error.",
    });
    const response = await POST(
      makeRequest({ document: createEmptyDocument(), to: "delivered@resend.dev" }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "send_failed",
      message: "The test email wasn't sent: the email service returned an unexpected error.",
    });
  });
});
