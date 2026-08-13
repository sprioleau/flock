import { describe, expect, it } from "vitest";
import { GENERATION_REQUEST_DATA_PART_TYPE, type FlockChatMessage } from "@/lib/chat-contract";
import { MOCK_COMPOSE_EMAIL_TEMPLATE_IDS, readMockIntentText } from "./mock-model";

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
