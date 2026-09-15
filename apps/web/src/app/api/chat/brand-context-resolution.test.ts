import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchAuthQueryMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/auth-server", () => ({
  fetchAuthQuery: fetchAuthQueryMock,
}));

import { resolveBrandContext } from "./brand-context";

function buildKit(name: string) {
  return {
    name,
    sourceUrl: `https://${name.toLowerCase()}.example`,
    fonts: { heading: "Arial", body: "Arial" },
    colors: [],
    variations: [{ id: "default", name: "Default", globals: {} }],
    socialLinks: [],
    sourceImages: [
      {
        url: `https://assets.example.com/${name.toLowerCase()}.png`,
        alt: `${name} product`,
        width: 1200,
        height: 630,
      },
    ],
  };
}

describe("resolveBrandContext", () => {
  beforeEach(() => {
    fetchAuthQueryMock.mockReset();
  });

  it("resolves through the document's canvas binding instead of the caller's session kit", async () => {
    fetchAuthQueryMock
      .mockResolvedValueOnce({ canvasId: "canvas-bound" })
      .mockResolvedValueOnce({ kitId: "kit-bound", source: "binding", kit: buildKit("Bound") });

    const result = await resolveBrandContext({
      sessionId: "session-with-a-different-kit",
      documentId: "document-key",
    });

    expect(fetchAuthQueryMock).toHaveBeenCalledTimes(2);
    expect(fetchAuthQueryMock.mock.calls[0]?.[1]).toEqual({ documentKey: "document-key" });
    expect(fetchAuthQueryMock.mock.calls[1]?.[1]).toEqual({ canvasId: "canvas-bound" });
    expect(result?.generation.brandName).toBe("Bound");
    expect(result?.block).toContain("Bound product | scraped | 1200x630");
    expect(result?.block).not.toContain("session-with-a-different-kit");
  });

  it("falls back to the session kit only when no document identity is available", async () => {
    fetchAuthQueryMock.mockResolvedValueOnce(buildKit("Session"));

    const result = await resolveBrandContext({ sessionId: "session-owner" });

    expect(fetchAuthQueryMock).toHaveBeenCalledTimes(1);
    expect(fetchAuthQueryMock.mock.calls[0]?.[1]).toEqual({ sessionId: "session-owner" });
    expect(result?.generation.brandName).toBe("Session");
  });
});
