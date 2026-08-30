import { describe, expect, it } from "vitest";
import type { RandomFn } from "../schema/ids";
import { getSectionTemplate } from "./catalog";
import { getModelFacingParamsSchema, type SectionTemplate } from "./types";

/*
  The image-source override on the seven image-bearing templates.

  Two halves, and BOTH are load-bearing:
  - a programmatic caller (the content-ingestion pipeline, which rehosts a
    source image into our own storage) can put a real URL into a section, and
    the absence of one still yields the sized placeholder the catalog has
    always shipped;
  - the MODEL cannot reach the field at all. That is the half a future change
    is most likely to undo by wiring `paramsSchema` straight back into the
    scaffoldSection union, so it is asserted per template here and again
    against the real union in actions/scaffold-section.test.ts.
*/

/*
  Deterministic LCG so ids are reproducible.
*/
function createSeededRandom(seed = 5): RandomFn {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/*
  A URL shaped like what the rehost step hands back — never a placehold.co address.
*/
const REHOSTED_IMAGE_URL = "https://storage.example.com/rehosted/portrait-9f2c.png";

function imageSourcesOf(
  template: SectionTemplate,
  rawParams: Record<string, unknown>,
): string[] {
  const params: unknown = template.paramsSchema.parse(rawParams);
  const built = template.build({ params, random: createSeededRandom() });
  return built.children
    .filter((block) => block.type === "image")
    .map((block) => block.properties.src);
}

function templateOf(templateId: string): SectionTemplate {
  const template = getSectionTemplate(templateId);
  if (template === undefined) {
    throw new Error(`no catalog template "${templateId}"`);
  }
  return template;
}

interface SingleImageTemplateCase {
  templateId: string;
  /*
    Params the template needs before it renders an image at all.
  */
  imageEnablingParams: Record<string, unknown>;
  /*
    The exact placeholder this template has always emitted — dimensions included.
  */
  placeholderSrc: string;
}

const SINGLE_IMAGE_TEMPLATE_CASES: readonly SingleImageTemplateCase[] = [
  { templateId: "hero", imageEnablingParams: {}, placeholderSrc: "https://placehold.co/1200x600.png" },
  {
    templateId: "hero-split",
    imageEnablingParams: {},
    placeholderSrc: "https://placehold.co/600x600.png",
  },
  /*
    article renders its image ONLY when imageAlt is given — an image with no
    alt text is not a thing this catalog emits, so the source override does
    not (and must not) turn the image on by itself.
  */
  {
    templateId: "article",
    imageEnablingParams: { imageAlt: "Portrait of the author at her desk" },
    placeholderSrc: "https://placehold.co/1200x675.png",
  },
  { templateId: "product", imageEnablingParams: {}, placeholderSrc: "https://placehold.co/600x600.png" },
  { templateId: "header", imageEnablingParams: {}, placeholderSrc: "https://placehold.co/280x80.png" },
  {
    templateId: "header-centered",
    imageEnablingParams: {},
    placeholderSrc: "https://placehold.co/280x80.png",
  },
];

describe.each(SINGLE_IMAGE_TEMPLATE_CASES.map((entry) => [entry.templateId, entry] as const))(
  "template %s image source",
  (_templateId, testCase) => {
    it("renders the supplied imageSrc as the image's src", () => {
      const sources = imageSourcesOf(templateOf(testCase.templateId), {
        ...testCase.imageEnablingParams,
        imageSrc: REHOSTED_IMAGE_URL,
      });
      expect(sources).toEqual([REHOSTED_IMAGE_URL]);
    });

    it("falls back to the same sized placeholder when imageSrc is absent", () => {
      const sources = imageSourcesOf(templateOf(testCase.templateId), testCase.imageEnablingParams);
      expect(sources).toEqual([testCase.placeholderSrc]);
    });

    it("keeps imageSrc out of the model-facing schema while paramsSchema accepts it", () => {
      const template = templateOf(testCase.templateId);
      expect(template.paramsSchema.safeParse({ imageSrc: REHOSTED_IMAGE_URL }).success).toBe(true);
      expect(
        getModelFacingParamsSchema(template).safeParse({ imageSrc: REHOSTED_IMAGE_URL }).success,
      ).toBe(false);
    });
  },
);

describe("template image-gallery image sources", () => {
  it("renders each supplied src and placeholders the images that carry none", () => {
    const sources = imageSourcesOf(templateOf("image-gallery"), {
      images: [
        { alt: "Rehosted portrait", src: REHOSTED_IMAGE_URL },
        { alt: "Still a placeholder" },
        { alt: "Second rehosted shot", src: "https://storage.example.com/rehosted/desk-1a44.png" },
      ],
    });
    expect(sources).toEqual([
      REHOSTED_IMAGE_URL,
      "https://placehold.co/600x400.png",
      "https://storage.example.com/rehosted/desk-1a44.png",
    ]);
  });

  it("keeps a supplied src attached to its own image when a link is also present", () => {
    const template = templateOf("image-gallery");
    const params: unknown = template.paramsSchema.parse({
      images: [
        { alt: "Linked and rehosted", src: REHOSTED_IMAGE_URL, href: "https://example.com/look" },
        { alt: "Plain" },
      ],
    });
    const built = template.build({ params, random: createSeededRandom() });
    const images = built.children.filter((block) => block.type === "image");
    expect(images.map((block) => block.properties.src)).toEqual([
      REHOSTED_IMAGE_URL,
      "https://placehold.co/600x400.png",
    ]);
    expect(images.map((block) => block.properties.href)).toEqual([
      "https://example.com/look",
      undefined,
    ]);
  });

  it("keeps images[].src out of the model-facing schema while paramsSchema accepts it", () => {
    const template = templateOf("image-gallery");
    const withSource = { images: [{ alt: "One", src: REHOSTED_IMAGE_URL }, { alt: "Two" }] };
    expect(template.paramsSchema.safeParse(withSource).success).toBe(true);
    expect(getModelFacingParamsSchema(template).safeParse(withSource).success).toBe(false);
    /*
      The rest of a gallery image is untouched: alt and href still validate.
    */
    expect(
      getModelFacingParamsSchema(template).safeParse({
        images: [{ alt: "One", href: "https://example.com" }, { alt: "Two" }],
      }).success,
    ).toBe(true);
  });
});

const IMAGE_BEARING_TEMPLATE_IDS = [
  ...SINGLE_IMAGE_TEMPLATE_CASES.map((entry) => entry.templateId),
  "image-gallery",
];

describe("the image-source override changes nothing about the demo defaults", () => {
  it.each(IMAGE_BEARING_TEMPLATE_IDS)(
    "%s: parse({}) yields exactly what the model-facing schema yields",
    (templateId) => {
      const template = templateOf(templateId);
      /*
        The override is optional and default-less, so the defaulted params
        object is identical either way — which is the precise statement that
        `parse({})` still produces the demo section it always did, without
        pinning every default string in a second place.
      */
      expect(template.paramsSchema.parse({})).toStrictEqual(
        getModelFacingParamsSchema(template).parse({}),
      );
    },
  );
});
