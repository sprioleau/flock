import { describe, expect, it } from "vitest";
import type { RandomFn } from "../schema/ids";
import { SECTION_TEMPLATES, getSectionTemplate } from "./catalog";
import {
  findContentFittingTemplate,
  hasContentForTemplate,
  isContentRequirementSatisfied,
} from "./content-fit";
import { defineSectionTemplate, getTemplateParamKeys, type SectionTemplate } from "./types";
import { resolveScaffoldSectionOperation } from "../actions/scaffold-section";
import { applyOperation } from "../operations/apply";
import { createSampleDocument } from "../store/document";
import { checkDocumentIntegrity } from "../store/integrity";
import { z } from "zod";

/*
  Deterministic LCG so ids stay stable when a template is built here.
*/
function createSeededRandom(seed = 7): RandomFn {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/*
  The param names one template's schema accepts.
*/
function getParamKeys(template: SectionTemplate): string[] {
  return [...(getTemplateParamKeys(template.paramsSchema) ?? [])];
}

/*
  A parsed params object as a plain record, without widening anything away.
*/
function toParamRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected a params object");
  }
  return Object.fromEntries(Object.entries(value));
}

/*
  THE DECLARATION ITSELF.

  `contentRequirements` says what a template needs in order to render REAL
  content — separately from the sample `.default()` values, which stay exactly
  where they are for the gallery and for `scaffoldSection`. The two invariants
  below are the pair that gives the declaration its meaning: nothing is
  satisfied by an empty params object (so a default can never stand in for
  content), and everything is satisfied by a fully-populated one (so the
  requirement names fields that actually exist and can actually be filled).
*/
describe("every catalog template declares what real content it needs", () => {
  it("names only params the template actually accepts", () => {
    for (const template of SECTION_TEMPLATES) {
      const paramKeys = getParamKeys(template);
      for (const copyParam of template.contentRequirements.copyParams) {
        expect(paramKeys).toContain(copyParam);
      }
      for (const listParam of template.contentRequirements.listParams) {
        expect(paramKeys).toContain(listParam.param);
        expect(listParam.minimumCount).toBeGreaterThan(0);
      }
    }
  });

  it("asks for at least one piece of real content — no template is trivially satisfied", () => {
    for (const template of SECTION_TEMPLATES) {
      const { copyParams, listParams } = template.contentRequirements;
      expect(copyParams.length + listParams.length).toBeGreaterThan(0);
    }
  });

  /*
    THE LOAD-BEARING ONE. Every param on all eighteen templates carries a
    `.default()`, which is why a section that arrived with no params at all
    rendered a complete, confident, fabricated email. The requirement check
    reads the params the CALLER supplied, never the defaulted output — so an
    empty plan satisfies nothing.
  */
  it("is satisfied by NO template when the caller supplied nothing", () => {
    for (const template of SECTION_TEMPLATES) {
      expect(
        isContentRequirementSatisfied({
          requirements: template.contentRequirements,
          params: {},
        }),
      ).toBe(false);
    }
  });

  it("is satisfied by every template when the caller supplied a full params object", () => {
    for (const template of SECTION_TEMPLATES) {
      /*
        The defaulted output is the one params object guaranteed to be complete
        for every template — using it here proves the requirement is reachable
        and correctly spelled, and it is the only place defaults are allowed to
        take part in a requirement check.
      */
      const complete = toParamRecord(template.paramsSchema.parse({}));
      expect(
        isContentRequirementSatisfied({
          requirements: template.contentRequirements,
          params: complete,
        }),
      ).toBe(true);
    }
  });

  it("declares an image count no larger than the images the template renders", () => {
    for (const template of SECTION_TEMPLATES) {
      const params: unknown = template.paramsSchema.parse({});
      const built = template.build({ params, random: createSeededRandom() });
      const renderedImageCount = built.children.filter((block) => block.type === "image").length;
      expect(renderedImageCount).toBeGreaterThanOrEqual(template.contentRequirements.imageCount);
      if (template.contentRequirements.imageCount === 0) {
        expect(renderedImageCount).toBe(0);
      }
    }
  });
});

