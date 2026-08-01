import { createEmptyDocument, createStarterDocument } from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import {
  buildDesignVariationPrompt,
  buildDraftOutline,
  buildIdeateDraftPrompt,
} from "./draft-generation";

/** The mock model's full-email compose trigger (mock-model.ts) — the prompts
 * MUST keep matching it so tests exercise the per-section streaming path. */
const COMPOSE_EMAIL_REGEX = /\b(?:full|whole|entire|complete)\s+email\b/i;

describe("buildDraftOutline", () => {
  it("returns an empty string for a blank (childless-root) document", () => {
    expect(buildDraftOutline(createEmptyDocument())).toBe("");
  });

  it("lists one numbered line per top-level section of the starter email", () => {
    const doc = createStarterDocument();
    const outline = buildDraftOutline(doc);
    const sectionCount = doc.root!.childrenIds.length;
    const lines = outline.split("\n");
    expect(lines).toHaveLength(sectionCount);
    lines.forEach((line, index) => {
      expect(line.startsWith(`${index + 1}. `)).toBe(true);
    });
  });

  it("describes content the way a user sees it — never block ids", () => {
    const outline = buildDraftOutline(createStarterDocument());
    expect(outline.length).toBeGreaterThan(0);
    // The starter email is a welcome email with buttons — some visible text
    // must survive into the outline.
    expect(outline).toMatch(/text "/);
    expect(outline).toMatch(/button "/);
    // Prefixed block ids (sec_x1y2, btn_a9k3, txt_…) must never leak.
    expect(outline).not.toMatch(/\b(?:sec|row|col|txt|btn|img|div|lnk|cod|spc)_[a-z0-9]+/i);
  });

  it("truncates long text runs to keep the outline skimmable", () => {
    const outline = buildDraftOutline(createStarterDocument());
    for (const line of outline.split("\n")) {
      const quotedRuns = line.match(/"[^"]*"/g) ?? [];
      for (const run of quotedRuns) {
        expect(run.length).toBeLessThanOrEqual(72); // snippet cap + quotes
      }
    }
  });
});

describe("prompt builders", () => {
  const promptInput = {
    sourceDraftName: "Launch email",
    sourceOutline: "1. text \"Welcome\"; button \"Get started\"",
  };

  it("both prompts trigger the mock model's full-email compose script", () => {
    expect(buildIdeateDraftPrompt(promptInput)).toMatch(COMPOSE_EMAIL_REGEX);
    expect(buildDesignVariationPrompt(promptInput)).toMatch(COMPOSE_EMAIL_REGEX);
  });

  it("both prompts carry the source draft's name and outline", () => {
    for (const prompt of [
      buildIdeateDraftPrompt(promptInput),
      buildDesignVariationPrompt(promptInput),
    ]) {
      expect(prompt).toContain(promptInput.sourceDraftName);
      expect(prompt).toContain(promptInput.sourceOutline);
    }
  });

  it("both prompts leave the agent free to pick a different theme", () => {
    expect(buildIdeateDraftPrompt(promptInput)).toMatch(/different theme/i);
    expect(buildDesignVariationPrompt(promptInput)).toMatch(/different theme/i);
  });

  it("the ideate prompt omits the context block when the source is blank", () => {
    const prompt = buildIdeateDraftPrompt({ sourceDraftName: "Draft 1", sourceOutline: "" });
    expect(prompt).not.toContain("Draft 1");
    expect(prompt).toMatch(COMPOSE_EMAIL_REGEX);
  });

  it("the variation prompt asks for the same content in a new design", () => {
    const prompt = buildDesignVariationPrompt(promptInput);
    expect(prompt).toMatch(/new take/i);
    expect(prompt).toMatch(/same content/i);
  });
});
