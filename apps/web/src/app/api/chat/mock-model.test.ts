import { describe, expect, it } from "vitest";
import { GENERATION_REQUEST_DATA_PART_TYPE, type FlockChatMessage } from "@/lib/chat-contract";
import {
  MOCK_COMPOSE_EMAIL_TEMPLATE_IDS,
  PERSON_INTENT_REGEX,
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

describe("PERSON_INTENT_REGEX", () => {
  /*
    The mock decides which page reader a no-key run calls, and /demo forces the
    mock server-side -- so this vocabulary is what those runs exercise instead
    of the routing guidance in tool-guidance.ts. When the two disagree, a mock
    run reproduces a bug the real path no longer has.
  */
  it("matches the way someone actually asks for an email about themselves", () => {
    const asked = [
      "create a new draft based on my portfolio website: sprioleau.dev. Pull in the images and details about me.",
      "make an email from my site: sprioleau.dev",
      "build a draft from my personal website",
      "turn my portfolio into an email",
    ];
    for (const message of asked) {
      expect(PERSON_INTENT_REGEX.test(message)).toBe(true);
    }
  });

  it("still leaves a topic page to the article reader", () => {
    const asked = [
      "turn this into an email: https://example.com/blog/shipping-faster",
      "summarize these release notes for a newsletter",
    ];
    for (const message of asked) {
      expect(PERSON_INTENT_REGEX.test(message)).toBe(false);
    }
  });
});
