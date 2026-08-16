import { describe, expect, it } from "vitest";
import { MAX_BRAND_ASSET_URL_LENGTH, validateBrandAssetUrl } from "./brand-asset-url";

/*
  The typed-asset-URL guard (brand-kit-user-control §6.2). It is deliberately
  only the SYNTAX half — the DNS-resolving guard still runs in the confirm
  route before anything is fetched — so what this suite pins is that the cheap
  refusals really are refused at the moment of typing, and that a legitimate
  address survives normalization intact.
*/

describe("validateBrandAssetUrl", () => {
  it("accepts a public https image URL and stores it normalized", () => {
    expect(validateBrandAssetUrl("  HTTPS://Acme.com/Logo.svg  ")).toEqual({
      isValid: true,
      url: "https://acme.com/Logo.svg",
    });
  });

  it("keeps the query string, which many CDNs need to serve the right asset", () => {
    const result = validateBrandAssetUrl("https://cdn.acme.com/logo.png?w=512");
    expect(result).toEqual({ isValid: true, url: "https://cdn.acme.com/logo.png?w=512" });
  });

  it("refuses a data: URI — the confirm route may only decode ones it produced", () => {
    const result = validateBrandAssetUrl("data:image/svg+xml,<svg/>");
    expect(result.isValid).toBe(false);
    expect(result.isValid === false && result.message).toMatch(/http and https/);
  });

  it("refuses a file: URL", () => {
    expect(validateBrandAssetUrl("file:///etc/passwd").isValid).toBe(false);
  });

  it("refuses loopback and private-network addresses", () => {
    for (const address of [
      "http://localhost/logo.png",
      "http://127.0.0.1/logo.png",
      "http://10.0.0.5/logo.png",
      "http://192.168.1.4/logo.png",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/logo.png",
      "http://intranet.local/logo.png",
    ]) {
      expect(validateBrandAssetUrl(address).isValid).toBe(false);
    }
  });

  it("still accepts a public IP literal — only private ranges are the problem", () => {
    expect(validateBrandAssetUrl("https://93.184.216.34/logo.png").isValid).toBe(true);
  });

  it("refuses an empty field and an over-long address with something a person can act on", () => {
    expect(validateBrandAssetUrl("   ")).toEqual({
      isValid: false,
      message: "Paste an image address first.",
    });
    const tooLong = `https://acme.com/${"a".repeat(MAX_BRAND_ASSET_URL_LENGTH)}.png`;
    expect(validateBrandAssetUrl(tooLong).isValid).toBe(false);
  });

  it("refuses text that is not a URL at all", () => {
    expect(validateBrandAssetUrl("our logo").isValid).toBe(false);
  });
});
