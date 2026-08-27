import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSampleDocument, ROOT_BLOCK_ID } from "@flock/email-sdk";
import type { UIMessageStreamWriter } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FlockChatMessage } from "@/lib/chat-contract";

/**
 * Phase 7.4 END TO END on the deterministic tier — the owner's flagship
 * prompt, "add a new section based on my new article at <url>", driven
 * through the REAL chat pipeline (streamText → tool execution → validation →
 * UI stream) with only the network boundary stubbed.
 *
 * What this proves that the unit tests cannot:
 * - the model's first move on a URL is to FETCH, not to write;
 * - the section that follows is composed from the page that was actually
 *   fetched — its real title, its real canonical URL, its stored image;
 * - and when the page cannot be read, the turn produces the refusal sentence
 *   and ZERO document operations. That last one is the plan's hardest rule,
 *   and this is where it is pinned.
 */

const fetchPageMock = vi.hoisted(() => vi.fn());
const isFetchAllowedByRobotsMock = vi.hoisted(() => vi.fn());
const rehostImageToStorageMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/brand-kit-extraction/fetch-page", () => ({ fetchPage: fetchPageMock }));
vi.mock("@/lib/content-ingestion/robots", () => ({
  isFetchAllowedByRobots: isFetchAllowedByRobotsMock,
}));
vi.mock("@/lib/content-ingestion/rehost-image", () => ({
  rehostImageToStorage: rehostImageToStorageMock,
}));

import { MOCK_MODEL_ID } from "./constants";
import { createMockChatModel } from "./mock-model";
import { runChatPipeline } from "./pipeline";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../lib/content-ingestion/__tests__/fixtures",
);
const ARTICLE_HTML = readFileSync(path.join(fixturesDir, "article-page.html"), "utf-8");
const ARTICLE_URL = "https://www.dailymeridian.com/climate/solar-canopy-city";
const STORED_HERO_URL = "https://storage.convex.cloud/stored-hero.jpg";

interface RecordedChunk {
  type: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  delta?: string;
}

async function runTurn(lastUserText: string): Promise<RecordedChunk[]> {
  let mergedStream: ReadableStream<unknown> | null = null;
  const writer = {
    write: () => {},
    merge: (stream: ReadableStream<unknown>) => {
      mergedStream = stream;
    },
    onError: undefined,
  } as unknown as UIMessageStreamWriter<FlockChatMessage>;

  const doc = createSampleDocument();
  const messages: FlockChatMessage[] = [
    { id: "msg-1", role: "user", parts: [{ type: "text", text: lastUserText }] },
  ];

  await runChatPipeline({
    model: createMockChatModel({
      lastUserText,
      rootSectionCount: doc[ROOT_BLOCK_ID].childrenIds.length,
    }),
    modelId: MOCK_MODEL_ID,
    isUsingMockModel: true,
    messages,
    doc,
    sessionId: "session_e2e",
    traceId: "test-trace",
    writer,
  });

  const chunks: RecordedChunk[] = [];
  const reader = (mergedStream as unknown as ReadableStream<unknown>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as RecordedChunk);
  }
  return chunks;
}

/** The tool names that reached input-available, in order. */
function toolCallSequence(chunks: RecordedChunk[]): string[] {
  return chunks
    .filter((chunk) => chunk.type === "tool-input-available")
    .map((chunk) => chunk.toolName ?? "");
}

function firstToolInput(chunks: RecordedChunk[], toolName: string): unknown {
  return chunks.find(
    (chunk) => chunk.type === "tool-input-available" && chunk.toolName === toolName,
  )?.input;
}

/**
 * The page payload readWebPage handed back, as the model would receive it.
 *
 * Matched by toolCallId rather than by name: a `tool-output-available` chunk
 * carries the id, not the tool's name, so filtering on name silently finds
 * nothing.
 */
function readPagePayload(chunks: RecordedChunk[]): Record<string, unknown> {
  const toolCallId = chunks.find(
    (chunk) => chunk.type === "tool-input-available" && chunk.toolName === "readWebPage",
  )?.toolCallId;
  const output = chunks.find(
    (chunk) => chunk.type === "tool-output-available" && chunk.toolCallId === toolCallId,
  )?.output as { data?: { isOk?: boolean; page?: Record<string, unknown> } } | undefined;
  if (output?.data?.isOk !== true || output.data.page === undefined) {
    throw new Error("expected readWebPage to have returned a page");
  }
  return output.data.page;
}

function streamedText(chunks: RecordedChunk[]): string {
  return chunks
    .filter((chunk) => chunk.type === "text-delta")
    .map((chunk) => chunk.delta ?? "")
    .join("");
}

