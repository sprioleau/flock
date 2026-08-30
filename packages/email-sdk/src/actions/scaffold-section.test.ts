import { describe, expect, it } from "vitest";
import { applyOperation } from "../operations/apply";
import { getSectionTemplate, SECTION_TEMPLATE_IDS } from "../sections/catalog";
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

/*
  Deterministic LCG so generated ids are reproducible.
*/
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

/*
  The sample document's top-level sections, top to bottom.
*/
const SAMPLE_SECTION_IDS = ["sec_a1b2", "sec_c3d4", "sec_e5f6"];

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

  it("accepts saved-section templateIds (host-resolved) with an optional position", () => {
    expect(
      scaffoldSectionInputSchema.safeParse({
        name: "scaffoldSection",
        templateId: "saved:kd70yrb5kq2r62zwn5x6q5aptd8bkzwc",
      }).success,
    ).toBe(true);
    expect(
      scaffoldSectionInputSchema.safeParse({
        name: "scaffoldSection",
        templateId: "saved:abc123",
        position: "top",
      }).success,
    ).toBe(true);
    /*
      The bare prefix is not a valid saved id.
    */
    expect(
      scaffoldSectionInputSchema.safeParse({ name: "scaffoldSection", templateId: "saved:" })
        .success,
    ).toBe(false);
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

  /*
    The captured live failure (drafts menu -> "Add design variation", Labor Day
    sale): the model sent the hero template two params it does not have,
    `subheadline` (it meant `body`) and `brandName`. Before the fix the ONLY
    issue Zod surfaced was the saved-section branch's regex complaint
    ("templateId must match /^saved:.+$/"), which is not the problem and which
    no model can self-correct from.
  */
  it("names the offending hero params — never the saved: regex — for the captured payload", () => {
    const parsed = scaffoldSectionInputSchema.safeParse({
      position: "bottom",
      name: "scaffoldSection",
      params: {
        subheadline:
          "Welcome to Flock. This is a real email, not a blank page — every block is yours to rewrite, restyle, or delete.",
        brandName: "Flock",
        ctaLabel: "Shop the Sale",
        headline: "Labor Day Sale: 20% Off All Merch!",
        ctaHref: "https://example.com/get-started",
      },
      templateId: "hero",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const message = parsed.error.issues.map((issue) => issue.message).join(" ");
    /*
      The real problem, named.
    */
    expect(message).toContain("subheadline");
    expect(message).toContain("brandName");
    /*
      The valid vocabulary, so the model can map subheadline -> body itself.
    */
    expect(message).toContain("headline");
    expect(message).toContain("body");
    expect(message).toContain("imageAlt");
    expect(message).toContain("ctaLabel");
    expect(message).toContain("ctaHref");
    /*
      The fallback branch's complaint must never be what the model is told.
    */
    expect(message).not.toContain("saved:");
  });

  it("names the valid template ids for an unknown templateId", () => {
    const parsed = scaffoldSectionInputSchema.safeParse({
      name: "scaffoldSection",
      templateId: "promo-code",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const message = parsed.error.issues.map((issue) => issue.message).join(" ");
    expect(message).toContain('"promo-code"');
    for (const templateId of SECTION_TEMPLATE_IDS) {
      expect(message).toContain(templateId);
    }
  });

  it("reports unknown fields nested inside a template's list params", () => {
    const parsed = scaffoldSectionInputSchema.safeParse({
      name: "scaffoldSection",
      templateId: "stats",
      params: { stats: [{ value: "20%", label: "Off", caption: "everything" }] },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const message = parsed.error.issues.map((issue) => issue.message).join(" ");
    expect(message).toContain("caption");
    expect(message).not.toContain("saved:");
  });

  /*
    The image-bearing templates accept an image-source override so the
    content-ingestion pipeline can put a REHOSTED image into a section. The
    model must never be able to write one: it would invent or hotlink an
    address, and the field would churn a large cached prompt prefix for no
    gain. This is the assertion that stops someone re-widening the model
    surface by feeding `paramsSchema` back into the union.
  */
  const IMAGE_SOURCE_PARAMS_BY_TEMPLATE_ID: readonly (readonly [
    string,
    Record<string, unknown>,
  ])[] = [
    ["hero", { imageSrc: "https://storage.example.com/rehosted/a.png" }],
    ["hero-split", { imageSrc: "https://storage.example.com/rehosted/a.png" }],
    [
      "article",
      { imageAlt: "A portrait", imageSrc: "https://storage.example.com/rehosted/a.png" },
    ],
    ["product", { imageSrc: "https://storage.example.com/rehosted/a.png" }],
    ["header", { imageSrc: "https://storage.example.com/rehosted/a.png" }],
    ["header-centered", { imageSrc: "https://storage.example.com/rehosted/a.png" }],
    [
      "image-gallery",
      { images: [{ alt: "One", src: "https://storage.example.com/rehosted/a.png" }, { alt: "Two" }] },
    ],
  ];

  it.each(IMAGE_SOURCE_PARAMS_BY_TEMPLATE_ID)(
    "%s: refuses an image source from the model though the template itself accepts one",
    (templateId, params) => {
      expect(
        scaffoldSectionInputSchema.safeParse({ name: "scaffoldSection", templateId, params })
          .success,
      ).toBe(false);
      expect(getSectionTemplate(templateId)!.paramsSchema.safeParse(params).success).toBe(true);
    },
  );

  it("still accepts the model-visible params of every image-bearing template", () => {
    expect(
      scaffoldSectionInputSchema.safeParse({
        name: "scaffoldSection",
        templateId: "hero",
        params: { headline: "New season", imageAlt: "A coat on a rail" },
      }).success,
    ).toBe(true);
    expect(
      scaffoldSectionInputSchema.safeParse({
        name: "scaffoldSection",
        templateId: "image-gallery",
        params: { images: [{ alt: "One", href: "https://example.com" }, { alt: "Two" }] },
      }).success,
    ).toBe(true);
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
    [undefined, 3],
    ["bottom" as const, 3],
    ["top" as const, 0],
    [{ beforeSectionId: "sec_c3d4" }, 1],
    [{ afterSectionId: "sec_c3d4" }, 2],
    [{ afterSectionId: "sec_e5f6" }, 3],
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

  it("returns a saved-section repair hint when a saved id reaches the catalog resolver", () => {
    /*
      Saved ids resolve in the HOST app (which owns the subtrees); reaching
      this resolver means the row is gone or the host intercept was skipped.
    */
    const result = resolveScaffoldSectionOperation({
      doc,
      input: { name: "scaffoldSection", templateId: "saved:gone123" } as ScaffoldSectionInput,
      random: createSeededRandom(),
    });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.errors[0]!.code).toBe("unknown_section_template");
    expect(result.errors[0]!.message).toContain("saved:gone123");
    expect(result.errors[0]!.message).toContain("deleted");
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
    /*
      First resolution against the sample doc, with a fixed seed.
    */
    const first = resolveScaffoldSectionOperation({
      doc,
      input: { name: "scaffoldSection", templateId: "testimonial" },
      random: createSeededRandom(99),
    });
    expect(first.isOk).toBe(true);
    if (!first.isOk) return;
    /*
      Poison the doc with the id the SAME seed would generate first.
    */
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

    /*
      The dispatch result carries the RESOLVED plain operation, not the intent.
    */
    expect(result.op.name).toBe("addSection");
    expect(result.context.batchId).toBe("batch_1");
    expect(checkDocumentIntegrity(result.doc).errors).toEqual([]);
    const root = result.doc.root!;
    expect(root.childrenIds).toHaveLength(4);
    expect(JSON.stringify(result.doc)).toContain("Launch day");

    /*
      One undo step: the standard removeBlock inverse restores the doc exactly.
    */
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
