import { describe, expect, it } from "vitest";
import { getSessionIdFromCookieHeader, SESSION_COOKIE_NAME } from "./session-cookie";

/**
 * The session cookie is how server-side API routes (the chat route's
 * generateImage executor) learn which anonymous session is calling — parsing
 * must survive multi-cookie headers, encoding, and absence.
 */
describe("getSessionIdFromCookieHeader", () => {
  it("finds the session id among other cookies", () => {
    const header = `theme=dark; ${SESSION_COOKIE_NAME}=abc-123; other=x`;
    expect(getSessionIdFromCookieHeader(header)).toBe("abc-123");
  });

  it("decodes URI-encoded values", () => {
    expect(getSessionIdFromCookieHeader(`${SESSION_COOKIE_NAME}=a%2Fb`)).toBe("a/b");
  });

  it("ignores cookies whose name merely contains the session name", () => {
    expect(getSessionIdFromCookieHeader(`x_${SESSION_COOKIE_NAME}=nope`)).toBeNull();
  });

  it("returns null for a missing header, missing cookie, or empty value", () => {
    expect(getSessionIdFromCookieHeader(null)).toBeNull();
    expect(getSessionIdFromCookieHeader("theme=dark")).toBeNull();
    expect(getSessionIdFromCookieHeader(`${SESSION_COOKIE_NAME}=`)).toBeNull();
  });

  it("survives malformed percent-encoding", () => {
    expect(getSessionIdFromCookieHeader(`${SESSION_COOKIE_NAME}=%zz`)).toBe("%zz");
  });
});
