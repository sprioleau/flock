import { describe, expect, it, vi } from "vitest";
import type { AssetProbeMethod, AssetProbeResult } from "./fetch-page";
import { isImageUrlRenderable, pickFirstRenderableImageUrl } from "./verify-image-url";

/*
  Build a stub probe from per-method canned results (call log included).
*/
function makeProbe(results: Partial<Record<AssetProbeMethod, AssetProbeResult | Error>>) {
  const calls: { url: string; method: AssetProbeMethod }[] = [];
  const probe = vi.fn(async ({ url, method }: { url: string; method: AssetProbeMethod }) => {
    calls.push({ url, method });
    const result = results[method];
    if (result === undefined) {
      throw new Error(`unexpected ${method} probe`);
    }
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });
  return { probe, calls };
}

const ok = (contentType: string, status = 200): AssetProbeResult => ({
  isOk: true,
  status,
  contentType,
});
const timeoutFailure: AssetProbeResult = {
  isOk: false,
  reason: "timeout",
  message: "That site took too long to respond. Please try again in a moment.",
};

const URL_UNDER_TEST = "https://cdn.example.com/card.png";

describe("isImageUrlRenderable", () => {
  it("passes a 2xx image response on HEAD alone (no GET issued)", async () => {
    const { probe, calls } = makeProbe({ HEAD: ok("image/png") });
    await expect(isImageUrlRenderable({ url: URL_UNDER_TEST, probe })).resolves.toBe(true);
    expect(calls).toEqual([{ url: URL_UNDER_TEST, method: "HEAD" }]);
  });

  it("fails a 404 (HEAD and the authoritative GET both non-2xx)", async () => {
    const { probe, calls } = makeProbe({
      HEAD: ok("text/html", 404),
      GET: ok("text/html", 404),
    });
    await expect(isImageUrlRenderable({ url: URL_UNDER_TEST, probe })).resolves.toBe(false);
    expect(calls.map(({ method }) => method)).toEqual(["HEAD", "GET"]);
  });

  it("fails on probe timeout", async () => {
    const { probe } = makeProbe({ HEAD: timeoutFailure, GET: timeoutFailure });
    await expect(isImageUrlRenderable({ url: URL_UNDER_TEST, probe })).resolves.toBe(false);
  });

  it("fails a 2xx response with a non-image content-type", async () => {
    const { probe } = makeProbe({ HEAD: ok("text/html"), GET: ok("text/html") });
    await expect(isImageUrlRenderable({ url: URL_UNDER_TEST, probe })).resolves.toBe(false);
  });

  it("fails a 2xx response with a missing content-type", async () => {
    const { probe } = makeProbe({ HEAD: ok(""), GET: ok("") });
    await expect(isImageUrlRenderable({ url: URL_UNDER_TEST, probe })).resolves.toBe(false);
  });

  it("passes when the CDN rejects HEAD (405) but GET serves the image", async () => {
    const { probe, calls } = makeProbe({
      HEAD: ok("text/plain", 405),
      GET: ok("image/jpeg"),
    });
    await expect(isImageUrlRenderable({ url: URL_UNDER_TEST, probe })).resolves.toBe(true);
    expect(calls.map(({ method }) => method)).toEqual(["HEAD", "GET"]);
  });

  it("passes when HEAD throws (network error) but GET serves the image", async () => {
    const { probe } = makeProbe({ HEAD: new Error("socket hang up"), GET: ok("image/webp") });
    await expect(isImageUrlRenderable({ url: URL_UNDER_TEST, probe })).resolves.toBe(true);
  });

  it("fails when both HEAD and GET throw", async () => {
    const { probe } = makeProbe({
      HEAD: new Error("socket hang up"),
      GET: new Error("socket hang up"),
    });
    await expect(isImageUrlRenderable({ url: URL_UNDER_TEST, probe })).resolves.toBe(false);
  });

  it("passes data: image URIs without any network probe", async () => {
    const { probe, calls } = makeProbe({});
    await expect(
      isImageUrlRenderable({ url: "data:image/svg+xml;base64,PHN2Zy8+", probe }),
    ).resolves.toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("pickFirstRenderableImageUrl", () => {
  const DEAD_URL = "https://cdn.example.com/dead.png";
  const LIVE_URL = "https://acme.test/logo.png";

  it("skips nullish candidates and returns the first URL that renders", async () => {
    const probe = vi.fn(async ({ url, method }: { url: string; method: AssetProbeMethod }) =>
      url === LIVE_URL && method === "HEAD" ? ok("image/png") : ok("text/html", 404),
    );
    await expect(
      pickFirstRenderableImageUrl({ candidateUrls: [null, undefined, "", LIVE_URL], probe }),
    ).resolves.toBe(LIVE_URL);
  });

  it("falls back to the next candidate when the primary is dead", async () => {
    const probe = vi.fn(async ({ url }: { url: string; method: AssetProbeMethod }) =>
      url === LIVE_URL ? ok("image/png") : ok("text/html", 404),
    );
    await expect(
      pickFirstRenderableImageUrl({ candidateUrls: [DEAD_URL, LIVE_URL], probe }),
    ).resolves.toBe(LIVE_URL);
  });

  it("returns null when every candidate fails verification", async () => {
    const { probe } = makeProbe({ HEAD: ok("text/html", 404), GET: ok("text/html", 404) });
    await expect(
      pickFirstRenderableImageUrl({ candidateUrls: [DEAD_URL, LIVE_URL], probe }),
    ).resolves.toBeNull();
  });

  it("returns null for an empty candidate list without probing", async () => {
    const { probe, calls } = makeProbe({});
    await expect(
      pickFirstRenderableImageUrl({ candidateUrls: [null, undefined], probe }),
    ).resolves.toBeNull();
    expect(calls).toEqual([]);
  });
});
