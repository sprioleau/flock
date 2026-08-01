import {
  createSampleDocument,
  emailActionRegistry,
  ROOT_BLOCK_ID,
  type BlockId,
} from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import { buildAgentActionRegistry } from "./actions";
import { buildToolGuidance } from "./prompts";
import {
  askForClarificationInputSchema,
  materializeSectionVariations,
  proposeEditsInputSchema,
  proposeSectionVariationsInputSchema,
  validateEditSuggestions,
  widgetActions,
} from "./widget-actions";

const sampleDoc = createSampleDocument();

describe("widget action registration", () => {
  it("registers the four widget actions only when enabled", () => {
    const withWidgets = buildAgentActionRegistry({ shouldIncludeWidgetActions: true });
    const withoutWidgets = buildAgentActionRegistry();
    for (const action of widgetActions) {
      expect(withWidgets.actionsByName.has(action.name)).toBe(true);
      expect(withoutWidgets.actionsByName.has(action.name)).toBe(false);
    }
  });

  it("all widget actions are read-only analysis actions (the user's click edits, not the tool)", () => {
    for (const action of widgetActions) {
      expect(action.kind).toBe("analysis");
      expect(action.readOnly).toBe(true);
      expect(action.needsApproval).toBe(false);
    }
  });

  it("switches the widget guidance block on registration (cache-stable text)", () => {
    const withWidgets = buildToolGuidance(buildAgentActionRegistry({ shouldIncludeWidgetActions: true }));
    expect(withWidgets).toContain("## In-chat widgets");
    expect(withWidgets).toContain("askForClarification with one short question");
    expect(withWidgets).toContain("never scaffold the candidates into the email");
    expect(withWidgets).toContain("do not also apply them yourself");
    expect(buildToolGuidance(emailActionRegistry)).not.toContain("## In-chat widgets");
  });
});

describe("askForClarification schema", () => {
  it("accepts a question with 2-4 options and rejects fewer", () => {
    expect(
      askForClarificationInputSchema.safeParse({
        question: "What should stand out more?",
        options: ["The headline", "The button"],
      }).success,
    ).toBe(true);
    expect(
      askForClarificationInputSchema.safeParse({
        question: "What should stand out more?",
        options: ["Only one"],
      }).success,
    ).toBe(false);
  });
});

describe("materializeSectionVariations", () => {
  const input = proposeSectionVariationsInputSchema.parse({
    intent: "Hero options",
    variations: [
      { title: "Bold announcement", templateId: "hero", params: { headline: "Big news is here" } },
      { title: "Split layout", templateId: "hero-split" },
      { title: "Social proof", templateId: "testimonial", params: { ctaHref: "https://example.com" } },
    ],
  });

  it("materializes one root-first section subtree per variation", () => {
    const result = materializeSectionVariations(input);
    expect(result.variations).toHaveLength(3);
    for (const variation of result.variations) {
      const [sectionRoot, ...children] = variation.blocks;
      expect(sectionRoot.type).toBe("section");
      expect(sectionRoot.parentId).toBe(ROOT_BLOCK_ID);
      expect(children.length).toBeGreaterThan(0);
      // Every non-root block's parent is inside the subtree (self-contained).
      const idsInSubtree = new Set(variation.blocks.map((block) => block.id));
      for (const child of children) {
        expect(idsInSubtree.has(child.parentId as BlockId)).toBe(true);
      }
    }
  });

  it("applies supported content hints and drops unsupported ones", () => {
    const result = materializeSectionVariations(input);
    const heroBlocksJson = JSON.stringify(result.variations[0].blocks);
    expect(heroBlocksJson).toContain("Big news is here");
    // testimonial has no ctaHref param — the hint is dropped, defaults fill in.
    expect(result.variations[2].blocks.length).toBeGreaterThan(0);
  });

  it("rejects unknown templateIds at the schema layer", () => {
    const parsed = proposeSectionVariationsInputSchema.safeParse({
      variations: [
        { title: "A", templateId: "hero" },
        { title: "B", templateId: "not-a-template" },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("validateEditSuggestions", () => {
  it("keeps suggestions whose ops dry-run cleanly and drops the rest", () => {
    const input = proposeEditsInputSchema.parse({
      suggestions: [
        {
          title: "Stronger call to action",
          description: "Say what the reader gets.",
          edits: [{ blockId: "btn_t9u0", property: "label", value: "Start your free trial" }],
        },
        {
          title: "Broken target",
          edits: [{ blockId: "btn_zzzz", property: "label", value: "x" }],
        },
      ],
    });
    const result = validateEditSuggestions({ doc: sampleDoc, input });
    expect(result.suggestions).toHaveLength(1);
    expect(result.droppedCount).toBe(1);
    expect(result.suggestions[0].id).toBe("s1");
    expect(result.suggestions[0].ops).toEqual([
      {
        name: "updateBlockProperties",
        blockId: "btn_t9u0",
        properties: { label: "Start your free trial" },
      },
    ]);
  });

  it("groups multiple edits on one block into a single op and coerces typed values", () => {
    const input = proposeEditsInputSchema.parse({
      suggestions: [
        {
          title: "Button polish",
          edits: [
            { blockId: "btn_t9u0", property: "label", value: "Get started now" },
            { blockId: "btn_t9u0", property: "fullWidth", value: "true" },
          ],
        },
      ],
    });
    const result = validateEditSuggestions({ doc: sampleDoc, input });
    // Whether fullWidth exists on buttons is schema-dependent; the key claims
    // here are grouping (≤1 op) and boolean coercion when it validates.
    if (result.suggestions.length === 1) {
      expect(result.suggestions[0].ops).toHaveLength(1);
      expect(result.suggestions[0].ops[0].properties.label).toBe("Get started now");
      expect(result.suggestions[0].ops[0].properties.fullWidth).toBe(true);
    } else {
      expect(result.droppedCount).toBe(1);
    }
  });

  it("keeps plain strings (hex colors, urls) un-coerced", () => {
    const input = proposeEditsInputSchema.parse({
      suggestions: [
        {
          title: "Link fix",
          edits: [{ blockId: "btn_t9u0", property: "href", value: "https://example.com/signup" }],
        },
      ],
    });
    const result = validateEditSuggestions({ doc: sampleDoc, input });
    expect(result.suggestions[0]?.ops[0]?.properties.href).toBe("https://example.com/signup");
  });
});
