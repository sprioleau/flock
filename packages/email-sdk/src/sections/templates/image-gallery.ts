import { z } from "zod";
import { createSectionComposer, placeholderImageUrl, type LeafSpec } from "../build-helpers";
import { defineSectionTemplate } from "../types";

/**
 * `image-gallery` — 2–6 images in a tidy grid of column rows. Reference:
 * react.email/components "four-images-in-a-grid" / "images-on-horizontal-grid".
 *
 * Row shape follows the image count: 2 and 4 images use rows of two (2, 2+2);
 * everything else uses rows of up to three (3, 3+2, 3+3).
 */

const galleryImageSchema = z
  .strictObject({
    alt: z.string().min(1).describe("Alt text describing this image (required for accessibility)."),
    href: z
      .string()
      .min(1)
      .optional()
      .describe("Optional absolute URL the image links to. Omit for a non-clickable image."),
  })
  .describe("One gallery image: alt text and an optional link.");

export const imageGalleryParamsSchema = z
  .strictObject({
    images: z
      .array(galleryImageSchema)
      .min(2)
      .max(6)
      .default([
        { alt: "Workspace with the new editor open" },
        { alt: "Close-up of the section catalog" },
        { alt: "Finished email on a phone screen" },
      ])
      .describe("2–6 images, laid out left to right, top to bottom."),
  })
  .describe("Image-gallery content: the images' alt texts and optional links.");

/** 2 or 4 images → rows of two; otherwise rows of up to three. */
export function chunkGalleryImages<T>(images: readonly T[]): T[][] {
  const rowSize = images.length === 2 || images.length === 4 ? 2 : 3;
  const rows: T[][] = [];
  for (let start = 0; start < images.length; start += rowSize) {
    rows.push(images.slice(start, start + rowSize));
  }
  return rows;
}

export const imageGalleryTemplate = defineSectionTemplate({
  id: "image-gallery",
  name: "Image gallery",
  category: "content",
  useWhen: "Show a set of 2–6 images in a tidy grid — product shots, lookbooks, event photos.",
  paramsSchema: imageGalleryParamsSchema,
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    for (const row of chunkGalleryImages(params.images)) {
      composer.addColumns(
        row.map((image) => ({
          leaves: [
            {
              kind: "image",
              src: placeholderImageUrl({ width: 600, height: 400 }),
              alt: image.alt,
              ...(image.href !== undefined ? { href: image.href } : {}),
            } satisfies LeafSpec,
          ],
        })),
      );
    }
    return composer.finish();
  },
});
