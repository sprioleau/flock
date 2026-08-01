import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANVAS_COOKIE_NAME,
  DOC_COOKIE_NAME,
  deriveCanvasCookieValue,
  deriveDocCookieValue,
} from "@/lib/access-gate";

/**
 * Unit tests for the access-gate proxy's decision matrix — most importantly
 * the `?doc=` / `?canvas=` capability-link branches, which cannot be
 * exercised locally without enabling the gate on a running server. The
 * Convex HTTP client is mocked: these tests pin the GATING logic, not the
 * existence queries (documents.documentExists / canvasExists are verified
 * against the dev deployment separately).
 */

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    query = queryMock;
  },
}));

import { proxy } from "./proxy";

const PASSWORD = "test-password";
const ORIGIN = "https://flock.test";

function buildRequest(pathAndQuery: string, cookies?: Record<string, string>): NextRequest {
  const headers = new Headers();
  if (cookies !== undefined) {
    headers.set(
      "cookie",
      Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
    );
  }
  return new NextRequest(`${ORIGIN}${pathAndQuery}`, { headers });
}

function expectPass(response: Response): void {
  expect(response.headers.get("x-middleware-next")).toBe("1");
}

function expectGateRedirect(response: Response, expectedFrom: string): void {
  expect(response.status).toBe(307);
  const location = new URL(response.headers.get("location")!);
  expect(location.pathname).toBe("/gate");
  expect(location.searchParams.get("from")).toBe(expectedFrom);
}

beforeEach(() => {
  process.env.FLOCK_ACCESS_PASSWORD = PASSWORD;
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://example.convex.cloud";
  queryMock.mockReset();
});

afterEach(() => {
  delete process.env.FLOCK_ACCESS_PASSWORD;
});

describe("proxy access gate", () => {
  it("passes everything when the gate is disabled", async () => {
    delete process.env.FLOCK_ACCESS_PASSWORD;
    expectPass(await proxy(buildRequest("/studio")));
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("redirects credential-less requests to /gate with a return path", async () => {
    expectGateRedirect(await proxy(buildRequest("/studio")), "/studio");
  });

  it("passes a valid ?doc= link and sets the per-doc cookie", async () => {
    queryMock.mockResolvedValueOnce(true);
    const response = await proxy(buildRequest("/studio?doc=j97abc"));
    expectPass(response);
    expect(response.headers.get("set-cookie")).toContain(
      `${DOC_COOKIE_NAME}=${deriveDocCookieValue({ password: PASSWORD, documentKey: "j97abc" })}`,
    );
  });

  it("passes a valid ?canvas= link and sets the per-canvas cookie", async () => {
    queryMock.mockResolvedValueOnce(true);
    const response = await proxy(buildRequest("/studio?canvas=jn7abc"));
    expectPass(response);
    expect(response.headers.get("set-cookie")).toContain(
      `${CANVAS_COOKIE_NAME}=${deriveCanvasCookieValue({ password: PASSWORD, canvasKey: "jn7abc" })}`,
    );
  });

  it("sends an invalid ?canvas= link to the gate", async () => {
    queryMock.mockResolvedValueOnce(false);
    expectGateRedirect(
      await proxy(buildRequest("/studio?canvas=bogus")),
      "/studio?canvas=bogus",
    );
  });

  it("passes on a valid per-canvas cookie without re-querying Convex", async () => {
    const response = await proxy(
      buildRequest("/studio?canvas=jn7abc", {
        [CANVAS_COOKIE_NAME]: deriveCanvasCookieValue({
          password: PASSWORD,
          canvasKey: "jn7abc",
        }),
      }),
    );
    expectPass(response);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects a canvas cookie scoped to a DIFFERENT canvas id", async () => {
    queryMock.mockResolvedValueOnce(false);
    expectGateRedirect(
      await proxy(
        buildRequest("/studio?canvas=jn7other", {
          [CANVAS_COOKIE_NAME]: deriveCanvasCookieValue({
            password: PASSWORD,
            canvasKey: "jn7abc",
          }),
        }),
      ),
      "/studio?canvas=jn7other",
    );
  });

  it("falls through an invalid ?doc= to a valid ?canvas= on the same URL", async () => {
    queryMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const response = await proxy(buildRequest("/studio?doc=deleted&canvas=jn7abc"));
    expectPass(response);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("fails CLOSED (gate) when Convex is unreachable", async () => {
    queryMock.mockRejectedValueOnce(new Error("network down"));
    expectGateRedirect(
      await proxy(buildRequest("/studio?canvas=jn7abc")),
      "/studio?canvas=jn7abc",
    );
  });
});
