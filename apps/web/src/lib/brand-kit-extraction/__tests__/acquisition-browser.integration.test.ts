import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { discardWarmBrowser, getWarmBrowser } from "../browser-manager";
import { renderPageInBrowser, type BrowserRenderOptions } from "../browser-render";
import { validateUrlSyntax, type UrlGuardResult } from "../url-guard";
import type { ManagedBrowserLike } from "../browser-manager";
import { recoverBrandAssets } from "../asset-recovery";
import type { FetchPageResult } from "../fetch-page";

const fixtureGuard = vi.hoisted(() => ({ origin: "" }));

vi.mock("../url-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../url-guard")>();
  return {
    ...actual,
    guardUrl: async (rawUrl: string) => {
      try {
        const url = new URL(rawUrl);
        if (url.origin === fixtureGuard.origin) return { isAllowed: true as const, url };
      } catch {
        return actual.guardUrl(rawUrl);
      }
      return actual.guardUrl(rawUrl);
    },
  };
});

import { acquirePage } from "../acquire-page";

const isEnabled = process.env.FLOCK_RUN_SCRAPING_BROWSER_TESTS === "1";
let isFixtureBrowserLaunched = false;
const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nm1cAAAAASUVORK5CYII=", "base64");
const manifestText = JSON.stringify({
  name: "Fixture Brand",
  theme_color: "#123456",
  icons: [{ src: "/icon.png", type: "image/png" }],
});

describe.skipIf(!isEnabled)("real Chromium acquisition flow", () => {
  let server: Server;
  let fixtureUrl = "";
  let activeMode = "render_success";

  beforeAll(async () => {
    server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", fixtureUrl || "http://localhost./");
      const mode = activeMode;
      if (requestUrl.pathname === "/manifest.json" && mode === "assets") {
        response.writeHead(200, { "content-type": "application/manifest+json" });
        response.end(manifestText);
        return;
      }
      if (requestUrl.pathname === "/icon.png" && mode === "assets") {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(pngBytes);
        return;
      }
      if (requestUrl.pathname !== "/") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("missing");
        return;
      }
      const userAgent = request.headers["user-agent"] ?? "";
      if (userAgent.includes("FlockBrandKit")) {
        response.writeHead(403, {
          "content-type": "text/html",
          ...(mode === "challenge" ? { "cf-mitigated": "challenge" } : {}),
        });
        response.end(mode === "challenge" ? "<html>challenge</html>" : "<html>forbidden</html>");
        return;
      }
      if (mode === "browser403" || mode === "assets") {
        response.writeHead(403, { "content-type": "text/html" });
        response.end("<html><body>Browser refused</body></html>");
        return;
      }
      if (mode === "challenge") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>");
        return;
      }
      if (mode === "isolation_read") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<html><body><main id="app">Loading isolation check</main><script>setTimeout(() => { document.querySelector('#app').textContent = localStorage.getItem('fixture-secret') || document.cookie.includes('fixture-secret') ? 'Leaked prior browser state' : 'Fresh isolated browser context'; }, 100)</script></body></html>`);
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<html><head><title>Fixture</title></head><body><main><h1>Loading</h1><p>A meaningful fixture paragraph that explains the browser rendered page.</p><button>Explore the product</button></main><script>setTimeout(() => { document.querySelector('h1').textContent = 'Hydrated fixture brand'; document.querySelector('h1').style.color = '#123456'; localStorage.setItem('fixture-secret', 'private state'); document.cookie = 'fixture-secret=private-state'; }, 150)</script></body></html>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "::", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Fixture server did not bind a TCP port.");
    fixtureUrl = `http://flock.fixture.test:${address.port}/`;
    fixtureGuard.origin = new URL(fixtureUrl).origin;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (isFixtureBrowserLaunched) {
      const browser = await getWarmBrowser(async () => { throw new Error("No warm browser was retained."); });
      await discardWarmBrowser(browser);
    }
  });

  it("recovers a 403 static read with actual hydrated Chromium output", async () => {
    activeMode = "render_success";
    const result = await acquirePage(fixtureUrl, { dependencies: fixtureDependencies() });
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.renderedPage?.html).toContain("Hydrated fixture brand");
      expect(result.renderedPage?.screenshot.byteLength).toBeGreaterThan(0);
      expect(result.renderedPage?.semanticEvidence).toMatchObject({
        isUsable: true,
        headings: [{ text: "Hydrated fixture brand" }],
        firstParagraph: "A meaningful fixture paragraph that explains the browser rendered page.",
        ctaLabels: ["Explore the product"],
      });
    }
  }, 45_000);

  it("isolates cookies and local storage between real browser contexts", async () => {
    activeMode = "isolation_read";
    const result = await acquirePage(fixtureUrl, { dependencies: fixtureDependencies() });
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      const renderedMain = result.renderedPage?.html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? "";
      expect(renderedMain).toContain("Fresh isolated browser context");
      expect(renderedMain).not.toContain("Leaked prior browser state");
    }
  }, 45_000);

  it("uses verified manifest assets after Chromium itself returns 403", async () => {
    activeMode = "assets";
    const result = await acquirePage(fixtureUrl, { dependencies: fixtureDependencies() });
    expect(result).toMatchObject({ isOk: true, outcomes: { recovery: { isOk: true, siteName: "Fixture Brand", themeColor: "#123456" } } });
    if (result.isOk) expect(result.html).toContain("/icon.png");
  }, 45_000);

  it("keeps a challenge response as an honest refusal", async () => {
    activeMode = "challenge";
    const result = await acquirePage(fixtureUrl, { dependencies: fixtureDependencies() });
    expect(result).toMatchObject({ isOk: false, reason: "blocked_by_bot_challenge" });
  }, 45_000);
});

