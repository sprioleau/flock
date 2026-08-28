import { z } from "zod";
import {
  createSectionComposer,
  headingNode,
  imageSrcParamSchema,
  paragraphNode,
  resolveImageSrc,
  textDocOf,
  textRun,
} from "../build-helpers";
import { defineSectionTemplate } from "../types";

/**
 * `product` — one product for sale: photo on the left; name, one-line
 * description, price, and a buy button on the right (45/55, middle-aligned).
 * Reference: react.email/components ecommerce "one-product" card patterns.
 */

export const productParamsSchema = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .default("The Everyday Tote")
      .describe("The product's name — rendered as a level-2 heading."),
    description: z
      .string()
      .min(1)
      .default("Water-resistant canvas, an easy-access laptop sleeve, and room for the whole day.")
      .describe("One or two sentences selling the product."),
    price: z
      .string()
      .min(1)
      .default("$48")
      .describe('The price as display text (currency included, like "$48" or "€39.90").'),
    imageAlt: z
      .string()
      .min(1)
      .default("Product photo")
      .describe("Alt text describing the product photo (required for accessibility)."),
    imageSrc: imageSrcParamSchema,
    ctaLabel: z
      .string()
      .min(1)
      .default("Shop now")
      .describe("The buy button's visible label (plain text)."),
    ctaHref: z
      .string()
      .min(1)
      .default("https://example.com/shop")
      .describe("The buy button's destination: an absolute URL to the product page."),
  })
  .describe("Product content: name, description, display price, photo alt text, and the buy button.");

export const productTemplate = defineSectionTemplate({
  id: "product",
  name: "Product card",
  category: "content",
  useWhen:
    "Feature one product for sale: its photo beside the name, a one-line description, the price, and a buy button.",
  paramsSchema: productParamsSchema,
  /*
    A product's name, description and price are claims about a real thing for sale; inventing any of them is the same harm as inventing a quote.
  */
  contentRequirements: {
    copyParams: ["name", "description", "price"],
    listParams: [],
    imageCount: 1,
  },
  /*
    imageSrc is for programmatic callers only (a rehosted image URL from the
    content-ingestion pipeline) — never for the model.
  */
  modelFacingParamsSchema: productParamsSchema.omit({ imageSrc: true }),
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    composer.addColumns([
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
      {
        widthPercent: 55,
        verticalAlign: "middle",
        leaves: [
          {
            kind: "text",
            text: textDocOf([
              headingNode({ level: 2, content: params.name }),
              paragraphNode(params.description),
              paragraphNode([textRun(params.price, [{ type: "bold" }])]),
            ]),
          },
          { kind: "button", label: params.ctaLabel, href: params.ctaHref, align: "left" },
        ],
      },
    ]);
    return composer.finish();
  },
});
