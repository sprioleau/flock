import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmBrandAsset } from "./brand-asset-confirm";

/*
  The single client entry to the confirm-asset route. Two things here are
  load-bearing rather than plumbing:

  1. THE REQUEST NAMES A KIND, NEVER A URL. The route re-reads the suggestion
     from the caller's own kit row precisely so a browser cannot choose what
     gets fetched; a wrapper that quietly forwarded a URL would hand the
     server an SSRF target. This is asserted on the wire body, not on types.
  2. IT ALWAYS RESOLVES, WITH WORDS. Confirming fetches and rehosts a
     third-party image, so refusal is ordinary — and a caller left holding a
     rejected promise shows a spinner that never stops.
*/

afterEach(() => {
  vi.unstubAllGlobals();
});

/* One fetch stub, recording exactly what went over the wire. */
function stubFetch(respond: () => Promise<Response> | Response) {
  const fetchMock = vi.fn(async () => respond());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("the request", () => {
  it("sends the session and the kind, and nothing that names a URL", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ isOk: true, url: "https://storage/logo.png" }));
    await confirmBrandAsset({ sessionId: "session_me", kind: "logo" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/brand-kit/confirm-asset");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ sessionId: "session_me", kind: "logo" });
  });
});

describe("the outcome", () => {
  it("hands back the durable URL on success", async () => {
    stubFetch(() => jsonResponse({ isOk: true, url: "https://storage/logo.png" }));
    expect(await confirmBrandAsset({ sessionId: "session_me", kind: "logo" })).toEqual({
      isOk: true,
      url: "https://storage/logo.png",
    });
  });

  it("keeps the route's refusal verbatim — it saw the failure, the browser didn't", async () => {
    /* A refusal is a 4xx that still carries copy: the status must not eat it. */
    stubFetch(() =>
      jsonResponse({ isOk: false, message: "That address didn't give us an image." }, 422),
    );
    expect(await confirmBrandAsset({ sessionId: "session_me", kind: "logo" })).toEqual({
      isOk: false,
      message: "That address didn't give us an image.",
    });
  });

  it("fails honestly when the network never answers", async () => {
    stubFetch(() => Promise.reject(new Error("offline")));
    const outcome = await confirmBrandAsset({ sessionId: "session_me", kind: "socialCard" });
    expect(outcome.isOk).toBe(false);
  });

  it("refuses to read a success out of a body it cannot parse", async () => {
    /* An HTML error page from a proxy must not become `{ isOk: true, url: undefined }`. */
    stubFetch(() => new Response("<html>gateway timeout</html>", { status: 504 }));
    const outcome = await confirmBrandAsset({ sessionId: "session_me", kind: "logo" });
    expect(outcome.isOk).toBe(false);
  });
});
