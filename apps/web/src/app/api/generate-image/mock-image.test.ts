import { describe, expect, it } from "vitest";
import { createMockImagePng } from "./mock-image";

/*
  Parse width/height out of the PNG's IHDR chunk (offsets 16 and 20).
*/
function readPngDimensions(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, "base64");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("createMockImagePng", () => {
  it("encodes a real PNG (signature + IHDR dimensions)", () => {
    const { base64, mimeType } = createMockImagePng({ prompt: "a sunrise" });
    expect(mimeType).toBe("image/png");
    const bytes = Buffer.from(base64, "base64");
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    /*
      Default aspect ratio is 4:3 at 600px wide.
    */
    expect(readPngDimensions(base64)).toEqual({ width: 600, height: 450 });
  });

  it("is deterministic per prompt and varies across prompts", () => {
    const first = createMockImagePng({ prompt: "a sunrise" });
    const again = createMockImagePng({ prompt: "a sunrise" });
    const other = createMockImagePng({ prompt: "a city at night" });
    expect(again.base64).toBe(first.base64);
    expect(other.base64).not.toBe(first.base64);
  });

  it("honors the requested aspect ratio", () => {
    const wide = createMockImagePng({ prompt: "a banner", aspectRatio: "16:9" });
    expect(readPngDimensions(wide.base64)).toEqual({ width: 600, height: 338 });
    const square = createMockImagePng({ prompt: "a logo", aspectRatio: "1:1" });
    expect(readPngDimensions(square.base64)).toEqual({ width: 600, height: 600 });
  });
});
