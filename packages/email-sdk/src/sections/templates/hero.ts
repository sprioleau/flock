import { z } from "zod";
import {
  createSectionComposer,
  headingNode,
  paragraphNode,
  placeholderImageUrl,
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
    ctaLabel: z
      .string()
      .min(1)
      .default("Get started")
      .describe("The call-to-action button's visible label (plain text)."),
    ctaHref: z
      .string()
      .min(1)
      .default("https://example.com")
      .describe("The call-to-action button's destination: an absolute URL, mailto:, or merge tag."),
  })
  .describe("Hero content: headline, supporting copy, image alt text, and one CTA.");

export const heroTemplate = defineSectionTemplate({
  id: "hero",
  name: "Hero",
  category: "hero",
  useWhen:
    "Lead the email with one big idea: a full-width image above a headline, a supporting line, and a single CTA button.",
  paramsSchema: heroParamsSchema,
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    composer.addLeaf({
      kind: "image",
      src: placeholderImageUrl({ width: 1200, height: 600 }),
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
    composer.addLeaf({
      kind: "button",
      label: params.ctaLabel,
      href: params.ctaHref,
      align: "center",
    });
    return composer.finish();
  },
});
