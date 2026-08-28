import { z } from "zod";
import {
  createSectionComposer,
  headingNode,
  imageSrcParamSchema,
  paragraphNode,
  resolveImageSrc,
  textDocOf,
} from "../build-helpers";
import { defineSectionTemplate } from "../types";

/**
 * `hero` — one big idea above the fold: full-width image ABOVE a headline,
 * supporting line, and a single CTA button (owner decision: image-above-text,
 * no background images). Reference: react.email/components "one-product" /
 * title-cards patterns.
 */

export const heroParamsSchema = z
  .strictObject({
    headline: z
      .string()
      .min(1)
      .default("Meet the new release")
      .describe("The hero's main headline — rendered as a level-1 heading."),
    body: z
      .string()
      .min(1)
      .default(
        "Everything you asked for, in one update: faster setup, smarter defaults, and a cleaner editing canvas.",
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
  .describe("Hero content: headline, supporting copy, image alt text, and one CTA.");

export const heroTemplate = defineSectionTemplate({
  id: "hero",
  name: "Hero",
  category: "hero",
  useWhen:
    "Lead the email with one big idea: a full-width image above a headline, a supporting line, and a single CTA button.",
  paramsSchema: heroParamsSchema,
  /*
    The hero IS its headline and supporting line. The CTA is furniture and the image source is the pipeline's to supply.
  */
  contentRequirements: {
    copyParams: ["headline", "body"],
    listParams: [],
    imageCount: 1,
  },
  /*
    The gallery shows the button this template is partly about; a real hero
    only gets one when the caller names where it goes.
  */
  previewParams: { ctaLabel: "Get started", ctaHref: "https://example.com" },
  /*
    imageSrc is for programmatic callers only (a rehosted image URL from the
    content-ingestion pipeline) — never for the model.
  */
  modelFacingParamsSchema: heroParamsSchema.omit({ imageSrc: true }),
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    composer.addLeaf({
      kind: "image",
      src: resolveImageSrc({ src: params.imageSrc, width: 1200, height: 600 }),
      alt: params.imageAlt,
    });
    composer.addLeaf({
      kind: "text",
      text: textDocOf([
        headingNode({ level: 1, content: params.headline }),
        paragraphNode(params.body),
      ]),
      textAlign: "center",
    });
    /*
      No button rather than an invented one: a label with nowhere to go, or a
      destination with nothing to click, is a dead button in a sent email.
    */
    if (params.ctaLabel !== undefined && params.ctaHref !== undefined) {
      composer.addLeaf({
        kind: "button",
        label: params.ctaLabel,
        href: params.ctaHref,
        align: "center",
      });
    }
    return composer.finish();
  },
});
