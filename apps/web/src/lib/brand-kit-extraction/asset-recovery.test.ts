import { describe, expect, it, vi } from "vitest";
import { recoverBrandAssets } from "./asset-recovery";

const pngBytes = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nm1cAAAAASUVORK5CYII=", "base64"));

describe("recoverBrandAssets", () => {
  it("accepts a manifest only when metadata, theme color, and a verified raster icon exist", async () => {
    const result = await recoverBrandAssets("https://public.example/", { dependencies: {
      fetchText: vi.fn(async () => JSON.stringify({ name: "Example Co", theme_color: "#123456", icons: [{ src: "/icon.png" }] })),
      fetchBinary: vi.fn(async () => ({ isOk: true as const, bytes: pngBytes, contentType: "image/png" })),
    } });
    expect(result).toMatchObject({ isOk: true, siteName: "Example Co", themeColor: "#123456" });
    if (result.isOk) expect(result.html).toContain("<link rel=\"icon\"");
  });

  it("rejects a challenge document instead of treating it as manifest evidence", async () => {
    const fetchText = vi.fn(async () => "<html><title>Just a moment...</title></html>");
    const fetchBinary = vi.fn();
    const result = await recoverBrandAssets("https://public.example/", { dependencies: { fetchText, fetchBinary } });
    expect(result.isOk).toBe(false);
    expect(fetchBinary).not.toHaveBeenCalled();
  });

  it("rejects plausible metadata without a signature-verified image", async () => {
    const result = await recoverBrandAssets("https://public.example/", { dependencies: {
      fetchText: vi.fn(async () => JSON.stringify({ name: "Example Co", theme_color: "#123456", icons: [{ src: "/icon.png" }] })),
      fetchBinary: vi.fn(async () => ({ isOk: true as const, bytes: new Uint8Array(12), contentType: "image/png" })),
    } });
    expect(result).toMatchObject({ isOk: false, reason: "no_verified_icon" });
  });

  it("tries the conventional site.webmanifest path after manifest.json is unavailable", async () => {
    const fetchText = vi.fn(async (url: string) => url.endsWith("site.webmanifest")
      ? JSON.stringify({ name: "Example Co", theme_color: "#123456", icons: [{ src: "/icon.png" }] })
      : null);
    const result = await recoverBrandAssets("https://public.example/", { dependencies: {
      fetchText,
      fetchBinary: vi.fn(async () => ({ isOk: true as const, bytes: pngBytes, contentType: "image/png" })),
    } });
    expect(result).toMatchObject({ isOk: true, siteName: "Example Co" });
    expect(fetchText).toHaveBeenCalledTimes(2);
  });

  it("uses root favicon only after manifest metadata verifies name and theme color", async () => {
    const fetchText = vi.fn(async () => JSON.stringify({ name: "Example Co", theme_color: "#123456" }));
    const fetchBinary = vi.fn(async (url: string) => ({
      isOk: true as const,
      bytes: pngBytes,
      contentType: "image/png",
      url,
    }));
    const result = await recoverBrandAssets("https://public.example/", { dependencies: { fetchText, fetchBinary } });
    expect(result).toMatchObject({ isOk: true, iconUrl: "https://public.example/favicon.ico" });
    expect(fetchBinary).toHaveBeenCalledWith("https://public.example/favicon.ico", expect.any(Number));
  });

  it("never fetches root favicon when public manifest metadata is absent", async () => {
    const fetchText = vi.fn(async () => null);
    const fetchBinary = vi.fn();
    const result = await recoverBrandAssets("https://public.example/", { dependencies: { fetchText, fetchBinary } });
    expect(result).toMatchObject({ isOk: false });
    expect(fetchBinary).not.toHaveBeenCalled();
  });
});
