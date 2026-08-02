import { describe, expect, it } from "vitest";
import { coarsenAddress, deriveOriginKey } from "./origin-key";

/**
 * The origin key is the anonymous allowance's anti-rotation scope, so the
 * properties that matter are: it must not vary within one subscriber's address
 * range (or the bucket is as rotatable as localStorage), and it must never
 * carry the address itself into the database.
 */

describe("coarsenAddress", () => {
  it("keeps an IPv4 address whole", () => {
    expect(coarsenAddress("203.0.113.7")).toBe("203.0.113.7");
  });

  it("truncates IPv6 to the /64 prefix a single subscriber controls", () => {
    expect(coarsenAddress("2001:db8:1234:5678:9abc:def0:1234:5678")).toBe(
      "2001:db8:1234:5678",
    );
  });

  it("collapses every address inside one /64 to the same value", () => {
    const first = coarsenAddress("2001:db8:1234:5678:1111:1111:1111:1111");
    const second = coarsenAddress("2001:db8:1234:5678:ffff:ffff:ffff:ffff");
    expect(first).toBe(second);
  });

  it("strips the brackets and port of a bracketed IPv6 address", () => {
    expect(coarsenAddress("[2001:db8:1234:5678::1]:443")).toBe("2001:db8:1234:5678");
  });
});

describe("deriveOriginKey", () => {
  function requestWithHeaders(headers: Record<string, string>): Request {
    return new Request("https://flockto.email/api/chat", { headers });
  }

  it("returns undefined when no address header is present", () => {
    expect(deriveOriginKey(requestWithHeaders({}))).toBeUndefined();
  });

  it("uses the first x-forwarded-for entry (the client, not the proxies)", () => {
    const viaProxies = deriveOriginKey(
      requestWithHeaders({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" }),
    );
    const direct = deriveOriginKey(requestWithHeaders({ "x-forwarded-for": "203.0.113.7" }));
    expect(viaProxies).toBe(direct);
  });

  it("falls back to x-real-ip", () => {
    expect(deriveOriginKey(requestWithHeaders({ "x-real-ip": "203.0.113.7" }))).toBe(
      deriveOriginKey(requestWithHeaders({ "x-forwarded-for": "203.0.113.7" })),
    );
  });

  it("never leaks the address into the key", () => {
    const key = deriveOriginKey(requestWithHeaders({ "x-forwarded-for": "203.0.113.7" }));
    expect(key).toBeDefined();
    expect(key).not.toContain("203.0.113.7");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("gives different networks different keys", () => {
    const first = deriveOriginKey(requestWithHeaders({ "x-forwarded-for": "203.0.113.7" }));
    const second = deriveOriginKey(requestWithHeaders({ "x-forwarded-for": "198.51.100.7" }));
    expect(first).not.toBe(second);
  });
});
