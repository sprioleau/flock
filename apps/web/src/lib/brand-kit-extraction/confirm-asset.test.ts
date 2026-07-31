import { describe, expect, it } from "vitest";
import {
  decodeSvgDataUri,
  isSvgMarkupSafe,
  MAX_ASSET_BYTES,
  normalizeImageContentType,
  prepareSvgBinary,
} from "./confirm-asset";

describe("normalizeImageContentType", () => {
  it("accepts the allowlisted image types, case/params-insensitively", () => {
    expect(normalizeImageContentType("image/png")).toBe("image/png");
    expect(normalizeImageContentType("IMAGE/JPEG; charset=binary")).toBe("image/jpeg");
    expect(normalizeImageContentType("image/svg+xml;charset=utf-8")).toBe("image/svg+xml");
    expect(normalizeImageContentType("image/webp")).toBe("image/webp");
    expect(normalizeImageContentType("image/x-icon")).toBe("image/x-icon");
  });

  it("rejects non-image and unexpected types", () => {
    expect(normalizeImageContentType("text/html")).toBeNull();
    expect(normalizeImageContentType("application/octet-stream")).toBeNull();
    expect(normalizeImageContentType("image/tiff")).toBeNull();
    expect(normalizeImageContentType("")).toBeNull();
  });
});

describe("isSvgMarkupSafe", () => {
  it("passes benign presentational SVG (including on-containing attribute names)", () => {
    expect(
      isSvgMarkupSafe(
        '<svg xmlns="http://www.w3.org/2000/svg" stroke-linejoin="round"><path d="M0 0h10"/></svg>',
      ),
    ).toBe(true);
  });

  it("rejects scripts, event handlers, and javascript: URLs", () => {
    expect(isSvgMarkupSafe('<svg><script>alert(1)</script></svg>')).toBe(false);
    expect(isSvgMarkupSafe('<svg onload="alert(1)"><path/></svg>')).toBe(false);
    expect(isSvgMarkupSafe('<svg><a href="javascript:alert(1)"><path/></a></svg>')).toBe(false);
    expect(isSvgMarkupSafe('<svg><SCRIPT href="x"/></svg>')).toBe(false);
  });
});

describe("decodeSvgDataUri", () => {
  const svgMarkup = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>';

  it("round-trips a base64 data URI (the extractor's output format)", () => {
    const uri = `data:image/svg+xml;base64,${Buffer.from(svgMarkup, "utf-8").toString("base64")}`;
    expect(decodeSvgDataUri(uri)).toEqual({ svgText: svgMarkup });
  });

  it("decodes a percent-encoded data URI", () => {
    const uri = `data:image/svg+xml,${encodeURIComponent(svgMarkup)}`;
    expect(decodeSvgDataUri(uri)).toEqual({ svgText: svgMarkup });
  });

  it("rejects non-SVG data URIs and non-data URLs", () => {
    expect(decodeSvgDataUri("data:image/png;base64,iVBORw0KGgo=")).toBeNull();
    expect(decodeSvgDataUri("https://example.com/logo.svg")).toBeNull();
    expect(decodeSvgDataUri("data:image/svg+xml;base64,")).toBeNull();
  });
});

describe("prepareSvgBinary", () => {
  it("packages safe SVG markup as utf-8 bytes with the svg content type", () => {
    const outcome = prepareSvgBinary('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(outcome.isOk).toBe(true);
    if (outcome.isOk) {
      expect(outcome.binary.contentType).toBe("image/svg+xml");
      expect(new TextDecoder().decode(outcome.binary.bytes)).toContain("<svg");
    }
  });

  it("refuses scripty SVGs with a user-facing message", () => {
    const outcome = prepareSvgBinary("<svg><script>alert(1)</script></svg>");
    expect(outcome.isOk).toBe(false);
    if (!outcome.isOk) {
      expect(outcome.message).toMatch(/can't safely save/);
    }
  });

  it("refuses SVGs over the asset byte cap", () => {
    const huge = `<svg>${"x".repeat(MAX_ASSET_BYTES + 1)}</svg>`;
    const outcome = prepareSvgBinary(huge);
    expect(outcome.isOk).toBe(false);
  });
});
