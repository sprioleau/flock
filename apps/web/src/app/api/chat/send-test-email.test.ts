import { createEmptyDocument, createStarterDocument } from "@flock/email-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMissingSendConfigKeys, sendTestEmailWithResend } from "./send-test-email";

/**
 * The gates {@link sendTestEmailWithResend} applies BEFORE it would ever reach
 * Resend run for real here (no provider stub) — the first two describe blocks
 * short-circuit above the network, so nothing leaves the machine.
 *
 * The blocks that DO need to see the payload the module hands Resend — the
 * subject it resolves, the html it renders, the order-independent idempotency
 * key — stub the Resend client only (its `emails.send`), so the module's own
 * render + hashing still run for real and only the network call is captured.
 */

const DOCUMENT = createEmptyDocument();

/*
  Records the arguments the module passes Resend and reports success, so a test
  can assert on the resolved subject, the rendered html and the idempotency key
  without a network call. Hoisted so the `vi.mock` factory can close over it.
*/
const resendSendMock = vi.hoisted(() =>
  vi.fn<
    (
      payload: unknown,
      options: unknown,
    ) => Promise<{ data: { id: string }; error: null }>
  >(async () => ({ data: { id: "em_captured" }, error: null })),
);
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resendSendMock };
  },
}));

/*
  A server that CAN send, so the module runs all the way to the (stubbed) call.
*/
const CONFIGURED_ENV = {
  RESEND_API_KEY: "re_live_key",
  RESEND_FROM_EMAIL: "Flock <hello@flockto.email>",
};

/*
  The payload + idempotency options captured from the most recent stubbed send.
*/
function lastSendCall(): {
  payload: { to: string[]; subject: string; html: string };
  options: { idempotencyKey: string };
} {
  const call = resendSendMock.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error("expected the module to have called Resend");
  }
  return {
    payload: call[0] as { to: string[]; subject: string; html: string },
    options: call[1] as { idempotencyKey: string },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resendSendMock.mockClear();
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
    const outcome = await sendTestEmailWithResend({ doc: DOCUMENT, to: ["nope"], env: {} });
    expect(outcome).toEqual({
      isSent: false,
      reason: "invalid_recipient",
      message: '"nope" doesn\'t look like a valid email address.',
    });
  });

  it("fails the whole send when ANY address in the array is malformed", async () => {
    /*
      One bad entry among good ones is rejected as a unit — the same verdict
      Resend would return — rather than the module quietly dropping it.
    */
    const outcome = await sendTestEmailWithResend({
      doc: DOCUMENT,
      to: ["good@example.com", "nope"],
      env: {},
    });
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
      to: ["owner@example.com"],
      env: {},
    });

    expect(outcome).toMatchObject({ isSent: false, reason: "not_configured" });
    expect(outcome).not.toMatchObject({ message: expect.stringContaining("RESEND") });

    /*
      The operator still gets the specifics — in the server log.
    */
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
      to: ["owner@example.com"],
      env: { RESEND_API_KEY: "re_live_key" },
    });
    expect(outcome).toMatchObject({ isSent: false, reason: "not_configured" });
  });
});

describe("the subject the recipient sees", () => {
  it("derives the subject from the document's first heading when none is given", async () => {
    /*
      The agent path (and any caller that omits `subject`) keeps the behaviour
      it has always had: the lead heading becomes the subject.
    */
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const outcome = await sendTestEmailWithResend({
      doc: createStarterDocument(),
      to: ["owner@example.com"],
      env: CONFIGURED_ENV,
    });
    logSpy.mockRestore();

    expect(outcome).toMatchObject({ isSent: true });
    /*
      The starter document's first heading.
    */
    expect(lastSendCall().payload.subject).toBe("[Test] Welcome to Flock.");
  });

  it("uses the caller's subject verbatim when one is given, overriding the heading", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const outcome = await sendTestEmailWithResend({
      doc: createStarterDocument(),
      to: ["owner@example.com"],
      subject: "A subject the sender chose",
      env: CONFIGURED_ENV,
    });
    logSpy.mockRestore();

    expect(outcome).toMatchObject({ isSent: true });
    expect(lastSendCall().payload.subject).toBe("[Test] A subject the sender chose");
  });

  it("adds the test marker exactly once when the caller already includes it", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const outcome = await sendTestEmailWithResend({
      doc: createEmptyDocument(),
      to: ["owner@example.com"],
      subject: "[Test] Already marked",
      env: CONFIGURED_ENV,
    });
    logSpy.mockRestore();

    expect(outcome).toMatchObject({ isSent: true });
    expect(lastSendCall().payload.subject).toBe("[Test] Already marked");
  });
});

describe("subject and preview text reach the rendered html", () => {
  it("stamps a provided subject into <title> and preview text through <Preview>", async () => {
    /*
      The point of threading these into the render is that the email actually
      carries them; assert on the html the module hands the provider.
    */
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const outcome = await sendTestEmailWithResend({
      doc: createEmptyDocument(),
      to: ["owner@example.com"],
      subject: "Quarterly update",
      previewText: "The three things that changed this quarter",
      env: CONFIGURED_ENV,
    });
    logSpy.mockRestore();

    expect(outcome).toMatchObject({ isSent: true });
    const { html } = lastSendCall().payload;
    expect(html).toContain("<title>[Test] Quarterly update</title>");
    /*
      React Email's <Preview> emits the preheader text into a hidden div.
    */
    expect(html).toContain("The three things that changed this quarter");
  });
});

describe("the idempotency key is independent of recipient order", () => {
  /*
    `[a, b]` and `[b, a]` are the SAME send — a UI that reorders the chips, or a
    double-fire that rebuilt the list, must replay Resend's original response
    rather than deliver a second copy. The module sorts the recipients before
    hashing to make that true; this pins it.
  */
  it("produces the same key for the same recipients in a different order", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const doc = createEmptyDocument();

    await sendTestEmailWithResend({
      doc,
      to: ["a@example.com", "b@example.com"],
      subject: "Same send",
      env: CONFIGURED_ENV,
    });
    const forward = lastSendCall().options.idempotencyKey;

    await sendTestEmailWithResend({
      doc,
      to: ["b@example.com", "a@example.com"],
      subject: "Same send",
      env: CONFIGURED_ENV,
    });
    const reversed = lastSendCall().options.idempotencyKey;
    logSpy.mockRestore();

    expect(reversed).toBe(forward);
  });

  it("produces a DIFFERENT key when the recipient set actually differs", async () => {
    /*
      The order-independence must not collapse genuinely different sends into
      one — a different recipient set is a different key.
    */
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const doc = createEmptyDocument();

    await sendTestEmailWithResend({
      doc,
      to: ["a@example.com", "b@example.com"],
      subject: "Same send",
      env: CONFIGURED_ENV,
    });
    const pair = lastSendCall().options.idempotencyKey;

    await sendTestEmailWithResend({
      doc,
      to: ["a@example.com", "c@example.com"],
      subject: "Same send",
      env: CONFIGURED_ENV,
    });
    const different = lastSendCall().options.idempotencyKey;
    logSpy.mockRestore();

    expect(different).not.toBe(pair);
  });
});