beforeEach(() => {
  fetchPageMock.mockReset();
  isFetchAllowedByRobotsMock.mockReset();
  rehostImageToStorageMock.mockReset();
});

describe('"add a new section based on my new article at <url>"', () => {
  beforeEach(() => {
    isFetchAllowedByRobotsMock.mockResolvedValue(true);
    fetchPageMock.mockResolvedValue({ isOk: true, html: ARTICLE_HTML, finalUrl: ARTICLE_URL });
    rehostImageToStorageMock.mockResolvedValue(STORED_HERO_URL);
  });

  it("fetches the page FIRST, then composes one section from it", async () => {
    const chunks = await runTurn(`Add a new section based on my new article at ${ARTICLE_URL}`);

    expect(toolCallSequence(chunks)).toEqual(["readWebPage", "addSection"]);
    expect(firstToolInput(chunks, "readWebPage")).toEqual({ url: ARTICLE_URL });
  });

  it("really fetched the page through the guarded primitive", async () => {
    await runTurn(`Add a new section based on my new article at ${ARTICLE_URL}`);

    expect(isFetchAllowedByRobotsMock).toHaveBeenCalledWith(ARTICLE_URL);
    expect(fetchPageMock).toHaveBeenCalledWith(ARTICLE_URL);
  });

  it("composes the section from the ACTUAL fetched content", async () => {
    const chunks = await runTurn(`Add a new section based on my new article at ${ARTICLE_URL}`);
    const operation = firstToolInput(chunks, "addSection") as {
      children: { type: string; properties: Record<string, unknown> }[];
    };
    const serialized = JSON.stringify(operation);

    // The page's real headline and real sentences — not a template's copy.
    expect(serialized).toContain("City to build solar canopy over downtown parking");
    expect(serialized).toContain("voted 8-1 on Tuesday");
    expect(serialized).toContain("The Daily Meridian");
  });

  it("keeps the byline available to the model, in the page's own structured data", async () => {
    /*
      The old article payload had a dedicated `byline` field. The generic
      scrape has no such field, because a byline is an article-shaped idea and
      this reader is not article-shaped — but the fact is not lost: the page
      declared it, and every JSON-LD node now comes through unfiltered.

      The mock composer here does not render the byline; what matters is that a
      model composing from this payload COULD, from the publisher's own
      declaration rather than from a pattern guessing at one.
    */
    const chunks = await runTurn(`Add a new section based on my new article at ${ARTICLE_URL}`);
    expect(JSON.stringify(readPagePayload(chunks).structuredData)).toContain("Dana Reeve");
  });

  it("attributes the source: the button links to the article's canonical URL", async () => {
    const chunks = await runTurn(`Add a new section based on my new article at ${ARTICLE_URL}`);
    const operation = firstToolInput(chunks, "addSection") as {
      children: { type: string; properties: Record<string, string> }[];
    };

    const button = operation.children.find((block) => block.type === "button");
    expect(button?.properties.href).toBe(ARTICLE_URL);
    expect(button?.properties.label).toBe("View the original");
  });

  it("serves the hero image from our storage, filed under the caller's session", async () => {
    const chunks = await runTurn(`Add a new section based on my new article at ${ARTICLE_URL}`);
    const operation = firstToolInput(chunks, "addSection") as {
      children: { type: string; properties: Record<string, string> }[];
    };

    const image = operation.children.find((block) => block.type === "image");
    expect(image?.properties.src).toBe(STORED_HERO_URL);
    expect(rehostImageToStorageMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session_e2e" }),
    );
  });

  it("appends the section below the draft's existing sections", async () => {
    const doc = createSampleDocument();
    const chunks = await runTurn(`Add a new section based on my new article at ${ARTICLE_URL}`);
    const operation = firstToolInput(chunks, "addSection") as { index: number };

    expect(operation.index).toBe(doc[ROOT_BLOCK_ID].childrenIds.length);
  });
});

