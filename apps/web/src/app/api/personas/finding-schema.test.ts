import { describe, expect, it } from "vitest";
import {
  FINDING_TEXT_CAPS,
  runnerOutputSchema,
  truncateFindingProse,
  truncateFindingText,
} from "./finding-schema";

/**
 * Regression: a long visible label (a wordy button) used to fail the WHOLE
 * persona run — the structured-output schema hard-capped targetBlockNames at
 * 60 chars and generateObject rejects any schema violation. Prose fields now
 * validate as plain strings and the route truncates on receipt instead.
 */

const LONG_LABEL =
  'the button labeled "Join thousands of happy customers who transformed their ' +
  'email marketing with our revolutionary AI-powered platform today"';

function buildFinding(overrides: Record<string, unknown> = {}) {
  return {
    personaSlug: "builtin/tone-police",
    title: "Button label clashes with the friendly tone",
    description: "The long hard-sell label clashes with the email's warm voice.",
    targetBlockNames: [LONG_LABEL],
    targetBlockIds: ["btn_t9u0"],
    ...overrides,
  };
}

describe("runnerOutputSchema (long-label reliability)", () => {
  it("accepts a targetBlockName far beyond the old 60-char cap", () => {
    expect(LONG_LABEL.length).toBeGreaterThan(60);
    const result = runnerOutputSchema.safeParse({ findings: [buildFinding()] });
    expect(result.success).toBe(true);
  });

  it("accepts over-long title and description prose too (same failure family)", () => {
    const result = runnerOutputSchema.safeParse({
      findings: [
        buildFinding({
          title: "t".repeat(400),
          description: "d".repeat(2000),
        }),
      ],
    });
    expect(result.success).toBe(true);
  });

  it("still enforces the structural counts (empty targetBlockNames rejected)", () => {
    const result = runnerOutputSchema.safeParse({
      findings: [buildFinding({ targetBlockNames: [] })],
    });
    expect(result.success).toBe(false);
  });
});

describe("truncateFindingText", () => {
  it("returns short text unchanged (byte-stable under the cap)", () => {
    expect(truncateFindingText({ text: "short", cap: 60 })).toBe("short");
  });

  it("truncates to the cap with a trailing ellipsis", () => {
    const truncated = truncateFindingText({ text: "x".repeat(200), cap: 60 });
    expect(truncated.length).toBeLessThanOrEqual(60);
    expect(truncated.endsWith("…")).toBe(true);
  });
});

describe("truncateFindingProse", () => {
  it("caps every prose field and leaves ids/edits untouched", () => {
    const parsed = runnerOutputSchema.parse({
      findings: [
        buildFinding({
          title: "t".repeat(400),
          description: "d".repeat(2000),
          proposedEdits: [{ blockId: "btn_t9u0", property: "label", value: "Join us" }],
        }),
      ],
    });
    const truncated = truncateFindingProse(parsed.findings[0]!);
    expect(truncated.title.length).toBeLessThanOrEqual(FINDING_TEXT_CAPS.title);
    expect(truncated.description.length).toBeLessThanOrEqual(FINDING_TEXT_CAPS.description);
    for (const name of truncated.targetBlockNames) {
      expect(name.length).toBeLessThanOrEqual(FINDING_TEXT_CAPS.targetBlockName);
    }
    expect(truncated.targetBlockIds).toEqual(["btn_t9u0"]);
    expect(truncated.proposedEdits).toEqual([
      { blockId: "btn_t9u0", property: "label", value: "Join us" },
    ]);
  });
});
