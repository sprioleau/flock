import { describe, expect, it } from "vitest";
import { assertHostResolvesPublic, isBlockedAddress, validateUrlSyntax } from "./url-guard";

describe("IPv4-mapped IPv6 addresses", () => {
  it.each([
    ["::ffff:127.0.0.1", "dotted loopback"],
    ["::ffff:7f00:1", "hexadecimal loopback"],
    ["0:0:0:0:0:ffff:7f00:1", "fully expanded hexadecimal loopback"],
    ["::ffff:192.168.1.10", "dotted private address"],
    ["::ffff:c0a8:010a", "hexadecimal private address"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
    expect(validateUrlSyntax(`http://[${ip}]/`).isAllowed).toBe(false);
  });

  it.each([
    ["::ffff:8.8.8.8", "dotted public address"],
    ["::ffff:808:808", "hexadecimal public address"],
  ])("allows %s (%s) and preserves literal-address guard behavior", async (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
    const syntax = validateUrlSyntax(`https://[${ip}]/`);
    expect(syntax.isAllowed).toBe(true);
    if (syntax.isAllowed) {
      await expect(assertHostResolvesPublic(syntax.url)).resolves.toMatchObject({ isAllowed: true });
    }
  });

  it("continues to allow a regular public IPv6 literal", () => {
    expect(validateUrlSyntax("https://[2001:4860:4860::8888]/").isAllowed).toBe(true);
  });
});