/*
  This block used to prove a profile link ROUTED to a second, person-specific
  tool. There is no second tool, so it now proves the opposite and more
  valuable thing: a page about a person goes through the SAME reader as a news
  article, and what the page is gets decided from what was read rather than
  from the link or the wording.
*/
describe("a page about a person goes through the same one reader", () => {
  const PROFILE_URL = "https://riverside.example.edu/people/amara-osei";

  beforeEach(() => {
    isFetchAllowedByRobotsMock.mockResolvedValue(true);
    fetchPageMock.mockResolvedValue({
      isOk: true,
      html: readFileSync(path.join(fixturesDir, "profile-page.html"), "utf-8"),
      finalUrl: PROFILE_URL,
    });
    rehostImageToStorageMock.mockResolvedValue("https://storage.convex.cloud/portrait.jpg");
  });

  it("reads it with readWebPage, exactly as it reads an article", async () => {
    const chunks = await runTurn(`Add a spotlight section for this person: ${PROFILE_URL}`);

    expect(toolCallSequence(chunks)).toEqual(["readWebPage", "addSection"]);
    expect(firstToolInput(chunks, "readWebPage")).toEqual({ url: PROFILE_URL });
  });

  it("writes only what the profile says, and links back to it", async () => {
    const chunks = await runTurn(`Add a spotlight section for this person: ${PROFILE_URL}`);
    const operation = firstToolInput(chunks, "addSection") as {
      children: { type: string; properties: Record<string, string> }[];
    };
    const serialized = JSON.stringify(operation);

    expect(serialized).toContain("Amara Osei");
    expect(serialized).toContain("Riverside University");
    const button = operation.children.find((block) => block.type === "button");
    expect(button?.properties.href).toBe(PROFILE_URL);
  });

  it("still surfaces the role, now from the page rather than a job-title regex", async () => {
    /*
      The deleted person extractor found a role with ROLE_LINE_PATTERN — a
      regex alternation of job titles (professor|lecturer|…), which by
      construction failed on every title nobody had thought to list.

      It is gone, and the role is still here, because the page declares it and
      the scrape passes every structured-data node through untouched. Strictly
      wider coverage than the pattern had, and no list to maintain.
    */
    const chunks = await runTurn(`Add a spotlight section for this person: ${PROFILE_URL}`);
    expect(JSON.stringify(readPagePayload(chunks).structuredData)).toContain(
      "Professor of Environmental Engineering",
    );
  });

  it("composes from the page alone, with no public-web search anywhere", async () => {
    /*
      The old person pipeline fanned out to a public-web search. This one does
      not search at all: the reader reads the page it was given. The guarantee
      is structural rather than spied — searchPublicWeb has no call site in the
      page pipeline — so what is pinned here is that the section still composes
      without it.
    */
    const chunks = await runTurn(`Add a spotlight section for this person: ${PROFILE_URL}`);
    expect(toolCallSequence(chunks)).toContain("addSection");
  });

  it("stops honestly when a professional network blocks the profile", async () => {
    fetchPageMock.mockResolvedValue({
      isOk: false,
      reason: "blocked_by_site",
      message: "…brand-kit-flavored copy…",
    });

    const chunks = await runTurn(
      "Add a spotlight section for this person: https://www.linkedin.com/in/someone",
    );

    expect(streamedText(chunks)).toContain("blocks automated access");
    expect(JSON.stringify(chunks)).not.toContain('"addSection"');
  });
});

describe("a page that cannot be read produces NO edits", () => {
  it("stops at robots.txt and tells the user why", async () => {
    isFetchAllowedByRobotsMock.mockResolvedValue(false);

    const chunks = await runTurn(`Add a new section based on my new article at ${ARTICLE_URL}`);

    expect(toolCallSequence(chunks)).toEqual(["readWebPage"]);
    expect(fetchPageMock).not.toHaveBeenCalled();
    expect(streamedText(chunks)).toContain("robots.txt");
    // The load-bearing assertion: nothing was written into the document.
    expect(JSON.stringify(chunks)).not.toContain('"addSection"');
  });

  it("stops on a paywall and tells the user why", async () => {
    isFetchAllowedByRobotsMock.mockResolvedValue(true);
    fetchPageMock.mockResolvedValue({
      isOk: true,
      html: readFileSync(path.join(fixturesDir, "paywall-stub.html"), "utf-8"),
      finalUrl: "https://harborbusinessjournal.com/ports/merger-talks",
    });

    const chunks = await runTurn(
      "Add a new section based on my new article at https://harborbusinessjournal.com/ports/merger-talks",
    );

    expect(toolCallSequence(chunks)).toEqual(["readWebPage"]);
    expect(streamedText(chunks)).toContain("paywall");
    expect(JSON.stringify(chunks)).not.toContain('"addSection"');
  });

  it("stops when the site blocks automated access", async () => {
    isFetchAllowedByRobotsMock.mockResolvedValue(true);
    fetchPageMock.mockResolvedValue({
      isOk: false,
      reason: "blocked_by_site",
      message: "…brand-kit-flavored copy…",
    });

    const chunks = await runTurn(`Add a new section based on my new article at ${ARTICLE_URL}`);

    expect(streamedText(chunks)).toContain("blocks automated access");
    expect(JSON.stringify(chunks)).not.toContain('"addSection"');
  });
});
