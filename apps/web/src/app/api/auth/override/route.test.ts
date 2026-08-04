import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OWNER_OVERRIDE_COOKIE_NAME,
  deriveOwnerOverrideCookieValue,
} from "@/lib/auth/owner-override";
import { GET } from "./route";

/**
 * GET /api/auth/override — "does this browser already hold an override?"
 *
 * Only the GET handler is covered here. POST and DELETE both write cookies
 * through `next/headers`, which needs a request context this runner does not
 * provide; their compare logic lives in lib/auth/owner-override.ts and is
 * exercised there. GET is deliberately pure over the Cookie header, so it
 * tests against a plain `Request` with no Next runtime at all.
 *
 * The properties worth pinning are the security-shaped ones: a false is
 * indistinguishable between "wrong cookie" and "feature not configured", the
 * answer is never cacheable, and reading the status does NOT consume attempts
 * from the POST limiter.
 */

const PASSWORD = "correct-horse-battery-staple";

function makeRequest(cookieHeader?: string): Request {
  return new Request("http://localhost/api/auth/override", {
    method: "GET",
    ...(cookieHeader === undefined ? {} : { headers: { cookie: cookieHeader } }),
  });
}

function validCookie(password: string): string {
  return `${OWNER_OVERRIDE_COOKIE_NAME}=${deriveOwnerOverrideCookieValue(password)}`;
}

describe("GET /api/auth/override", () => {
  beforeEach(() => {
    process.env.FLOCK_OWNER_OVERRIDE_PASSWORD = PASSWORD;
  });

  afterEach(() => {
    delete process.env.FLOCK_OWNER_OVERRIDE_PASSWORD;
  });

  it("reports unlocked for a browser holding a cookie derived from the secret", async () => {
    const response = GET(makeRequest(validCookie(PASSWORD)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ isUnlocked: true });
  });

  it("reports locked when no cookie is sent at all", async () => {
    const response = GET(makeRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ isUnlocked: false });
  });

  it("reports locked for a cookie that is not derived from the current secret", async () => {
    const response = GET(makeRequest(validCookie("some-other-password")));
    expect(await response.json()).toEqual({ isUnlocked: false });
  });

  it("reports locked once the secret is rotated, invalidating outstanding overrides", async () => {
    const cookie = validCookie(PASSWORD);
    expect(await GET(makeRequest(cookie)).json()).toEqual({ isUnlocked: true });
    process.env.FLOCK_OWNER_OVERRIDE_PASSWORD = "rotated-secret";
    expect(await GET(makeRequest(cookie)).json()).toEqual({ isUnlocked: false });
  });

  it("answers a deployment with the feature switched off exactly like a bad cookie", async () => {
    const badCookieResponse = GET(makeRequest(`${OWNER_OVERRIDE_COOKIE_NAME}=nonsense`));
    const badCookieBody: unknown = await badCookieResponse.json();

    delete process.env.FLOCK_OWNER_OVERRIDE_PASSWORD;
    const disabledResponse = GET(makeRequest(validCookie(PASSWORD)));

    // Same status, same body. A probe cannot learn from this endpoint whether
    // an override exists on this deployment.
    expect(disabledResponse.status).toBe(badCookieResponse.status);
    expect(await disabledResponse.json()).toEqual(badCookieBody);
  });

  it("is never cacheable — the answer varies per cookie", () => {
    const response = GET(makeRequest(validCookie(PASSWORD)));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("is not metered by the POST attempt limiter", async () => {
    // Five attempts per minute is the POST budget. A status read is not an
    // attempt: reloading a page must never lock the owner out of their own UI.
    const request = makeRequest(validCookie(PASSWORD));
    for (let index = 0; index < 25; index += 1) {
      const response = GET(request);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ isUnlocked: true });
    }
  });

  it("ignores unrelated cookies sharing the header", async () => {
    const response = GET(
      makeRequest(`theme=dark; ${validCookie(PASSWORD)}; flock_session=abc`),
    );
    expect(await response.json()).toEqual({ isUnlocked: true });
  });
});
