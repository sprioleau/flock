import { afterEach, describe, expect, it, vi } from "vitest";

/*
  The SSRF guard is the one part of fetchPage that talks to the network on its
  own (DNS). Stubbed to "allowed" so these tests exercise the response
  classification and nothing else — no lookups, no sockets.
*/
vi.mock("./url-guard", () => ({
  guardUrl: vi.fn(async (rawUrl: string) => ({ isAllowed: true, url: new URL(rawUrl) })),
}));

import { fetchPage } from "./fetch-page";

const PAGE_URL = "https://blocked.example.com/";

/*
  A body is attached on purpose: the block paths cancel it unread, so a stub
  without one would let a regression there pass unnoticed.
*/
function respondWith({ status, headers }: { status: number; headers: Record<string, string> }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("<html>challenge interstitial</html>", { status, headers })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPage: an origin-wide bot challenge vs. an ordinary per-page block", () => {
  it("reports a Cloudflare-challenged 403 as blocked_by_bot_challenge, not blocked_by_site", async () => {
    respondWith({
      status: 403,
      headers: { "cf-mitigated": "challenge", server: "cloudflare", "content-type": "text/html" },
    });

    const result = await fetchPage(PAGE_URL);

    expect(result).toMatchObject({ isOk: false, reason: "blocked_by_bot_challenge" });
  });

  it("never tells a challenged user to try another page on the same site", async () => {
    respondWith({
      status: 403,
      headers: { "cf-mitigated": "challenge", server: "cloudflare", "content-type": "text/html" },
    });

    const result = await fetchPage(PAGE_URL);

    /*
      The whole point of the new reason: every path on that origin answers the
      same way, so the old advice was a loop with no exit. The message has to
      send the user to manual entry instead.
    */
    expect(result.isOk).toBe(false);
    if (result.isOk) {
      return;
    }
    expect(result.message).not.toContain("try another page on the same site");
    expect(result.message).toContain("trying another page won't help");
    expect(result.message).toContain("by hand");
  });

  it("keeps blocked_by_site — and its 'try another page' advice — for a plain 403", async () => {
    respondWith({ status: 403, headers: { "content-type": "text/html" } });

    const result = await fetchPage(PAGE_URL);

    expect(result).toMatchObject({ isOk: false, reason: "blocked_by_site" });
    expect(result.isOk).toBe(false);
    if (result.isOk) {
      return;
    }
    expect(result.message).toContain("try another page on the same site");
  });

  it("does not read a Cloudflare 403 as a challenge without the mitigation header", async () => {
    /*
      Sitting behind Cloudflare is not the same as being challenged by it: a
      members-only page on a Cloudflare-fronted site answers 403 with this
      exact `server` header, and "try another page" is still right for it.
    */
    respondWith({ status: 403, headers: { server: "cloudflare", "content-type": "text/html" } });

    const result = await fetchPage(PAGE_URL);

    expect(result).toMatchObject({ isOk: false, reason: "blocked_by_site" });
  });

  it("classifies a challenge served under a non-block status by the header, not the status", async () => {
    respondWith({
      status: 503,
      headers: { "cf-mitigated": "challenge", server: "cloudflare", "content-type": "text/html" },
    });

    const result = await fetchPage(PAGE_URL);

    expect(result).toMatchObject({ isOk: false, reason: "blocked_by_bot_challenge" });
  });

  it("issues exactly one request — no retry, no probing of other paths", async () => {
    respondWith({
      status: 403,
      headers: { "cf-mitigated": "challenge", server: "cloudflare", "content-type": "text/html" },
    });

    await fetchPage(PAGE_URL);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads a 200 page normally — the classification only ever fires on a failed response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html><body>real page</body></html>", {
            status: 200,
            headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
          }),
      ),
    );

    const result = await fetchPage(PAGE_URL);

    expect(result).toMatchObject({ isOk: true });
  });
});
