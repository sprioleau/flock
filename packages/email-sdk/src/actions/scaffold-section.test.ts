import { describe, expect, it } from "vitest";
import { applyOperation } from "../operations/apply";
import { SECTION_TEMPLATE_IDS } from "../sections/catalog";
import type { SectionBlock } from "../schema/blocks";
import type { RandomFn } from "../schema/ids";
import { createSampleDocument } from "../store/document";
import { checkDocumentIntegrity } from "../store/integrity";
import type { ActionContext } from "./context";
import { emailActionRegistry } from "./builtins";
import { dispatchContentAction } from "./registry";
import {
  resolveScaffoldSectionOperation,
  scaffoldSectionAction,
  scaffoldSectionInputSchema,
  type ScaffoldSectionInput,
} from "./scaffold-section";

/** Deterministic LCG so generated ids are reproducible. */
function createSeededRandom(seed = 11): RandomFn {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const agentContext: ActionContext = {
  caller: "tool",
  authorId: "agent_thread_1",
  author: "agent",
  batchId: "batch_1",
  threadId: "thread_1",
};

// The sample document's top-level sections, top to bottom.
const SAMPLE_SECTION_IDS = ["sec_a1b2", "sec_c3d4"];

describe("scaffoldSectionInputSchema", () => {
  it("accepts every catalog templateId with omitted position and params", () => {
    for (const templateId of SECTION_TEMPLATE_IDS) {
      const parsed = scaffoldSectionInputSchema.safeParse({
        name: "scaffoldSection",
        templateId,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects unknown template ids and unknown param fields at the schema gate", () => {
    expect(
      scaffoldSectionInputSchema.safeParse({ name: "scaffoldSection", templateId: "promo-code" })
        .success,
    ).toBe(false);
    expect(
      scaffoldSectionInputSchema.safeParse({
        name: "scaffoldSection",
        templateId: "hero",
        params: { headline: "Hi", buttonColor: "#ff0000" },
      }).success,
    ).toBe(false);
  });

  it("accepts all four position shapes", () => {
    for (const position of [
      "top",
      "bottom",
      { beforeSectionId: "sec_a1b2" },
      { afterSectionId: "sec_c3d4" },
    ]) {
      expect(
        scaffoldSectionInputSchema.safeParse({
          name: "scaffoldSection",
          templateId: "testimonial",
          position,
        }).success,
      ).toBe(true);
    }
  });
});

describe("resolveScaffoldSectionOperation", () => {
  const doc = createSampleDocument();

  it.each([
    [undefined, 2],
    ["bottom" as const, 2],
    ["top" as const, 0],
    [{ beforeSectionId: "sec_c3d4" }, 1],
    [{ afterSectionId: "sec_c3d4" }, 2],
    [{ beforeSectionId: "sec_a1b2" }, 0],
    [{ afterSectionId: "sec_a1b2" }, 1],
  ])("resolves position %j to insertion index %i", (position, expectedIndex) => {
    const result = resolveScaffoldSectionOperation({
      doc,
      input: { name: "scaffoldSection", templateId: "hero", position },
      random: createSeededRandom(),
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.op.name).toBe("addSection");
    expect(result.op.index).toBe(expectedIndex);
  });

  it("resolves to ONE addSection op whose subtree applies cleanly", () => {
    const result = resolveScaffoldSectionOperation({
      doc,
      input: {
        name: "scaffoldSection",
        templateId: "testimonial",
        params: { quote: "Best tool we use.", attribution: "Sam Rivera", role: "COO, Contoso" },
      },
      random: createSeededRandom(),
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const applied = applyOperation(doc, result.op);
    expect(applied.isOk).toBe(true);
    if (!applied.isOk) return;
    expect(checkDocumentIntegrity(applied.doc).errors).toEqual([]);
    expect(JSON.stringify(applied.doc)).toContain("Best tool we use.");
  });

  it("returns unknown_section_template listing the valid ids", () => {
    const result = resolveScaffoldSectionOperation({
      doc,
      input: { name: "scaffoldSection", templateId: "promo-code" } as ScaffoldSectionInput,
      random: createSeededRandom(),
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.errors[0]!.code).toBe("unknown_section_template");
    for (const templateId of SECTION_TEMPLATE_IDS) {
      expect(result.errors[0]!.message).toContain(templateId);
    }
  });

  it("returns target_not_found for a bad anchor, quoting the ACTUAL section ids", () => {
    const result = resolveScaffoldSectionOperation({
      doc,
      input: {
        name: "scaffoldSection",
        templateId: "hero",
        position: { afterSectionId: "sec_gone" },
      },
      random: createSeededRandom(),
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.errors[0]!.code).toBe("target_not_found");
    expect(result.errors[0]!.blockId).toBe("sec_gone");
    for (const sectionId of SAMPLE_SECTION_IDS) {
      expect(result.errors[0]!.message).toContain(sectionId);
    }
  });

  it("returns op_validation_failed with the exact issues for bad params", () => {
    const result = resolveScaffoldSectionOperation({
      doc,
      input: {
        name: "scaffoldSection",
        templateId: "stats",
        params: { stats: [{ value: "1" }] },
      },
      random: createSeededRandom(),
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.errors[0]!.code).toBe("op_validation_failed");
    expect(result.errors[0]!.message).toContain('section template "stats"');
    expect(result.errors[0]!.message).toContain("label");
  });

  it("re-builds with fresh ids when a generated id already exists in the document", () => {
    // First resolution against the sample doc, with a fixed seed.
    const first = resolveScaffoldSectionOperation({
      doc,
      input: { name: "scaffoldSection", templateId: "testimonial" },
      random: createSeededRandom(99),
    });
    expect(first.isOk).toBe(true);
    if (!first.isOk) return;
    // Poison the doc with the id the SAME seed would generate first.
    const poisonedDoc = {
      ...doc,
      [first.op.section.id]: {
        ...(doc.sec_a1b2 as SectionBlock),
        id: first.op.section.id,
        childrenIds: [],
      },
    };
    const second = resolveScaffoldSectionOperation({
      doc: poisonedDoc,
      input: { name: "scaffoldSection", templateId: "testimonial" },
      random: createSeededRandom(99),
    });
    expect(second.isOk).toBe(true);
    if (!second.isOk) return;
    expect(second.op.section.id).not.toBe(first.op.section.id);
    expect(poisonedDoc[second.op.section.id]).toBeUndefined();
  });
});

describe("scaffoldSection dispatch (registry end to end)", () => {
  it("is a sequential, unapproved, intent-shaped content action", () => {
    expect(scaffoldSectionAction.kind).toBe("content");
    expect(scaffoldSectionAction.readOnly).toBe(false);
    expect(scaffoldSectionAction.parallelSafe).toBe(false);
    expect(scaffoldSectionAction.needsApproval).toBe(false);
    expect(scaffoldSectionAction.resolveOperation).toBeDefined();
  });

  it("dispatches to ONE addSection op; the generated inverse removes the WHOLE section", () => {
    const doc = createSampleDocument();
    const result = dispatchContentAction({
      registry: emailActionRegistry,
      doc,
      name: "scaffoldSection",
      input: {
        name: "scaffoldSection",
        templateId: "hero",
        position: "top",
        params: { headline: "Launch day", ctaLabel: "See it", ctaHref: "https://example.com/x" },
      },
      context: agentContext,
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;

    // The op-log entry records the RESOLVED plain operation, not the intent.
    expect(result.logEntry.op.name).toBe("addSection");
    expect(result.logEntry.batchId).toBe("batch_1");
    expect(checkDocumentIntegrity(result.doc).errors).toEqual([]);
    const root = result.doc.root!;
    expect(root.childrenIds).toHaveLength(3);
    expect(JSON.stringify(result.doc)).toContain("Launch day");

    // One undo step: the standard removeBlock inverse restores the doc exactly.
    expect(result.inverse.name).toBe("removeBlock");
    const undone = applyOperation(result.doc, result.inverse);
    expect(undone.isOk).toBe(true);
    if (!undone.isOk) return;
    expect(undone.doc).toEqual(doc);
  });

  it("surfaces resolver repair hints through dispatch as retryable", () => {
    const result = dispatchContentAction({
      registry: emailActionRegistry,
      doc: createSampleDocument(),
      name: "scaffoldSection",
      input: {
        name: "scaffoldSection",
        templateId: "footer",
        position: { beforeSectionId: "sec_zzzz" },
      },
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("retryable");
    expect(result.errors[0]!.code).toBe("target_not_found");
    expect(result.errors[0]!.message).toContain("sec_a1b2");
  });

  it("rejects unknown templateIds at the schema gate as retryable", () => {
    const result = dispatchContentAction({
      registry: emailActionRegistry,
      doc: createSampleDocument(),
      name: "scaffoldSection",
      input: { name: "scaffoldSection", templateId: "discount-code" },
      context: agentContext,
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.failureKind).toBe("retryable");
    expect(result.errors[0]!.code).toBe("op_validation_failed");
  });
});
