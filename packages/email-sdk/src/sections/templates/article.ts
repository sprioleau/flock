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

/*
  `article` — one editorial story: heading, rich paragraph, optional image.
  Reference: react.email/components "article-with-image" and the text-only
  article patterns.
*/

export const articleParamsSchema = z
  .strictObject({
    headline: z
      .string()
      .min(1)
      .default("A note from the team")
      .describe("The article's heading — rendered as a level-2 heading."),
    body: z
      .string()
      .min(1)
      .default(
        "We have been heads-down on the details this month: sharper defaults, gentler onboarding, and dozens of fixes you will feel rather than see. Here is what changed and why it matters for your next send.",
      )
      .describe("The article's paragraph copy (a few sentences)."),
    imageAlt: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Alt text for an optional supporting image shown above the heading. Omit for a text-only article.",
      ),
    imageSrc: imageSrcParamSchema,
  })
  .describe("Article content: heading, body paragraph, and an optional supporting image.");

export const articleTemplate = defineSectionTemplate({
  id: "article",
  name: "Article",
  category: "content",
  useWhen:
    "Tell one story in editorial form: a heading and a rich paragraph, with an optional supporting image.",
  paramsSchema: articleParamsSchema,
  /*
    Heading plus paragraph is the whole article. The supporting image is optional, so a default-params build shows none.
  */
  contentRequirements: {
    copyParams: ["headline", "body"],
    listParams: [],
    imageCount: 0,
  },
  /*
    imageSrc is for programmatic callers only (a rehosted image URL from the
    content-ingestion pipeline) — never for the model.
  */
  modelFacingParamsSchema: articleParamsSchema.omit({ imageSrc: true }),
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    if (params.imageAlt !== undefined) {
      composer.addLeaf({
        kind: "image",
        src: resolveImageSrc({ src: params.imageSrc, width: 1200, height: 675 }),
        alt: params.imageAlt,
      });
    }
    composer.addLeaf({
      kind: "text",
      text: textDocOf([
        headingNode({ level: 2, content: params.headline }),
        paragraphNode(params.body),
      ]),
    });
    return composer.finish();
  },
});