function fixtureDependencies() {
  function guardFixtureUrl(rawUrl: string): UrlGuardResult {
    try {
      const url = new URL(rawUrl);
      if (url.origin === fixtureGuard.origin) return { isAllowed: true, url };
    } catch {
      return validateUrlSyntax(rawUrl);
    }
    return validateUrlSyntax(rawUrl);
  }
  return {
    validateUrl: guardFixtureUrl,
    fetchPage: fetchFixturePage,
    recoverAssets: (url: string) => recoverBrandAssets(url, { dependencies: {
      fetchText: async (resourceUrl, timeoutMs) => {
        const response = await fetchFixtureResource({ rawUrl: resourceUrl, timeoutMs });
        return response.ok ? (await response.text()).slice(0, 32 * 1024) : null;
      },
      fetchBinary: async (resourceUrl, timeoutMs) => {
        const response = await fetchFixtureResource({ rawUrl: resourceUrl, timeoutMs });
        if (!response.ok) return { isOk: false as const };
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { isOk: true as const, bytes, contentType: (response.headers.get("content-type") ?? "").split(";")[0] };
      },
    } }),
    renderPage: (rawUrl: string) => renderPageInBrowser(rawUrl, {
      dependencies: {
        guardUrl: async (url) => guardFixtureUrl(url),
        launchBrowser: (async () => {
          const puppeteer = await import("puppeteer-core");
          isFixtureBrowserLaunched = true;
          return await getWarmBrowser(async () => await puppeteer.default.launch({
            executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            headless: true,
            args: ["--host-resolver-rules=MAP flock.fixture.test 127.0.0.1"],
          }) as unknown as ManagedBrowserLike);
        }) as NonNullable<BrowserRenderOptions["dependencies"]>["launchBrowser"],
      },
    }),
  };
}

async function fetchFixturePage(rawUrl: string): Promise<FetchPageResult> {
  const response = await fetchFixtureResource({ rawUrl, timeoutMs: 5_000, userAgent: "Mozilla/5.0 Chrome/126.0 FlockBrandKit/1.0" });
  const finalUrl = rawUrl;
  if (response.headers.has("cf-mitigated")) {
    return { isOk: false, reason: "blocked_by_bot_challenge", message: "Fixture challenge", status: response.status, finalUrl };
  }
  if (!response.ok) {
    return { isOk: false, reason: "blocked_by_site", message: "Fixture denied", status: response.status, finalUrl };
  }
  return { isOk: true, html: (await response.text()).slice(0, 2 * 1024 * 1024), finalUrl, status: response.status };
}

async function fetchFixtureResource({ rawUrl, timeoutMs, userAgent }: { rawUrl: string; timeoutMs: number; userAgent?: string }): Promise<Response> {
  const localUrl = new URL(rawUrl);
  localUrl.hostname = "127.0.0.1";
  return fetch(localUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: userAgent === undefined ? undefined : { "user-agent": userAgent },
  });
}
