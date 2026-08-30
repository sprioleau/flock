import { createEmptyDocument, createStarterDocument } from "@flock/email-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_TEST_SEND_RECIPIENTS,
  SEND_TEST_EMAIL_API_PATH,
} from "@/app/api/send-test-email/contract";
import {
  describeSentRecipients,
  deriveSubjectFromDocument,
  requestTestEmailSend,
  resolveDefaultRecipient,
  validateRecipient,
  validateRecipients,
} from "./send-test-email-client";

/*
  The decisions behind every test-send surface: which address is prefilled,
  which addresses are allowed to leave the browser, and what each server reply
  means in plain English. The components that render these are thin by design
  (the app's vitest environment is `node`, so there is no DOM to mount into) —
  everything worth pinning is here.
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
    /*
      Better Auth mints anonymous users a `temp-<id>@<domain>` address that no
      inbox receives — prefilling it would look like a working default and
      then silently fail to arrive.
    */
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
  it("posts the document and the recipient ARRAY to the human send route", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { messageId: "em_1", to: ["owner@example.com"] }));

    const result = await requestTestEmailSend({
      document: DOCUMENT,
      to: ["owner@example.com"],
      fetchImpl,
    });

    expect(result).toEqual({ isSent: true, recipients: ["owner@example.com"] });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(SEND_TEST_EMAIL_API_PATH);
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    /*
      `to` is an ARRAY on the wire, matching the frozen contract.
    */
    expect(Array.isArray(body.to)).toBe(true);
    expect(body).toEqual({ document: DOCUMENT, to: ["owner@example.com"] });
  });

  it("includes subject and previewText in the body only when they are set", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { messageId: "em_2", to: ["owner@example.com"] }));

    await requestTestEmailSend({
      document: DOCUMENT,
      to: ["owner@example.com"],
      subject: "  Quarterly update  ",
      previewText: "  A quick look inside  ",
      fetchImpl,
    });

    const withMeta = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    /*
      Trimmed, and present because the caller supplied them.
    */
    expect(withMeta).toEqual({
      document: DOCUMENT,
      to: ["owner@example.com"],
      subject: "Quarterly update",
      previewText: "A quick look inside",
    });

    fetchImpl.mockClear();
    await requestTestEmailSend({
      document: DOCUMENT,
      to: ["owner@example.com"],
      /*
        A whitespace-only subject is treated as absent so the server derives one.
      */
      subject: "   ",
      fetchImpl,
    });
    const withoutMeta = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(withoutMeta).toEqual({ document: DOCUMENT, to: ["owner@example.com"] });
    expect("subject" in withoutMeta).toBe(false);
    expect("previewText" in withoutMeta).toBe(false);
  });

  it("maps a multi-recipient success, echoing the server's trimmed `to` array", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { messageId: "em_3", to: ["a@b.com", "c@d.com"] }));

    const result = await requestTestEmailSend({
      document: DOCUMENT,
      to: ["a@b.com", "c@d.com"],
      fetchImpl,
    });

    expect(result).toEqual({ isSent: true, recipients: ["a@b.com", "c@d.com"] });
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
      to: ["owner@example.com"],
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
      to: ["owner@example.com"],
      fetchImpl,
    });

    expect(result.isSent).toBe(false);
    expect(result).toMatchObject({ kind: "not_configured" });
    /*
      The operator's problem stays in the server log; the user reads product
      language and is told who can fix it.
    */
    expect(result).not.toMatchObject({ message: expect.stringContaining("RESEND") });
    expect(result).toMatchObject({ message: expect.stringContaining("can’t send email yet") });
  });

  it("turns the route's identity refusal into copy that names the fix", async () => {
    /*
      A 401 here is not a problem with the draft or the address, so the dialog
      must not render it as "try again" — the user has to reload to get a
      session back, and nothing else they can do in the form will help.
    */
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(401, {
        error: "not_signed_in",
        message: "This Flock couldn't confirm who's sending — reload the page and try again.",
      }),
    );

    const result = await requestTestEmailSend({
      document: DOCUMENT,
      to: ["owner@example.com"],
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

    const result = await requestTestEmailSend({ document: DOCUMENT, to: ["nope"], fetchImpl });

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
      to: ["owner@example.com"],
      fetchImpl,
    });

    expect(result).toMatchObject({ isSent: false, kind: "send_failed" });
  });

  it("reports an unreachable server as a connection problem, not a send failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await requestTestEmailSend({
      document: DOCUMENT,
      to: ["owner@example.com"],
      fetchImpl,
    });

    expect(result).toMatchObject({
      isSent: false,
      kind: "unreachable",
      message: expect.stringContaining("check your connection"),
    });
  });
});

