import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestPerson } from "../ingest-person";

/**
 * The §7.4(b) pipeline. Two properties matter most:
 *
 * 1. The refusal path is identical to the article side — robots.txt or a site
 *    block means we say so and stop, with no invented biography.
 * 2. `searchStatus` never overstates the evidence. When no public-web search
 *    ran, the payload says "unavailable" and carries only page-derived facts,
 *    so the model cannot imply research that did not happen.
 */

vi.mock("../robots", () => ({ isFetchAllowedByRobots: vi.fn() }));
vi.mock("../../brand-kit-extraction/fetch-page", () => ({ fetchPage: vi.fn() }));
vi.mock("../rehost-image", () => ({ rehostImageToStorage: vi.fn() }));
vi.mock("../search-web", () => ({ searchPublicWeb: vi.fn() }));

const { isFetchAllowedByRobots } = await import("../robots");
const { fetchPage } = await import("../../brand-kit-extraction/fetch-page");
const { rehostImageToStorage } = await import("../rehost-image");
const { searchPublicWeb } = await import("../search-web");

const mockIsFetchAllowedByRobots = vi.mocked(isFetchAllowedByRobots);
const mockFetchPage = vi.mocked(fetchPage);
const mockRehostImageToStorage = vi.mocked(rehostImageToStorage);
const mockSearchPublicWeb = vi.mocked(searchPublicWeb);

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const PROFILE_HTML = readFileSync(path.join(fixturesDir, "profile-page.html"), "utf-8");
const PROFILE_URL = "https://riverside.example.edu/people/amara-osei";

afterEach(() => {
  vi.resetAllMocks();
});

function serveProfile(): void {
  mockIsFetchAllowedByRobots.mockResolvedValue(true);
  mockFetchPage.mockResolvedValue({ isOk: true, html: PROFILE_HTML, finalUrl: PROFILE_URL });
}

describe("ingestPerson — the fetch is prevented", () => {
  it("stops at robots.txt WITHOUT fetching the profile", async () => {
    mockIsFetchAllowedByRobots.mockResolvedValue(false);

    const result = await ingestPerson({ url: PROFILE_URL });

    expect(mockFetchPage).not.toHaveBeenCalled();
    expect(mockSearchPublicWeb).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isOk: false, reason: "blocked_by_robots" });
  });

  it("relays a professional network's block in profile terms", async () => {
    mockIsFetchAllowedByRobots.mockResolvedValue(true);
    mockFetchPage.mockResolvedValue({
      isOk: false,
      reason: "blocked_by_site",
      message: "…brand-kit-flavored copy…",
    });

    const result = await ingestPerson({ url: "https://www.linkedin.com/in/someone" });

    expect(result).toMatchObject({ isOk: false, reason: "blocked_by_site" });
    if (result.isOk) return;
    expect(result.message).toContain("blocks automated access");
    // Never searches around a block to reconstruct the person anyway.
    expect(mockSearchPublicWeb).not.toHaveBeenCalled();
  });
});

describe("ingestPerson — no search available", () => {
  it("reports searchStatus 'unavailable' and carries only page-derived facts", async () => {
    serveProfile();
    mockSearchPublicWeb.mockResolvedValue({ status: "unavailable" });
    mockRehostImageToStorage.mockResolvedValue(null);

    const result = await ingestPerson({ url: PROFILE_URL });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.person.searchStatus).toBe("unavailable");
    expect(result.person.sources).toEqual([
      { title: "Riverside University", url: PROFILE_URL },
    ]);
    for (const fact of result.person.facts) {
      expect(fact.sourceUrl).toBe(PROFILE_URL);
    }
  });

  it("never searches on a mock run — no quota, and no invented research", async () => {
    serveProfile();
    mockSearchPublicWeb.mockResolvedValue({ status: "unavailable" });
    mockRehostImageToStorage.mockResolvedValue(null);

    await ingestPerson({ url: PROFILE_URL, isMockRun: true });

    expect(mockSearchPublicWeb).toHaveBeenCalledWith(
      expect.objectContaining({ isMockRun: true }),
    );
  });
});

describe("ingestPerson — with a public-web search", () => {
  it("merges attributed claims and their sources, keeping the profile first", async () => {
    serveProfile();
    mockRehostImageToStorage.mockResolvedValue(null);
    mockSearchPublicWeb.mockResolvedValue({
      status: "searched",
      claims: [
        {
          text: "Osei received the city's resilience award in 2025.",
          sourceUrl: "https://news.example.com/awards-2025",
          sourceTitle: "Example News",
        },
      ],
      sources: [{ title: "Example News", url: "https://news.example.com/awards-2025" }],
    });

    const result = await ingestPerson({ url: PROFILE_URL });

    if (!result.isOk) throw new Error("expected success");
    expect(result.person.searchStatus).toBe("searched");
    expect(result.person.sources[0].url).toBe(PROFILE_URL);
    expect(result.person.sources).toContainEqual({
      title: "Example News",
      url: "https://news.example.com/awards-2025",
    });
    // The search claim arrives bound to ITS OWN source, not the profile's.
    expect(result.person.facts).toContainEqual({
      text: "Osei received the city's resilience award in 2025.",
      sourceUrl: "https://news.example.com/awards-2025",
    });
  });

  it("searches on the person's own name, role, and organization", async () => {
    serveProfile();
    mockRehostImageToStorage.mockResolvedValue(null);
    mockSearchPublicWeb.mockResolvedValue({ status: "no_results" });

    const result = await ingestPerson({ url: PROFILE_URL });

    expect(mockSearchPublicWeb).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "Amara Osei, Professor of Environmental Engineering, Riverside University",
      }),
    );
    if (!result.isOk) throw new Error("expected success");
    expect(result.person.searchStatus).toBe("no_results");
  });
});

describe("ingestPerson — the portrait", () => {
  it("serves the photo from OUR storage, filed under the caller's session", async () => {
    serveProfile();
    mockSearchPublicWeb.mockResolvedValue({ status: "unavailable" });
    mockRehostImageToStorage.mockResolvedValue("https://storage.convex.cloud/portrait.jpg");

    const result = await ingestPerson({ url: PROFILE_URL, sessionId: "session_9" });

    if (!result.isOk) throw new Error("expected success");
    expect(result.person.photoUrl).toBe("https://storage.convex.cloud/portrait.jpg");
    expect(mockRehostImageToStorage).toHaveBeenCalledWith({
      imageUrl: "https://riverside.example.edu/media/portraits/osei.jpg",
      sessionId: "session_9",
      name: "Amara Osei",
      sourceUrl: PROFILE_URL,
    });
  });

  it("omits photoUrl entirely when the portrait could not be stored", async () => {
    serveProfile();
    mockSearchPublicWeb.mockResolvedValue({ status: "unavailable" });
    mockRehostImageToStorage.mockResolvedValue(null);

    const result = await ingestPerson({ url: PROFILE_URL });

    if (!result.isOk) throw new Error("expected success");
    expect(result.person.photoUrl).toBeUndefined();
  });
});
