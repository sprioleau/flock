import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isWebSearchEnabled, searchPublicWeb, toAttributedClaims } from "../search-web";

/**
 * Two things are pinned here.
 *
 * 1. QUOTA: a live grounded search costs a model call, so it must not happen
 *    unless it was explicitly switched on — and never on a mock run.
 * 2. ATTRIBUTION: only sentences the provider actually GROUNDED survive, each
 *    bound to the page that supports it. Ungrounded model prose is dropped,
 *    which is what keeps unsourced claims out of a person's spotlight.
 */

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.FLOCK_ENABLE_WEB_SEARCH;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("isWebSearchEnabled", () => {
  it("is off by default", () => {
    expect(isWebSearchEnabled()).toBe(false);
  });

  it("stays off with a key but no explicit opt-in", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
    expect(isWebSearchEnabled()).toBe(false);
  });

  it("stays off with the opt-in but no key", () => {
    process.env.FLOCK_ENABLE_WEB_SEARCH = "1";
    expect(isWebSearchEnabled()).toBe(false);
  });

  it("is on only when both are present", () => {
    process.env.FLOCK_ENABLE_WEB_SEARCH = "1";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
    expect(isWebSearchEnabled()).toBe(true);
  });
});

describe("searchPublicWeb — when it must not run", () => {
  it("returns 'unavailable' when search is switched off", async () => {
    await expect(searchPublicWeb({ query: "someone" })).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("returns 'unavailable' on a mock run even when fully configured", async () => {
    process.env.FLOCK_ENABLE_WEB_SEARCH = "1";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";

    await expect(searchPublicWeb({ query: "someone", isMockRun: true })).resolves.toEqual({
      status: "unavailable",
    });
  });
});

describe("toAttributedClaims", () => {
  const metadata = {
    groundingChunks: [
      { web: { uri: "https://news.example.com/story", title: "Example News" } },
      { web: { uri: "https://journal.example.org/paper", title: "Example Journal" } },
    ],
    groundingSupports: [
      {
        segment: { text: "She directs the Riverside Urban Climate Lab." },
        groundingChunkIndices: [0],
      },
      {
        segment: { text: "Her shading standard was adopted by the city in 2024." },
        groundingChunkIndices: [1],
      },
    ],
  };

  it("binds each claim to the page that grounded it", () => {
    const { claims } = toAttributedClaims(metadata);
    expect(claims).toEqual([
      {
        text: "She directs the Riverside Urban Climate Lab.",
        sourceUrl: "https://news.example.com/story",
        sourceTitle: "Example News",
      },
      {
        text: "Her shading standard was adopted by the city in 2024.",
        sourceUrl: "https://journal.example.org/paper",
        sourceTitle: "Example Journal",
      },
    ]);
  });

  it("collects the distinct sources behind the claims", () => {
    const { sources } = toAttributedClaims(metadata);
    expect(sources).toEqual([
      { title: "Example News", url: "https://news.example.com/story" },
      { title: "Example Journal", url: "https://journal.example.org/paper" },
    ]);
  });

  it("DROPS ungrounded prose — a sentence with no supporting chunk is not a fact", () => {
    const { claims } = toAttributedClaims({
      groundingChunks: [{ web: { uri: "https://news.example.com/story", title: "News" } }],
      groundingSupports: [
        { segment: { text: "She is widely regarded as a visionary leader." }, groundingChunkIndices: [] },
        { segment: { text: "She directs the Riverside Urban Climate Lab." }, groundingChunkIndices: [0] },
      ],
    });
    expect(claims).toHaveLength(1);
    expect(claims[0].text).toBe("She directs the Riverside Urban Climate Lab.");
  });

  it("drops fragments too short to be a usable claim", () => {
    const { claims } = toAttributedClaims({
      groundingChunks: [{ web: { uri: "https://news.example.com/story", title: "News" } }],
      groundingSupports: [{ segment: { text: "Yes." }, groundingChunkIndices: [0] }],
    });
    expect(claims).toEqual([]);
  });

  it("dedupes repeated sentences", () => {
    const repeated = { segment: { text: "She directs the Riverside Urban Climate Lab." }, groundingChunkIndices: [0] };
    const { claims } = toAttributedClaims({
      groundingChunks: [{ web: { uri: "https://news.example.com/story", title: "News" } }],
      groundingSupports: [repeated, repeated],
    });
    expect(claims).toHaveLength(1);
  });

  it("returns nothing when there is no grounding at all", () => {
    expect(toAttributedClaims({})).toEqual({ claims: [], sources: [] });
  });
});
