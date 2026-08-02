import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestArticleInput } from "@/lib/content-ingestion/ingest-article";
import type { IngestPersonInput } from "@/lib/content-ingestion/ingest-person";

const ingestArticleMock = vi.hoisted(() => vi.fn<(input: IngestArticleInput) => Promise<unknown>>());
const ingestPersonMock = vi.hoisted(() => vi.fn<(input: IngestPersonInput) => Promise<unknown>>());

vi.mock("@/lib/content-ingestion/ingest-article", () => ({ ingestArticle: ingestArticleMock }));
vi.mock("@/lib/content-ingestion/ingest-person", () => ({ ingestPerson: ingestPersonMock }));

import { POST } from "./route";

/**
 * Contract tests for the ingestion pipeline's HTTP surface. The pipelines
 * themselves are covered in lib/content-ingestion; here we pin the request
 * gates, the session/mock plumbing, and — the part that matters — that an
 * unreadable page comes back as a REFUSAL with a user-facing message and no
 * content, rather than as a 200 with something invented in its place.
 */

const ARTICLE_URL = "https://www.dailymeridian.com/climate/solar-canopy-city";

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  ingestArticleMock.mockReset();
  ingestPersonMock.mockReset();
});

describe("POST /api/ingest — request gates", () => {
  it("rejects malformed JSON without touching the pipeline", async () => {
    const response = await POST(makeRequest("{not json"));
    expect(response.status).toBe(400);
    expect(ingestArticleMock).not.toHaveBeenCalled();
  });

  it("rejects a body with no kind or url", async () => {
    const response = await POST(makeRequest({ url: ARTICLE_URL }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ isOk: false });
    expect(ingestArticleMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown kind", async () => {
    const response = await POST(makeRequest({ kind: "recipe", url: ARTICLE_URL }));
    expect(response.status).toBe(400);
    expect(ingestArticleMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/ingest — article mode", () => {
  it("returns the extracted article on success", async () => {
    ingestArticleMock.mockResolvedValue({
      isOk: true,
      article: { title: "City to build solar canopy", canonicalUrl: ARTICLE_URL },
    });

    const response = await POST(makeRequest({ kind: "article", url: ARTICLE_URL }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      isOk: true,
      kind: "article",
      article: { title: "City to build solar canopy" },
    });
  });

  it("passes the caller's session through so a stored image is filed correctly", async () => {
    ingestArticleMock.mockResolvedValue({ isOk: true, article: {} });

    await POST(
      makeRequest(
        { kind: "article", url: ARTICLE_URL },
        { cookie: "flock_session_id=session_42" },
      ),
    );

    expect(ingestArticleMock).toHaveBeenCalledWith({
      url: ARTICLE_URL,
      sessionId: "session_42",
    });
  });

  it("answers 422 with the refusal message when the page could not be read", async () => {
    ingestArticleMock.mockResolvedValue({
      isOk: false,
      reason: "blocked_by_robots",
      message: "That site's robots.txt asks automated readers to stay off that page.",
    });

    const response = await POST(makeRequest({ kind: "article", url: ARTICLE_URL }));

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ isOk: false, kind: "article", reason: "blocked_by_robots" });
    expect(body.message).toContain("robots.txt");
    // The refusal carries NO content fields to mistake for an article.
    expect(body.article).toBeUndefined();
  });
});

describe("POST /api/ingest — person mode", () => {
  const PROFILE_URL = "https://riverside.example.edu/people/amara-osei";

  it("returns the attributed person payload on success", async () => {
    ingestPersonMock.mockResolvedValue({
      isOk: true,
      person: { name: "Amara Osei", searchStatus: "unavailable" },
    });

    const response = await POST(makeRequest({ kind: "person", url: PROFILE_URL }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      isOk: true,
      kind: "person",
      person: { name: "Amara Osei" },
    });
  });

  it("forwards the person's name and the mock-run flag", async () => {
    ingestPersonMock.mockResolvedValue({ isOk: true, person: {} });

    await POST(
      makeRequest(
        { kind: "person", url: PROFILE_URL, personName: "Amara Osei" },
        { "x-flock-mock": "1" },
      ),
    );

    expect(ingestPersonMock).toHaveBeenCalledWith({
      url: PROFILE_URL,
      sessionId: null,
      isMockRun: true,
      personName: "Amara Osei",
    });
  });

  it("answers 422 when the profile could not be read", async () => {
    ingestPersonMock.mockResolvedValue({
      isOk: false,
      reason: "blocked_by_site",
      message: "That site wouldn't let the profile be read.",
    });

    const response = await POST(makeRequest({ kind: "person", url: PROFILE_URL }));

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ isOk: false, reason: "blocked_by_site" });
    expect(body.person).toBeUndefined();
  });
});
