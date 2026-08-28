import { z } from "zod";
import { createSectionComposer, headingNode, paragraphNode, textDocOf } from "../build-helpers";
import { defineSectionTemplate } from "../types";

/**
 * `feature-list` — 2–5 features stacked vertically, each a title plus a short
 * description, separated by dividers. The scannable, mobile-friendly sibling
 * of `feature-columns`. Reference: react.email/components feature-list
 * patterns ("features-with-lists").
 */

const featureSchema = z
  .strictObject({
    title: z.string().min(1).describe("The feature's short title (a few words)."),
    body: z.string().min(1).describe("One or two sentences describing the feature."),
  })
  .describe("One feature: title and short description.");

export const featureListParamsSchema = z
  .strictObject({
    headline: z
      .string()
      .min(1)
      .optional()
      .describe("Optional intro heading shown above the list. Omit for the list only."),
    features: z
      .array(featureSchema)
      .min(2)
      .max(5)
      .default([
        { title: "Drag, drop, done", body: "Compose from prebuilt sections and rearrange them in seconds." },
        { title: "Always on brand", body: "Every block inherits your theme — swap palettes without touching a single section." },
        { title: "Preview everywhere", body: "See exactly what lands in the inbox, on desktop and phone alike." },
      ])
      .describe("2–5 features, listed top to bottom."),
  })
  .describe("Feature-list content: an optional intro heading and 2–5 stacked features.");

export const featureListTemplate = defineSectionTemplate({
  id: "feature-list",
  name: "Feature list",
  category: "content",
  useWhen:
    "Walk through 2–5 features one after another in a stacked, scannable list — each a title over a short description.",
  paramsSchema: featureListParamsSchema,
  /*
    Same substance as `feature-columns`: the list is the content.
  */
  contentRequirements: {
    copyParams: [],
    listParams: [{ param: "features", minimumCount: 2 }],
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
    params.features.forEach((feature, index) => {
      if (index > 0) {
        composer.addLeaf({ kind: "divider" });
      }
      composer.addLeaf({
        kind: "text",
        text: textDocOf([
          headingNode({ level: 3, content: feature.title }),
          paragraphNode(feature.body),
        ]),
      });
    });
    return composer.finish();
  },
});
