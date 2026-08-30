import { describe, expect, it } from "vitest";
import {
  MAX_VISIBLE_PROMPT_STARTERS,
  PROMPT_STARTERS,
  selectPromptStarters,
} from "./prompt-starters";

/*
  What these protect: a starter chip's whole job is to be the first thing a
  brand-new user asks the copilot for. Everything below is a way that job fails
  quietly — a chip that appears twice, a chip that is redundant on the canvas it
  is shown on, a list that has grown into a menu, or prompt text that teaches
  the user to talk to the tool layer instead of to a design partner.
*/

describe("the shown set", () => {
  it("swaps the brand chip for the test-send chip once a kit is saved — never a hole", () => {
    const firstRun = selectPromptStarters({ hasSavedBrandKit: false }).map(
      (starter) => starter.id,
    );
    const returning = selectPromptStarters({ hasSavedBrandKit: true }).map(
      (starter) => starter.id,
    );

    /*
      The demo moment leads for a canvas with no brand of its own.
    */
    expect(firstRun).toContain("brand-from-website");
    expect(firstRun).not.toContain("send-test");

    /*
      Once the brand is in, that chip is redundant and the next move takes
      its slot — the count must not quietly drop to three.
    */
    expect(returning).not.toContain("brand-from-website");
    expect(returning).toContain("send-test");
    expect(returning).toHaveLength(firstRun.length);
  });

  it("never grows into a menu, whatever the gate says", () => {
    for (const hasSavedBrandKit of [false, true]) {
      expect(selectPromptStarters({ hasSavedBrandKit }).length).toBeLessThanOrEqual(
        MAX_VISIBLE_PROMPT_STARTERS,
      );
    }
    /*
      Three or four. A list long enough to need reading is a worse version of
      the text box it sits above.
    */
    expect(MAX_VISIBLE_PROMPT_STARTERS).toBeLessThanOrEqual(4);
  });

  it("leads with the core loop in both states, because that is what the panel is for", () => {
    expect(selectPromptStarters({ hasSavedBrandKit: false })[0]?.id).toBe("rewrite-opening");
    expect(selectPromptStarters({ hasSavedBrandKit: true })[0]?.id).toBe("rewrite-opening");
  });

  it("keeps ids unique — a duplicate would collide as a React key and hide a chip", () => {
    const ids = PROMPT_STARTERS.map((starter) => starter.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the prompt text", () => {
  it("never names an internal identifier — it becomes the USER's own message", () => {
    for (const starter of PROMPT_STARTERS) {
      /*
        Block ids (sec_a1b2, btn_x9k3) and tool names are the agent's private
        vocabulary; the system prompt forbids them in prose for the same
        reason they must not appear in a prompt we put in the user's mouth.
      */
      expect(starter.prompt).not.toMatch(/\b(?:sec|btn|txt|img|div|row|col|lnk)_[a-z0-9]+\b/i);
      expect(starter.prompt).not.toMatch(
        /scaffoldSection|applyTheme|openPanel|updateBlockProperties|sendTestEmail/,
      );
    }
  });

  it("hard-codes no recipient address — the user types their own before sending", () => {
    /*
      The test-send prompt deliberately trails off so the caret (dropped at
      the end by the INSERT handoff) lands where the address goes. A baked-in
      address would mail a stranger the moment someone hit send.
    */
    for (const starter of PROMPT_STARTERS) {
      expect(starter.prompt).not.toContain("@");
    }
    const sendTest = PROMPT_STARTERS.find((starter) => starter.id === "send-test");
    expect(sendTest?.prompt.endsWith(" ")).toBe(true);
  });

  it("says something more than the chip's own label — a category label is not a prompt", () => {
    /*
      "Add a section" is a fine CHIP and a useless PROMPT: it teaches nothing
      about what the copilot will take and produces a worse first result than
      the specifics the user is meant to edit.
    */
    for (const starter of PROMPT_STARTERS) {
      expect(starter.label.trim().length).toBeGreaterThan(0);
      expect(starter.prompt.trim().toLowerCase()).not.toBe(starter.label.trim().toLowerCase());
      expect(starter.prompt.trim().length).toBeGreaterThan(starter.label.trim().length);
    }
  });

  it("gives no two chips the same words or the same ask", () => {
    /*
      Two chips that read alike, or that send the same prompt, spend one of
      only four slots on nothing.
    */
    const labels = PROMPT_STARTERS.map((starter) => starter.label.toLowerCase());
    const prompts = PROMPT_STARTERS.map((starter) => starter.prompt);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(prompts).size).toBe(prompts.length);
  });
});
