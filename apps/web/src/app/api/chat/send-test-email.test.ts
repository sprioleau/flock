import { createEmptyDocument } from "@flock/email-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMissingSendConfigKeys, sendTestEmailWithResend } from "./send-test-email";

/**
 * The gates {@link sendTestEmailWithResend} applies BEFORE it would ever reach
 * Resend. Both paths here short-circuit above the network, so these run for
 * real — no provider stub, and nothing leaves the machine. The delivery path
 * itself is exercised against the real provider in dev.
 */

const DOCUMENT = createEmptyDocument();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getMissingSendConfigKeys", () => {
  it("names both settings when the server has neither", () => {
    expect(getMissingSendConfigKeys({})).toEqual(["RESEND_API_KEY", "RESEND_FROM_EMAIL"]);
  });

  it("treats a blank value as missing", () => {
    expect(
      getMissingSendConfigKeys({ RESEND_API_KEY: "re_live_key", RESEND_FROM_EMAIL: "   " }),
    ).toEqual(["RESEND_FROM_EMAIL"]);
  });

  it("reports nothing missing once both are set", () => {
    expect(
      getMissingSendConfigKeys({
        RESEND_API_KEY: "re_live_key",
        RESEND_FROM_EMAIL: "Flock <hello@flockto.email>",
      }),
    ).toEqual([]);
  });
});

describe("sendTestEmailWithResend", () => {
  it("rejects a malformed recipient before looking at configuration", async () => {
    const outcome = await sendTestEmailWithResend({ doc: DOCUMENT, to: "nope", env: {} });
    expect(outcome).toEqual({
      isSent: false,
      reason: "invalid_recipient",
      message: '"nope" doesn\'t look like a valid email address.',
    });
  });

  it("reports an unconfigured server in product language, not env-var names", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await sendTestEmailWithResend({
      doc: DOCUMENT,
      to: "owner@example.com",
      env: {},
    });

    expect(outcome).toMatchObject({ isSent: false, reason: "not_configured" });
    expect(outcome).not.toMatchObject({ message: expect.stringContaining("RESEND") });

    // The operator still gets the specifics — in the server log.
    const loggedLine = errorLog.mock.calls[0]?.[0] as string;
    expect(JSON.parse(loggedLine)).toEqual({
      tag: "flock.sendTestEmail.notConfigured",
      missing: ["RESEND_API_KEY", "RESEND_FROM_EMAIL"],
    });
  });

  it("still reports not_configured when only the from-address is missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await sendTestEmailWithResend({
      doc: DOCUMENT,
      to: "owner@example.com",
      env: { RESEND_API_KEY: "re_live_key" },
    });
    expect(outcome).toMatchObject({ isSent: false, reason: "not_configured" });
  });
});
