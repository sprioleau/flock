import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestPageInput } from "@/lib/content-ingestion/ingest-page";

const ingestPageMock = vi.hoisted(() => vi.fn<(input: IngestPageInput) => Promise<unknown>>());

vi.mock("@/lib/content-ingestion/ingest-page", () => ({ ingestPage: ingestPageMock }));

import { POST } from "./route";

/*
  Contract tests for the page pipeline's HTTP surface. The pipeline itself is
  covered in lib/content-ingestion; here we pin the request gates, the session
  plumbing, the compatibility promise made to callers of the old two-mode
  route, and — the part that matters — that an unreadable page comes back as a
  REFUSAL with a user-facing message and no content, rather than as a 200 with
  something invented in its place.
*/

const PAGE_URL = "https://www.dailymeridian.com/climate/solar-canopy-city";

const READ_PAGE = {
  isOk: true as const,
  page: {
    title: "A solar canopy over the city",
    sourceName: "Daily Meridian",
    canonicalUrl: PAGE_URL,
    blocks: [{ kind: "paragraph" as const, text: "The canopy went up in March." }],
    lists: [],
    structuredData: [],
    isTruncated: false,
  },
};

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  ingestPageMock.mockReset();
});

describe("POST /api/ingest — request gates", () => {
  it("rejects malformed JSON without touching the pipeline", async () => {
    const response = await POST(makeRequest("{not json"));
    expect(response.status).toBe(400);
    expect(ingestPageMock).not.toHaveBeenCalled();
  });

  it("rejects a body with no url without touching the pipeline", async () => {
    const response = await POST(makeRequest({ notAUrl: true }));
    expect(response.status).toBe(400);
    expect(ingestPageMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/ingest — the one mode", () => {
  it("reads a page and returns what was on it", async () => {
    ingestPageMock.mockResolvedValue(READ_PAGE);
    const response = await POST(makeRequest({ url: PAGE_URL }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      isOk: true,
      page: { title: "A solar canopy over the city" },
    });
    expect(ingestPageMock).toHaveBeenCalledTimes(1);
    expect(ingestPageMock.mock.calls[0][0].url).toBe(PAGE_URL);
  });

  it("passes the session from the cookie so a rehosted image is filed", async () => {
    ingestPageMock.mockResolvedValue(READ_PAGE);
    await POST(makeRequest({ url: PAGE_URL }, { cookie: "flock_session_id=sess_abc123" }));
    expect(ingestPageMock.mock.calls[0][0].sessionId).toBe("sess_abc123");
  });
});

describe("POST /api/ingest — the compatibility promise", () => {
  /*
    `kind` used to be a required discriminator choosing between an article
    pipeline and a person pipeline. Both are gone. Rejecting the field would
    turn its removal into a hard failure for every existing caller, so it is
    accepted and ignored for one release — a caller still sending it gets a
    page read, not a 400.
  */
  it.each(["article", "person"])("still reads the page when kind is %s", async (kind) => {
    ingestPageMock.mockResolvedValue(READ_PAGE);
    const response = await POST(makeRequest({ kind, url: PAGE_URL }));
    expect(response.status).toBe(200);
    expect(ingestPageMock).toHaveBeenCalledTimes(1);
  });

  it("ignores personName rather than rejecting it", async () => {
    ingestPageMock.mockResolvedValue(READ_PAGE);
    const response = await POST(makeRequest({ url: PAGE_URL, personName: "Someone" }));
    expect(response.status).toBe(200);
    expect(ingestPageMock.mock.calls[0][0]).not.toHaveProperty("personName");
  });
});

describe("POST /api/ingest — a refusal is not invented content", () => {
  it.each([
    ["blocked_by_robots", "That site's robots.txt asks automated readers to stay off that page."],
    ["paywalled", "That page is behind a paywall or sign-in."],
    ["no_main_content", "There wasn't enough readable content on that page to work from."],
  ])("returns 422 with a relayable message for %s", async (reason, message) => {
    ingestPageMock.mockResolvedValue({ isOk: false, reason, message });
    const response = await POST(makeRequest({ url: PAGE_URL }));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ isOk: false, reason, message });
    /*
      Nothing was invented to fill the gap.
    */
    expect(body).not.toHaveProperty("page");
  });
});
