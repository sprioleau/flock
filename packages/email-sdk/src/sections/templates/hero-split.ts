import { z } from "zod";
import {
  createSectionComposer,
  headingNode,
  imageSrcParamSchema,
  paragraphNode,
  resolveImageSrc,
  textDocOf,
  type LeafSpec,
} from "../build-helpers";
import { defineSectionTemplate } from "../types";

/*
  `hero-split` — side-by-side hero: headline, supporting line, and CTA on the
  left; image on the right (55/45, middle-aligned). Reference:
  react.email/components split title-card / feature patterns.
*/

export const heroSplitParamsSchema = z
  .strictObject({
    headline: z
      .string()
      .min(1)
      .default("Ship email your whole team loves")
      .describe("The hero's main headline — rendered as a level-1 heading."),
    body: z
      .string()
      .min(1)
      .default(
        "Design once, stay on brand everywhere: prebuilt sections, live previews, and themes that restyle everything in one click.",
      )
      .describe("One or two supporting sentences under the headline."),
    imageAlt: z
      .string()
      .min(1)
      .default("Product preview")
      .describe("Alt text describing the hero image (required for accessibility)."),
    imageSrc: imageSrcParamSchema,
    ctaLabel: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The call-to-action button's visible label (plain text). Omit, with ctaHref, for a hero with no button.",
      ),
    ctaHref: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The call-to-action button's destination: an absolute URL, mailto:, or merge tag. Give a real one or omit it — there is no default, so a hero you leave without a destination simply has no button.",
      ),
  })
  .describe("Split-hero content: headline, supporting copy, image alt text, and one CTA.");

export const heroSplitTemplate = defineSectionTemplate({
  id: "hero-split",
  name: "Split hero",
  category: "hero",
  useWhen:
    "Lead with a side-by-side hero: headline, supporting line, and CTA button on the left, an image on the right.",
  paramsSchema: heroSplitParamsSchema,
  /*
    Identical substance to `hero` — the two heroes take the same params, so a hero that cannot be filled has no substitute and is dropped.
  */
  contentRequirements: {
    copyParams: ["headline", "body"],
    listParams: [],
    imageCount: 1,
  },
  /*
    As `hero`: the gallery shows the button, a real draft earns it.
  */
  previewParams: { ctaLabel: "Get started", ctaHref: "https://example.com" },
  /*
    imageSrc is for programmatic callers only (a rehosted image URL from the
    content-ingestion pipeline) — never for the model.
  */
  modelFacingParamsSchema: heroSplitParamsSchema.omit({ imageSrc: true }),
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    /*
      No button rather than an invented one: a label with nowhere to go, or a
      destination with nothing to click, is a dead button in a sent email.
    */
    const ctaLeaves: LeafSpec[] =
      params.ctaLabel !== undefined && params.ctaHref !== undefined
        ? [{ kind: "button", label: params.ctaLabel, href: params.ctaHref, align: "left" }]
        : [];
    composer.addColumns([
      {
        widthPercent: 55,
        verticalAlign: "middle",
        leaves: [
          {
            kind: "text",
            text: textDocOf([
              headingNode({ level: 1, content: params.headline }),
              paragraphNode(params.body),
            ]),
          },
          ...ctaLeaves,
        ],
      },
      {
        widthPercent: 45,
        verticalAlign: "middle",
        leaves: [
          {
            kind: "image",
            src: resolveImageSrc({ src: params.imageSrc, width: 600, height: 600 }),
            alt: params.imageAlt,
          },
        ],
      },
    ]);
    return composer.finish();
  },
});
