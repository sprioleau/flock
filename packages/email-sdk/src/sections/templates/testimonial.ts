import { z } from "zod";
import { createSectionComposer, paragraphNode, textDocOf, textRun } from "../build-helpers";
import { defineSectionTemplate } from "../types";

/**
 * `testimonial` — one customer quote with its attribution, centered.
 * Reference: react.email/components "testimonial-simple-centered".
 */

export const testimonialParamsSchema = z
  .strictObject({
    quote: z
      .string()
      .min(1)
      .default(
        "Flock has completely changed how our team ships email. What used to take a day now takes minutes.",
      )
      .describe("The customer's quote, without surrounding quotation marks (they are added for you)."),
    attribution: z
      .string()
      .min(1)
      .default("Jordan Lee")
      .describe("Who said it — the person's name."),
    role: z
      .string()
      .min(1)
      .optional()
      .describe('Optional role/company line shown after the name (e.g. "Head of Lifecycle, Northwind").'),
  })
  .describe("Testimonial content: the quote and who said it.");

export const testimonialTemplate = defineSectionTemplate({
  id: "testimonial",
  name: "Testimonial",
  category: "social-proof",
  useWhen: "Add social proof with one customer quote and its attribution.",
  paramsSchema: testimonialParamsSchema,
  /*
    THE MOTIVATING INCIDENT. A quote and a name are an endorsement by a specific person; defaulted, they are an endorsement by a person who does not exist.
  */
  contentRequirements: {
    copyParams: ["quote", "attribution"],
    listParams: [],
    imageCount: 0,
  },
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    composer.addLeaf({
      kind: "text",
      text: textDocOf([
        paragraphNode([textRun(`“${params.quote}”`, [{ type: "italic" }])]),
        paragraphNode([
          textRun(params.attribution, [{ type: "bold" }]),
          ...(params.role !== undefined ? [textRun(` — ${params.role}`)] : []),
        ]),
      ]),
      textAlign: "center",
    });
    return composer.finish();
  },
});