describe("validateRecipients", () => {
  it("asks for at least one address when every row is blank", () => {
    const result = validateRecipients(["", "   ", "\t"]);
    expect(result.isValid).toBe(false);
    expect(result).toMatchObject({ message: expect.stringContaining("at least one") });
  });

  it("asks for at least one address when the list is empty", () => {
    expect(validateRecipients([]).isValid).toBe(false);
  });

  it("drops blank rows and trims the survivors", () => {
    expect(validateRecipients(["  a@b.com  ", "", "   "])).toEqual({
      isValid: true,
      recipients: ["a@b.com"],
    });
  });

  it("dedupes case-insensitively, keeping the first occurrence and its order", () => {
    expect(validateRecipients(["A@B.com", "c@d.com", "a@b.COM"])).toEqual({
      isValid: true,
      recipients: ["A@B.com", "c@d.com"],
    });
  });

  it(`rejects more than ${MAX_TEST_SEND_RECIPIENTS} DISTINCT recipients`, () => {
    /*
      All six are valid and distinct, so only the count check can catch them.
    */
    const sixValid = ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com"];
    expect(sixValid).toHaveLength(MAX_TEST_SEND_RECIPIENTS + 1);
    const result = validateRecipients(sixValid);
    expect(result.isValid).toBe(false);
    expect(result).toMatchObject({ message: expect.stringContaining("at most") });
  });

  it("counts AFTER the dedupe, so a repeated address is not over the limit", () => {
    /*
      Six rows, but one is a dupe → five distinct → a legal send.
    */
    const result = validateRecipients([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
      "e@x.com",
      "A@X.com",
    ]);
    expect(result).toEqual({
      isValid: true,
      recipients: ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"],
    });
  });

  it("rejects the whole list when a single address is malformed, naming it", () => {
    const result = validateRecipients(["good@example.com", "nope"]);
    expect(result.isValid).toBe(false);
    expect(result).toMatchObject({ message: expect.stringContaining("nope") });
  });

  it("accepts one-to-five distinct real addresses", () => {
    expect(validateRecipients(["one@a.com", "two@b.com"])).toEqual({
      isValid: true,
      recipients: ["one@a.com", "two@b.com"],
    });
  });
});

describe("deriveSubjectFromDocument", () => {
  it("takes the draft's first heading as the subject", () => {
    /*
      The starter document opens with a heading (mirrors the server derivation).
    */
    expect(deriveSubjectFromDocument(createStarterDocument())).toBe("Welcome to Flock.");
  });

  it("returns empty for a document with no heading, deferring to the server fallback", () => {
    expect(deriveSubjectFromDocument(createEmptyDocument())).toBe("");
  });
});

describe("describeSentRecipients", () => {
  it("names the single inbox a solo send reached", () => {
    expect(describeSentRecipients(["owner@example.com"])).toBe("Sent to owner@example.com.");
  });

  it("counts the inboxes when a send reached several", () => {
    expect(describeSentRecipients(["a@b.com", "c@d.com", "e@f.com"])).toBe("Sent to 3 recipients.");
  });
});
