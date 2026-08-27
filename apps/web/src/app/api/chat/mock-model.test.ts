import { describe, expect, it } from "vitest";
import { GENERATION_REQUEST_DATA_PART_TYPE, type FlockChatMessage } from "@/lib/chat-contract";
import {
  MOCK_COMPOSE_EMAIL_TEMPLATE_IDS,
  planMockToolCall,
  readMockIntentText,
} from "./mock-model";

/**
 * The mock's intent seam. It matters because the drafts-menu AI actions now
 * send a SHORT sentence and let the server assemble the brief: the mock has no
 * assembly step, so without the generation-request signal it would scaffold one
 * section where the real pipeline streams a whole email — a demo and a test
 * suite quietly exercising the wrong path.
 */

/** The mock's own compose trigger (mock-model.ts, module-private). */
const COMPOSE_EMAIL_REGEX = /\b(?:full|whole|entire|complete)\s+email\b/i;

function buildUserMessage(parts: unknown[]): FlockChatMessage[] {
  return [{ id: "m1", role: "user", parts }] as unknown as FlockChatMessage[];
}

describe("readMockIntentText", () => {
  it("fires the compose script for a generation request's short sentence", () => {
    const intentText = readMockIntentText(
      buildUserMessage([
        { type: "text", text: 'Add a design variation of "RenderATL 2026". brighter colors' },
        {
          type: GENERATION_REQUEST_DATA_PART_TYPE,
          data: { kind: "designVariation", sourceDocumentId: "doc_1" },
        },
      ]),
    );

    // The sentence alone would NOT match — that is the whole point.
    expect('Add a design variation of "RenderATL 2026". brighter colors').not.toMatch(
      COMPOSE_EMAIL_REGEX,
    );
    expect(intentText).toMatch(COMPOSE_EMAIL_REGEX);
    // And the script it selects is the multi-section one.
    expect(MOCK_COMPOSE_EMAIL_TEMPLATE_IDS.length).toBeGreaterThan(1);
  });

  it("keeps the person's own words, which every other script keys off", () => {
    const intentText = readMockIntentText(
      buildUserMessage([{ type: "text", text: "send a test email to me@example.com" }]),
    );
    expect(intentText).toBe("send a test email to me@example.com");
  });

  it("reads the LAST user message, not the first", () => {
    const messages = [
      ...buildUserMessage([{ type: "text", text: "add a hero section" }]),
      ...(buildUserMessage([{ type: "text", text: "now switch to mobile preview" }]).map(
        (message) => ({ ...message, id: "m2" }),
      ) as FlockChatMessage[]),
    ];
    expect(readMockIntentText(messages)).toBe("now switch to mobile preview");
  });

  it("returns empty text for a history with no user message at all", () => {
    expect(readMockIntentText([])).toBe("");
  });
});

describe("planMockToolCall — a URL routes to the one page reader", () => {
  /*
    This replaces a fifteen-keyword PERSON_INTENT_REGEX that decided WHICH of
    two readers a no-key run called. The regex is gone with the second reader,
    and the property worth pinning is now the opposite of what it asserted:
    HOW the user phrases the request must not change which tool runs.

    That matters here specifically because /demo forces the mock server-side,
    so these runs are what a no-API-key user actually exercises. A mock that
    routed on phrasing would keep reproducing the original bug long after the
    real path stopped having it.
  */
  /*
    These span the exact axis the deleted regex split on: "about a person" on
    one side, "about a topic" on the other. Under the two-reader design the
    first two routed to the person reader and the last three to the article
    reader; now every one of them reads the page, and which one it is becomes
    a question answered AFTER the fetch instead of before it.
  */
  const phrasings = [
    "make an email from my site: https://example.com",
    "build a draft from my personal website https://example.com",
    "introduce this person https://example.com",
    "turn this into an email: https://example.com",
    "summarize these release notes for a newsletter: https://example.com",
    "https://example.com",
  ];

  it("calls readWebPage no matter how the request is worded", () => {
    for (const message of phrasings) {
      const planned = planMockToolCall({ lastUserText: message, selectedBlockId: undefined });
      expect(planned.toolName).toBe("readWebPage");
    }
  });

  it("passes the URL through unchanged", () => {
    const planned = planMockToolCall({
      lastUserText: "build from https://example.com/a/b?c=d",
      selectedBlockId: undefined,
    });
    expect(planned.input).toMatchObject({ url: "https://example.com/a/b?c=d" });
  });
});
