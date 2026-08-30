import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OVERRIDE_RELEASED_FALLBACK_MESSAGE,
  OVERRIDE_REJECTED_FALLBACK_MESSAGE,
  OVERRIDE_THROTTLED_FALLBACK_MESSAGE,
  OVERRIDE_UNAVAILABLE_MESSAGE,
  OVERRIDE_UNLOCKED_FALLBACK_MESSAGE,
  redeemOwnerOverride,
  releaseOwnerOverride,
  resolveRedeemOutcome,
  resolveReleaseOutcome,
} from "./override-client";

/*
  What the /override page does with each answer the endpoint can give.

  The load-bearing test in this file is "passes the server's rejection through
  word for word". The ambiguity of "That password didn't match." is a security
  property (lib/auth/owner-override.ts): a wrong password and a deployment
  with no override configured must be indistinguishable. A well-meaning future
  edit that split them into two friendlier messages would break that silently,
  so it breaks this instead.
*/

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveRedeemOutcome", () => {
  it("unlocks on a success body and repeats what the server said", () => {
    expect(
      resolveRedeemOutcome({
        httpStatus: 200,
        body: { isUnlocked: true, message: "Credit limit lifted on this browser." },
      }),
    ).toEqual({ status: "unlocked", message: "Credit limit lifted on this browser." });
  });

  it("passes a 403 message through verbatim rather than explaining it", () => {
    const outcome = resolveRedeemOutcome({
      httpStatus: 403,
      body: { isUnlocked: false, message: "That password didn't match." },
    });
    expect(outcome).toEqual({ status: "rejected", message: "That password didn't match." });
    /*
      Nothing about deployments, configuration, or what to check next.
    */
    expect(outcome.message).not.toMatch(/deploy|configur|env|set up|enabled/i);
  });

  it("gives a 403 with no message the server's own wording, not a specialised one", () => {
    expect(resolveRedeemOutcome({ httpStatus: 403, body: null })).toEqual({
      status: "rejected",
      message: OVERRIDE_REJECTED_FALLBACK_MESSAGE,
    });
  });

  it("treats a 429 as its own state, distinct from a rejection", () => {
    const outcome = resolveRedeemOutcome({
      httpStatus: 429,
      body: { isUnlocked: false, message: "Too many attempts. Wait a minute and try again." },
    });
    expect(outcome).toEqual({
      status: "throttled",
      message: "Too many attempts. Wait a minute and try again.",
    });
    expect(outcome.message).not.toBe(OVERRIDE_REJECTED_FALLBACK_MESSAGE);
  });

  it("falls back to the limiter's wording when a 429 carries no message", () => {
    expect(resolveRedeemOutcome({ httpStatus: 429, body: {} })).toEqual({
      status: "throttled",
      message: OVERRIDE_THROTTLED_FALLBACK_MESSAGE,
    });
  });

  it("does not call a 500 a wrong password", () => {
    const outcome = resolveRedeemOutcome({ httpStatus: 500, body: null });
    expect(outcome).toEqual({ status: "failed", message: OVERRIDE_UNAVAILABLE_MESSAGE });
    expect(outcome.message).not.toBe(OVERRIDE_REJECTED_FALLBACK_MESSAGE);
  });

  it("refuses to call a 200 without isUnlocked a success", () => {
    expect(resolveRedeemOutcome({ httpStatus: 200, body: { message: "ok" } }).status).toBe(
      "failed",
    );
  });

  it("uses the fallback when a success body carries a blank message", () => {
    expect(
      resolveRedeemOutcome({ httpStatus: 200, body: { isUnlocked: true, message: "   " } }),
    ).toEqual({ status: "unlocked", message: OVERRIDE_UNLOCKED_FALLBACK_MESSAGE });
  });
});

describe("resolveReleaseOutcome", () => {
  it("reports the server's confirmation verbatim", () => {
    expect(
      resolveReleaseOutcome({ httpStatus: 200, body: { message: "Credit limit restored." } }),
    ).toEqual({ status: "released", message: "Credit limit restored." });
  });

  it("falls back when the confirmation carried no message", () => {
    expect(resolveReleaseOutcome({ httpStatus: 200, body: null })).toEqual({
      status: "released",
      message: OVERRIDE_RELEASED_FALLBACK_MESSAGE,
    });
  });

  it("reports a failed release rather than pretending it worked", () => {
    expect(resolveReleaseOutcome({ httpStatus: 500, body: null })).toEqual({
      status: "failed",
      message: OVERRIDE_UNAVAILABLE_MESSAGE,
    });
  });
});

describe("redeemOwnerOverride", () => {
  it("submits the password in the body, never the URL", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { isUnlocked: true, message: "Credit limit lifted on this browser." }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await redeemOwnerOverride("hunter2");

    expect(outcome.status).toBe("unlocked");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/api/auth/override");
    expect(String(url)).not.toContain("hunter2");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ password: "hunter2" });
    /*
      Same-origin credentials so the Set-Cookie actually lands.
    */
    expect(init?.credentials).toBe("same-origin");
  });

  it("returns the rejection message from a 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse(403, { isUnlocked: false, message: "That password didn't match." })),
    );
    expect(await redeemOwnerOverride("nope")).toEqual({
      status: "rejected",
      message: "That password didn't match.",
    });
  });

  it("returns the throttled state from a 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(429, {
          isUnlocked: false,
          message: "Too many attempts. Wait a minute and try again.",
        }),
      ),
    );
    expect(await redeemOwnerOverride("nope")).toEqual({
      status: "throttled",
      message: "Too many attempts. Wait a minute and try again.",
    });
  });

  it("survives a body that is not JSON at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("<html>502</html>", { status: 502 })),
    );
    expect(await redeemOwnerOverride("nope")).toEqual({
      status: "failed",
      message: OVERRIDE_UNAVAILABLE_MESSAGE,
    });
  });

  it("never throws out of a click handler when the network is down", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));
    await expect(redeemOwnerOverride("nope")).resolves.toEqual({
      status: "failed",
      message: OVERRIDE_UNAVAILABLE_MESSAGE,
    });
  });
});

describe("releaseOwnerOverride", () => {
  it("sends a DELETE and reports the confirmation", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { isUnlocked: false, message: "Credit limit restored." }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await releaseOwnerOverride()).toEqual({
      status: "released",
      message: "Credit limit restored.",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/api/auth/override");
    expect(init?.method).toBe("DELETE");
  });

  it("never throws when the network is down", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));
    await expect(releaseOwnerOverride()).resolves.toEqual({
      status: "failed",
      message: OVERRIDE_UNAVAILABLE_MESSAGE,
    });
  });
});
