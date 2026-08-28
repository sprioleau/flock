import { z } from "zod";
import { createSectionComposer, paragraphNode, textDocOf, textRun } from "../build-helpers";
import { defineSectionTemplate } from "../types";

/**
 * `testimonial-columns` — two or three short customer quotes side by side,
 * each with its attribution. The multi-voice sibling of `testimonial`.
 * Reference: react.email/components testimonial grid patterns.
 */

const testimonialItemSchema = z
  .strictObject({
    quote: z
      .string()
      .min(1)
      .describe("One SHORT customer quote (a sentence or two), without surrounding quotation marks."),
    attribution: z.string().min(1).describe("Who said it — the person's name."),
    role: z
      .string()
      .min(1)
      .optional()
      .describe('Optional role/company line shown after the name (like "Head of Lifecycle, Northwind").'),
  })
  .describe("One testimonial: a short quote and who said it.");

export const testimonialColumnsParamsSchema = z
  .strictObject({
    testimonials: z
      .array(testimonialItemSchema)
      .min(2)
      .max(3)
      .default([
        {
          quote: "Our whole newsletter now ships in an afternoon.",
          attribution: "Priya Raman",
          role: "Growth, Fieldnotes",
        },
        {
          quote: "The first email tool our designers actually like.",
          attribution: "Marcus Webb",
          role: "Brand Lead, Halide",
        },
      ])
      .describe("2–3 short testimonials, one column each, left to right."),
  })
  .describe("Testimonial-columns content: 2–3 short quotes with attributions.");

export const testimonialColumnsTemplate = defineSectionTemplate({
  id: "testimonial-columns",
  // Display name deliberately short (owner 2026-07-31): two-line tile labels
  // broke the gallery grid's height alignment. The id stays testimonial-columns.
  name: "Testimonials",
  category: "social-proof",
  useWhen: "Stack up social proof with two or three short customer quotes side by side.",
  paramsSchema: testimonialColumnsParamsSchema,
  /*
    Same harm as `testimonial`, multiplied — every column carries a name.
  */
  contentRequirements: {
    copyParams: [],
    listParams: [{ param: "testimonials", minimumCount: 2 }],
    imageCount: 0,
  },
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    composer.addColumns(
      params.testimonials.map((testimonial) => ({
        leaves: [
          {
            kind: "text" as const,
            text: textDocOf([
              paragraphNode([textRun(`“${testimonial.quote}”`, [{ type: "italic" }])]),
              paragraphNode([
                textRun(testimonial.attribution, [{ type: "bold" }]),
                ...(testimonial.role !== undefined ? [textRun(` — ${testimonial.role}`)] : []),
              ]),
            ]),
            textAlign: "center" as const,
          },
        ],
      })),
    );
    return composer.finish();
  },
});