describe("isContentRequirementSatisfied", () => {
  it("rejects a copy param that is present but blank", () => {
    expect(
      isContentRequirementSatisfied({
        requirements: { copyParams: ["headline"], listParams: [], imageCount: 0 },
        params: { headline: "   " },
      }),
    ).toBe(false);
  });

  it("rejects a list that is shorter than the declared minimum", () => {
    const requirements = {
      copyParams: [],
      listParams: [{ param: "features", minimumCount: 2 }],
      imageCount: 0,
    };
    expect(
      isContentRequirementSatisfied({
        requirements,
        params: { features: [{ title: "One", body: "Only one." }] },
      }),
    ).toBe(false);
    expect(
      isContentRequirementSatisfied({
        requirements,
        params: {
          features: [
            { title: "One", body: "The first." },
            { title: "Two", body: "The second." },
          ],
        },
      }),
    ).toBe(true);
  });
});

/*
  ELIGIBILITY IS MECHANICAL. "Does this content fit this template" is answered
  by the catalog, not by a model — the wesbos run chose sensible template ids
  and then failed exactly this half.
*/
describe("hasContentForTemplate", () => {
  it("accepts a hero whose headline and body the caller wrote", () => {
    const hero = getSectionTemplate("hero");
    expect(hero).toBeDefined();
    expect(
      hasContentForTemplate({
        template: hero!,
        params: { headline: "About Wes Bos", body: "Web developer and teacher." },
      }),
    ).toBe(true);
  });

  it("refuses a hero that has a headline and nothing else to say", () => {
    const hero = getSectionTemplate("hero");
    expect(
      hasContentForTemplate({ template: hero!, params: { headline: "About Wes Bos" } }),
    ).toBe(false);
  });

  it("refuses params the template's own schema rejects, real copy or not", () => {
    const hero = getSectionTemplate("hero");
    expect(
      hasContentForTemplate({
        template: hero!,
        params: { headline: "About Wes Bos", body: "Real copy.", ctaLabel: "" },
      }),
    ).toBe(false);
  });

  it("ignores params the template does not accept rather than choking on them", () => {
    const article = getSectionTemplate("article");
    expect(
      hasContentForTemplate({
        template: article!,
        params: { headline: "Teaching and Background", body: "Real copy.", quote: "a quote" },
        shouldProjectParams: true,
      }),
    ).toBe(true);
  });
});

describe("findContentFittingTemplate — substitute inside the category, else nothing", () => {
  it("swaps a footer-social with no social links for the plain footer", () => {
    const found = findContentFittingTemplate({
      category: "footer",
      excludedTemplateId: "footer-social",
      params: { companyName: "Wes Bos" },
    });
    expect(found?.template.id).toBe("footer");
    expect(found?.params).toEqual({ companyName: "Wes Bos" });
  });

  it("swaps a feature list with no features for the article that its copy does fit", () => {
    const found = findContentFittingTemplate({
      category: "content",
      excludedTemplateId: "feature-list",
      params: { headline: "Focus & Tech", body: "React, Node, and a lot of teaching." },
    });
    expect(found?.template.id).toBe("article");
  });

  /*
    THE wesbos SOCIAL-PROOF CASE, at the catalog's own level. `testimonial`
    needs a quote, `testimonial-columns` needs several, `stats` needs numbers,
    and the scrape had none of the three — substitution has nothing to
    substitute to, which is why drop has to exist.
  */
  it("finds nothing in social-proof for a page with no quotes and no numbers", () => {
    expect(
      findContentFittingTemplate({
        category: "social-proof",
        excludedTemplateId: "testimonial",
        params: { headline: "About Wes Bos", body: "Web developer and teacher." },
      }),
    ).toBeUndefined();
  });
});

