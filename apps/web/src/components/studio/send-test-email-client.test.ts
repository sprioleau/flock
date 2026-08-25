import { createEmptyDocument } from "@flock/email-sdk";
import { describe, expect, it, vi } from "vitest";
import { SEND_TEST_EMAIL_API_PATH } from "@/app/api/send-test-email/contract";
import {
  requestTestEmailSend,
  resolveDefaultRecipient,
  validateRecipient,
} from "./send-test-email-client";

/**
 * The decisions behind every test-send surface: which address is prefilled,
 * which addresses are allowed to leave the browser, and what each server reply
 * means in plain English. The components that render these are thin by design
 * (the app's vitest environment is `node`, so there is no DOM to mount into) —
 * everything worth pinning is here.
 */

const DOCUMENT = createEmptyDocument();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("resolveDefaultRecipient", () => {
  it("prefers the signed-in user's own address", () => {
    expect(
      resolveDefaultRecipient({
        identity: { email: "owner@example.com", isAnonymous: false },
        lastUsedRecipient: "someone-else@example.com",
      }),
    ).toBe("owner@example.com");
  });

  it("never prefills an anonymous identity's synthetic address", () => {
    // Better Auth mints anonymous users a `temp-<id>@<domain>` address that no
    // inbox receives — prefilling it would look like a working default and
    // then silently fail to arrive.
    expect(
      resolveDefaultRecipient({
        identity: { email: "temp-abc123@flockto.email", isAnonymous: true },
        lastUsedRecipient: "real@example.com",
      }),
    ).toBe("real@example.com");
  });

  it("falls back to the last-used address when signed out", () => {
    expect(
      resolveDefaultRecipient({ identity: null, lastUsedRecipient: "  real@example.com  " }),
    ).toBe("real@example.com");
  });

  it("falls back to the last-used address while the identity is still loading", () => {
    expect(
      resolveDefaultRecipient({ identity: undefined, lastUsedRecipient: "real@example.com" }),
    ).toBe("real@example.com");
  });

  it("resolves to an empty field when there is nothing sensible to suggest", () => {
    expect(resolveDefaultRecipient({ identity: null, lastUsedRecipient: "" })).toBe("");
  });
});

describe("validateRecipient", () => {
  it("asks for an address when the field is blank", () => {
    const result = validateRecipient("   ");
    expect(result.isValid).toBe(false);
    expect(result).toMatchObject({ message: expect.stringContaining("Enter the email address") });
  });

  it("rejects a malformed address by name", () => {
    const result = validateRecipient("nope");
    expect(result.isValid).toBe(false);
    expect(result).toMatchObject({ message: expect.stringContaining("nope") });
  });

  it("accepts and trims a real address", () => {
    expect(validateRecipient("  owner@example.com ")).toEqual({
      isValid: true,
      recipient: "owner@example.com",
    });
  });
});

describe("requestTestEmailSend", () => {
  it("posts the document and recipient to the human send route", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { messageId: "em_1", to: "owner@example.com" }));

    const result = await requestTestEmailSend({
      document: DOCUMENT,
      to: "owner@example.com",
      fetchImpl,
    });

    expect(result).toEqual({ isSent: true, recipient: "owner@example.com" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(SEND_TEST_EMAIL_API_PATH);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      document: DOCUMENT,
      to: "owner@example.com",
    });
  });

  it("reports a provider failure with the server's user-facing copy", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(502, {
        error: "send_failed",
        message: "The test email wasn't sent: the email service returned an unexpected error.",
      }),
    );

    const result = await requestTestEmailSend({
      document: DOCUMENT,
      to: "owner@example.com",
      fetchImpl,
    });

    expect(result).toEqual({
      isSent: false,
      kind: "send_failed",
      message: "The test email wasn't sent: the email service returned an unexpected error.",
    });
  });

  it("explains an unconfigured server without naming any environment variable", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(503, {
        error: "not_configured",
        message: "The test email wasn't sent: this server can't send email yet.",
      }),
    );

    const result = await requestTestEmailSend({
      document: DOCUMENT,
      to: "owner@example.com",
      fetchImpl,
    });

    expect(result.isSent).toBe(false);
    expect(result).toMatchObject({ kind: "not_configured" });
    // The operator's problem stays in the server log; the user reads product
    // language and is told who can fix it.
    expect(result).not.toMatchObject({ message: expect.stringContaining("RESEND") });
    expect(result).toMatchObject({ message: expect.stringContaining("can’t send email yet") });
  });

  it("turns the route's identity refusal into copy that names the fix", async () => {
    // A 401 here is not a problem with the draft or the address, so the dialog
    // must not render it as "try again" — the user has to reload to get a
    // session back, and nothing else they can do in the form will help.
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(401, {
        error: "not_signed_in",
        message: "This Flock couldn't confirm who's sending — reload the page and try again.",
      }),
    );

    const result = await requestTestEmailSend({
      document: DOCUMENT,
      to: "owner@example.com",
      fetchImpl,
    });

    expect(result).toMatchObject({ isSent: false, kind: "not_signed_in" });
    expect(result).toMatchObject({ message: expect.stringContaining("reload the page") });
  });

  it("flags a rejected recipient so the field can be marked invalid", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(400, {
        error: "invalid_recipient",
        message: '"nope" doesn\'t look like a valid email address.',
      }),
    );

    const result = await requestTestEmailSend({ document: DOCUMENT, to: "nope", fetchImpl });

    expect(result).toEqual({
      isSent: false,
      kind: "invalid_recipient",
      message: '"nope" doesn\'t look like a valid email address.',
    });
  });

  it("survives a server reply that is not JSON at all", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("<html>502 Bad Gateway</html>", { status: 502 }));

    const result = await requestTestEmailSend({
      document: DOCUMENT,
      to: "owner@example.com",
      fetchImpl,
    });

    expect(result).toMatchObject({ isSent: false, kind: "send_failed" });
  });

  it("reports an unreachable server as a connection problem, not a send failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await requestTestEmailSend({
      document: DOCUMENT,
      to: "owner@example.com",
      fetchImpl,
    });

    expect(result).toMatchObject({
      isSent: false,
      kind: "unreachable",
      message: expect.stringContaining("check your connection"),
    });
  });
});
