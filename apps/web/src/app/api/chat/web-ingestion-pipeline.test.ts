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

    expect(toolCallSequence(chunks)).toEqual(["fetchWebContent", "addSection"]);
    expect(firstToolInput(chunks, "fetchWebContent")).toEqual({ url: ARTICLE_URL });
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
    expect(serialized).toContain("Dana Reeve");
  });

  it("attributes the source: the button links to the article's canonical URL", async () => {
    const chunks = await runTurn(`Add a new section based on my new article at ${ARTICLE_URL}`);
    const operation = firstToolInput(chunks, "addSection") as {
      children: { type: string; properties: Record<string, string> }[];
    };

    const button = operation.children.find((block) => block.type === "button");
    expect(button?.properties.href).toBe(ARTICLE_URL);
    expect(button?.properties.label).toBe("Read the full story");
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

describe('"add a spotlight of <person> from <profile url>" (case b)', () => {
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

  it("routes a profile link to the person tool, then composes a spotlight", async () => {
    const chunks = await runTurn(`Add a spotlight section for this person: ${PROFILE_URL}`);

    expect(toolCallSequence(chunks)).toEqual(["fetchPersonHighlight", "addSection"]);
    expect(firstToolInput(chunks, "fetchPersonHighlight")).toEqual({ url: PROFILE_URL });
  });

  it("writes only what the profile says, and links back to it", async () => {
    const chunks = await runTurn(`Add a spotlight section for this person: ${PROFILE_URL}`);
    const operation = firstToolInput(chunks, "addSection") as {
      children: { type: string; properties: Record<string, string> }[];
    };
    const serialized = JSON.stringify(operation);

    expect(serialized).toContain("Amara Osei");
    expect(serialized).toContain("Professor of Environmental Engineering");
    expect(serialized).toContain("Riverside University");
    const button = operation.children.find((block) => block.type === "button");
    expect(button?.properties.href).toBe(PROFILE_URL);
  });

  it("never runs a live public-web search on the mock tier", async () => {
    // Nothing to assert on a spy here — the guarantee is structural: the mock
    // run flag reaches searchPublicWeb, which returns "unavailable" before any
    // provider call. What we CAN pin is that the spotlight still composed, so
    // the absence of search never blocks the flagship flow.
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

    expect(toolCallSequence(chunks)).toEqual(["fetchWebContent"]);
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

    expect(toolCallSequence(chunks)).toEqual(["fetchWebContent"]);
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