describe("defineSectionTemplate guards the declaration", () => {
  const trivialParamsSchema = z.strictObject({
    headline: z.string().min(1).default("Sample headline").describe("Headline."),
  });

  it("rejects a requirement naming a param the schema does not have", () => {
    expect(() =>
      defineSectionTemplate({
        id: "bad-requirement",
        name: "Bad",
        category: "content",
        useWhen: "Never used; this template exists only to be rejected at definition time.",
        paramsSchema: trivialParamsSchema,
        contentRequirements: { copyParams: ["subheadline"], listParams: [], imageCount: 0 },
        build: () => {
          throw new Error("unreachable");
        },
      }),
    ).toThrow(/subheadline/);
  });

  /*
    `previewParams` is the gallery's half of the fix: the params that name a
    place carry no default, so the thumbnail needs somewhere to get a button
    and an address line from. That makes it the one place sample values still
    live, and it stays honest only while it can neither name a param that does
    not exist nor quietly restate one the schema already answers.
  */
  it("rejects previewParams naming a param the schema does not have", () => {
    expect(() =>
      defineSectionTemplate({
        id: "bad-preview-param",
        name: "Bad preview",
        category: "content",
        useWhen: "Never used; this template exists only to be rejected at definition time.",
        paramsSchema: trivialParamsSchema,
        contentRequirements: { copyParams: ["headline"], listParams: [], imageCount: 0 },
        previewParams: { subheadline: "Sample subheadline" },
        build: () => {
          throw new Error("unreachable");
        },
      }),
    ).toThrow(/subheadline/);
  });

  it("rejects previewParams restating a param the schema already defaults", () => {
    expect(() =>
      defineSectionTemplate({
        id: "overriding-preview-param",
        name: "Overriding preview",
        category: "content",
        useWhen: "Never used; this template exists only to be rejected at definition time.",
        paramsSchema: trivialParamsSchema,
        contentRequirements: { copyParams: ["headline"], listParams: [], imageCount: 0 },
        previewParams: { headline: "A second, divergent headline" },
        build: () => {
          throw new Error("unreachable");
        },
      }),
    ).toThrow(/already defaults/);
  });

  it("rejects previewParams the template's own schema would not accept", () => {
    expect(() =>
      defineSectionTemplate({
        id: "invalid-preview-param",
        name: "Invalid preview",
        category: "content",
        useWhen: "Never used; this template exists only to be rejected at definition time.",
        paramsSchema: z.strictObject({
          headline: z.string().min(1).default("Sample headline").describe("Headline."),
          ctaHref: z.string().min(1).optional().describe("Destination."),
        }),
        contentRequirements: { copyParams: ["headline"], listParams: [], imageCount: 0 },
        previewParams: { ctaHref: "" },
        build: () => {
          throw new Error("unreachable");
        },
      }),
    ).toThrow(/previewParams its own paramsSchema rejects/);
  });

  it("rejects a template that asks for nothing, since its defaults would always stand in", () => {
    expect(() =>
      defineSectionTemplate({
        id: "empty-requirement",
        name: "Empty",
        category: "content",
        useWhen: "Never used; this template exists only to be rejected at definition time.",
        paramsSchema: trivialParamsSchema,
        contentRequirements: { copyParams: [], listParams: [], imageCount: 0 },
        build: () => {
          throw new Error("unreachable");
        },
      }),
    ).toThrow(/contentRequirements/);
  });
});

/*
  THE INVARIANT THIS CHANGE WORKS AROUND RATHER THAN REMOVES.

  `types.ts` states that every params field carries a sensible default so
  `parse({})` yields a complete, demo-ready section — and the section gallery
  and `scaffoldSection` (adding an empty starter section) both depend on it.
  So the two halves have to hold at once: an empty params object still BUILDS
  a whole section, and still SATISFIES nothing. The first is what the gallery
  needs; the second is what stops that same sample copy reaching a real draft.
*/
describe("the empty-params invariant still holds, in both directions", () => {
  it("builds a complete section from nothing, and satisfies nothing", () => {
    for (const template of SECTION_TEMPLATES) {
      expect(template.paramsSchema.safeParse({}).success).toBe(true);
      const params: unknown = template.paramsSchema.parse({});
      const built = template.build({ params, random: createSeededRandom() });
      expect(built.children.length).toBeGreaterThan(0);
      expect(hasContentForTemplate({ template, params: {} })).toBe(false);
    }
  });

  it("still scaffolds every catalog template from a bare templateId", () => {
    for (const template of SECTION_TEMPLATES) {
      const result = resolveScaffoldSectionOperation({
        doc: createSampleDocument(),
        input: { name: "scaffoldSection", templateId: template.id },
        random: createSeededRandom(),
      });
      expect(result.isOk).toBe(true);
      if (!result.isOk) continue;
      const applied = applyOperation(createSampleDocument(), result.op);
      expect(applied.isOk).toBe(true);
      if (!applied.isOk) continue;
      expect(checkDocumentIntegrity(applied.doc).errors).toEqual([]);
    }
  });
});
