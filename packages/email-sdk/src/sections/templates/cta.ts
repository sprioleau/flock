import { z } from "zod";
import { createSectionComposer, headingNode, paragraphNode, textDocOf } from "../build-helpers";
import { defineSectionTemplate } from "../types";

/*
  `cta` — a focused call-to-action banner: short headline, optional
  supporting line, and ONE button, all centered, with a spacer giving the
  button air. Reference: react.email/components marketing/CTA patterns.
  (This also covers the "text-only hero" shape — one centered ask — so the
  catalog carries a single template for it rather than two look-alikes.)
*/

export const ctaParamsSchema = z
  .strictObject({
    headline: z
      .string()
      .min(1)
      .default("Ready when you are")
      .describe("The banner's short headline — rendered as a level-2 heading."),
    body: z
      .string()
      .min(1)
      .optional()
      .describe("Optional supporting line under the headline. Omit for headline + button only."),
    ctaLabel: z
      .string()
      .min(1)
      .default("Start your free trial")
      .describe("The call-to-action button's visible label (plain text)."),
    ctaHref: z
      .string()
      .min(1)
      .default("https://example.com")
      .describe("The call-to-action button's destination: an absolute URL, mailto:, or merge tag."),
  })
  .describe("Call-to-action content: headline, optional supporting line, and one button.");

export const ctaTemplate = defineSectionTemplate({
  id: "cta",
  name: "Call to action",
  category: "content",
  useWhen:
    "Drive one action anywhere in the email with a centered banner: a short headline, an optional supporting line, and a single button.",
  paramsSchema: ctaParamsSchema,
  /*
    Unlike a hero, this section is nothing BUT its ask — a banner whose button points at the sample URL drives the reader nowhere.
  */
  contentRequirements: {
    copyParams: ["headline", "ctaLabel", "ctaHref"],
    listParams: [],
    imageCount: 0,
  },
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    composer.addLeaf({
      kind: "text",
      text: textDocOf([
        headingNode({ level: 2, content: params.headline }),
        ...(params.body !== undefined ? [paragraphNode(params.body)] : []),
      ]),
      textAlign: "center",
    });
    composer.addLeaf({ kind: "spacer", height: 8 });
    composer.addLeaf({ kind: "button", label: params.ctaLabel, href: params.ctaHref, align: "center" });
    return composer.finish();
  },
});
