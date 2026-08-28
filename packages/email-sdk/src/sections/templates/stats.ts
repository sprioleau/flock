import { z } from "zod";
import { createSectionComposer, headingNode, paragraphNode, textDocOf } from "../build-helpers";
import { defineSectionTemplate } from "../types";

/**
 * `stats` — 2–4 headline numbers side by side, each with a short label.
 * Reference: react.email/components stats patterns.
 */

const statSchema = z
  .strictObject({
    value: z
      .string()
      .min(1)
      .describe('The headline number, as display text (e.g. "12k+", "98%", "4.9★").'),
    label: z.string().min(1).describe("A short label saying what the number measures."),
  })
  .describe("One stat: a display value and its label.");

export const statsParamsSchema = z
  .strictObject({
    headline: z
      .string()
      .min(1)
      .optional()
      .describe("Optional intro heading shown above the stats row. Omit for numbers only."),
    stats: z
      .array(statSchema)
      .min(2)
      .max(4)
      .default([
        { value: "12k+", label: "teams on board" },
        { value: "98%", label: "delivery rate" },
        { value: "4.9/5", label: "average rating" },
      ])
      .describe("2–4 stats, one column each, left to right."),
  })
  .describe("Stats content: an optional intro heading and 2–4 value/label pairs.");

export const statsTemplate = defineSectionTemplate({
  id: "stats",
  name: "Stats",
  category: "social-proof",
  useWhen: "Make impact concrete with 2–4 headline numbers, each with a short label.",
  paramsSchema: statsParamsSchema,
  /*
    The numbers are the claim. An invented `98%` reads exactly as measured as a real one.
  */
  contentRequirements: {
    copyParams: [],
    listParams: [{ param: "stats", minimumCount: 2 }],
    imageCount: 0,
  },
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    if (params.headline !== undefined) {
      composer.addLeaf({
        kind: "text",
        text: textDocOf([headingNode({ level: 2, content: params.headline })]),
        textAlign: "center",
      });
    }
    composer.addColumns(
      params.stats.map((stat) => ({
        leaves: [
          {
            kind: "text" as const,
            text: textDocOf([
              headingNode({ level: 2, content: stat.value }),
              paragraphNode(stat.label),
            ]),
            textAlign: "center" as const,
          },
        ],
      })),
    );
    return composer.finish();
  },
});
