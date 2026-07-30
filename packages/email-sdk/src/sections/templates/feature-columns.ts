import { z } from "zod";
import { createSectionComposer, headingNode, paragraphNode, textDocOf } from "../build-helpers";
import { defineSectionTemplate } from "../types";

/**
 * `feature-columns` — 2–4 short selling points side by side (column count
 * follows the number of features given). Reference: react.email/components
 * "one-row-two-columns" / "one-row-three-columns".
 */

const featureSchema = z
  .strictObject({
    title: z.string().min(1).describe("The feature's short title (a few words)."),
    body: z.string().min(1).describe("One sentence describing the feature."),
  })
  .describe("One feature: title and one-line description.");

export const featureColumnsParamsSchema = z
  .strictObject({
    headline: z
      .string()
      .min(1)
      .optional()
      .describe("Optional intro heading shown above the feature columns. Omit for columns only."),
    features: z
      .array(featureSchema)
      .min(2)
      .max(4)
      .default([
        { title: "Fast", body: "Set up in minutes — no code required." },
        { title: "Flexible", body: "Compose prebuilt sections to fit any campaign." },
        { title: "On brand", body: "Everything inherits your theme automatically." },
      ])
      .describe("2–4 features, one column each, left to right."),
  })
  .describe("Feature-columns content: an optional intro heading and 2–4 features.");

export const featureColumnsTemplate = defineSectionTemplate({
  id: "feature-columns",
  name: "Feature columns",
  category: "content",
  useWhen: "Present 2–4 short selling points side by side, each with a title and a one-liner.",
  paramsSchema: featureColumnsParamsSchema,
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
      params.features.map((feature) => ({
        leaves: [
          {
            kind: "text" as const,
            text: textDocOf([
              headingNode({ level: 3, content: feature.title }),
              paragraphNode(feature.body),
            ]),
            textAlign: "center" as const,
          },
        ],
      })),
    );
    return composer.finish();
  },
});
