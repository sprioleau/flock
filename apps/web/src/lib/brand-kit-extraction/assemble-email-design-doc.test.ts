/*
  The assembler is the guardrail that makes email-design.md un-droppable:
  whatever the model returns, the doc is laid out under a fixed header set and
  clamped so it can never overrun MAX_EMAIL_DESIGN_DOC_LENGTH. These tests pin
  the two invariants (all headers present; always within the ceiling) and the
  honest all-empty degrade.
*/
import { describe, expect, it } from "vitest";
import { MAX_EMAIL_DESIGN_DOC_LENGTH } from "@/lib/brand-kit";
import {
  assembleEmailDesignMarkdown,
  type EmailDesignSections,
} from "./assemble-email-design-doc";

const CANONICAL_HEADERS = [
  "## Brand Essence",
  "## Signature Moves",
  "## Color System",
  "## Typography",
  "## Layout & Structure",
  "## Components",
  "### Header",
  "### Hero",
  "### CTA",
  "### Card",
  "### Divider",
  "### Footer",
  "## Voice & Tone",
];

function sectionsWith(body: string): EmailDesignSections {
  return {
    brandEssence: body,
    signatureMoves: body,
    colorSystem: body,
    typography: body,
    layoutStructure: body,
    components: { header: body, hero: body, cta: body, card: body, divider: body, footer: body },
    voiceAndTone: body,
  };
}

const EMPTY = sectionsWith("");

describe("assembleEmailDesignMarkdown", () => {
  it("lays out every canonical header in order, with the section prose", () => {
    const doc = assembleEmailDesignMarkdown({
      ...sectionsWith(""),
      brandEssence: "Plain-spoken and utilitarian.",
      components: { ...EMPTY.components, cta: "Solid accent button." },
      voiceAndTone: "Short sentences, first person.",
    });
    for (const header of CANONICAL_HEADERS) {
      expect(doc).toContain(header);
    }
    expect(doc).toContain("Plain-spoken and utilitarian.");
    expect(doc).toContain("Solid accent button.");
    expect(doc).toContain("Short sentences, first person.");
    /*
      Headers appear in canonical order.
    */
    const positions = CANONICAL_HEADERS.map((header) => doc.indexOf(header));
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it("returns \"\" when every section is empty (no signal, no doc)", () => {
    expect(assembleEmailDesignMarkdown(EMPTY)).toBe("");
  });

  it("never exceeds the ceiling, and keeps all headers, when every section overruns its budget", () => {
    /*
      Each body is far larger than any per-section budget and the naive
      concatenation would blow well past the 16000-char ceiling — the point
      the owner made: a long page must be summarised, not dropped.
    */
    const flood = "A concrete sentence describing how this brand looks and reads. ".repeat(500);
    const doc = assembleEmailDesignMarkdown(sectionsWith(flood));
    expect(doc.length).toBeLessThanOrEqual(MAX_EMAIL_DESIGN_DOC_LENGTH);
    for (const header of CANONICAL_HEADERS) {
      expect(doc).toContain(header);
    }
  });

  it("passes short bodies through unclamped", () => {
    const body = "One short line.";
    const doc = assembleEmailDesignMarkdown({ ...EMPTY, brandEssence: body });
    expect(doc).toContain(`## Brand Essence\n\n${body}`);
  });

  it("trims an over-budget body at a boundary without appending mid-word", () => {
    const budgetBustingParagraph = `${"word ".repeat(1000)}`;
    const doc = assembleEmailDesignMarkdown({ ...EMPTY, layoutStructure: budgetBustingParagraph });
    /*
      The Layout & Structure body is clamped; the doc stays whole and bounded.
    */
    expect(doc).toContain("## Layout & Structure");
    expect(doc.length).toBeLessThanOrEqual(MAX_EMAIL_DESIGN_DOC_LENGTH);
    expect(doc.endsWith("word")).toBe(false);
  });
});
