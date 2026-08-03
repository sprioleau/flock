import { describe, expect, it } from "vitest";
import { MOCK_IMAGE_MODEL_ID } from "./constants";
import {
  base64ToUint8Array,
  deriveImageAltFromPrompt,
  generateEmailImage,
  storeImageInConvex,
} from "./generation";

describe("deriveImageAltFromPrompt", () => {
  it("collapses whitespace and trims", () => {
    expect(deriveImageAltFromPrompt("  a   sunrise\n over  mountains ")).toBe(
      "a sunrise over mountains",
    );
  });

  it("caps long prompts at a word boundary within 160 chars", () => {
    const longPrompt = `${"golden retriever ".repeat(20)}end`;
    const alt = deriveImageAltFromPrompt(longPrompt);
    expect(alt.length).toBeLessThanOrEqual(160);
    expect(alt.endsWith("golden") || alt.endsWith("retriever")).toBe(true);
    expect(alt).not.toMatch(/\s$/);
  });
});

describe("base64ToUint8Array", () => {
  it("round-trips binary data", () => {
    const original = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const base64 = Buffer.from(original).toString("base64");
    expect([...base64ToUint8Array(base64)]).toEqual([...original]);
  });

  it("rejects malformed base64 instead of silently truncating", () => {
    expect(() => base64ToUint8Array("not valid base64!!!")).toThrow(/not valid base64/);
    expect(() => base64ToUint8Array("")).toThrow(/not valid base64/);
    expect(() => base64ToUint8Array("abc")).toThrow(/not valid base64/); // bad length
  });
});

describe("generateEmailImage (mock selection — no network in tests)", () => {
  it("falls back to the deterministic mock when no API key is configured", async () => {
    const outcome = await generateEmailImage({ prompt: "a sunrise", env: {} });
    expect(outcome.isGenerated).toBe(true);
    if (!outcome.isGenerated) return;
    expect(outcome.modelId).toBe(MOCK_IMAGE_MODEL_ID);
    expect(outcome.mimeType).toBe("image/png");
    expect(outcome.alt).toBe("a sunrise");
    expect(outcome.base64.length).toBeGreaterThan(100);
  });

  it("honors the forced-mock flag even when a key is present", async () => {
    const outcome = await generateEmailImage({
      prompt: "a sunrise",
      isMockForced: true,
      env: { GOOGLE_GENERATIVE_AI_API_KEY: "test-key" },
    });
    expect(outcome.isGenerated).toBe(true);
    if (!outcome.isGenerated) return;
    expect(outcome.modelId).toBe(MOCK_IMAGE_MODEL_ID);
  });

  it("honors the FLOCK_MOCK_IMAGE_MODEL env switch", async () => {
    const outcome = await generateEmailImage({
      prompt: "a sunrise",
      env: { GOOGLE_GENERATIVE_AI_API_KEY: "test-key", FLOCK_MOCK_IMAGE_MODEL: "1" },
    });
    expect(outcome.isGenerated).toBe(true);
    if (!outcome.isGenerated) return;
    expect(outcome.modelId).toBe(MOCK_IMAGE_MODEL_ID);
  });
});

describe("storeImageInConvex", () => {
  it("fails cleanly when the Convex call cannot complete", async () => {
    // The Convex address is a placeholder in tests, so the upload mutation
    // cannot succeed. What matters is that a generation still degrades into
    // an outcome union instead of throwing into the route — the base64 the
    // caller already has stays usable as a preview.
    const outcome = await storeImageInConvex({
      base64: Buffer.from("png-bytes").toString("base64"),
      mimeType: "image/png",
    });
    expect(outcome.isStored).toBe(false);
    if (outcome.isStored) return;
    expect(outcome.message.length).toBeGreaterThan(0);
  });
});
