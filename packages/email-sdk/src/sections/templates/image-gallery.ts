import { z } from "zod";
import {
  createSectionComposer,
  imageSrcParamSchema,
  resolveImageSrc,
  type LeafSpec,
} from "../build-helpers";
import { defineSectionTemplate } from "../types";

/**
 * `image-gallery` — 2–6 images in a tidy grid of column rows. Reference:
 * react.email/components "four-images-in-a-grid" / "images-on-horizontal-grid".
 *
 * Row shape follows the image count: 2 and 4 images use rows of two (2, 2+2);
 * everything else uses rows of up to three (3, 3+2, 3+3).
 */

/*
  A gallery image is a LIST item, so the image-source override cannot be
  dropped with `.omit()` the way the single-image templates drop theirs. The
  element schema is therefore declared in both widths, and the array's own
  constraints, default, and prose are shared constants so the two cannot
  drift apart.
*/
const modelFacingGalleryImageSchema = z
  .strictObject({
    alt: z.string().min(1).describe("Alt text describing this image (required for accessibility)."),
    href: z
      .string()
      .min(1)
      .optional()
      .describe("Optional absolute URL the image links to. Omit for a non-clickable image."),
  })
  .describe("One gallery image: alt text and an optional link.");

const galleryImageSchema = modelFacingGalleryImageSchema.extend({
  src: imageSrcParamSchema,
});

const DEFAULT_GALLERY_IMAGES = [
  { alt: "Workspace with the new editor open" },
  { alt: "Close-up of the section catalog" },
  { alt: "Finished email on a phone screen" },
];

const GALLERY_IMAGES_DESCRIPTION = "2–6 images, laid out left to right, top to bottom.";

const IMAGE_GALLERY_PARAMS_DESCRIPTION =
  "Image-gallery content: the images' alt texts and optional links.";

export const imageGalleryParamsSchema = z
  .strictObject({
    images: z
      .array(galleryImageSchema)
      .min(2)
      .max(6)
      .default(DEFAULT_GALLERY_IMAGES)
      .describe(GALLERY_IMAGES_DESCRIPTION),
  })
  .describe(IMAGE_GALLERY_PARAMS_DESCRIPTION);

const imageGalleryModelFacingParamsSchema = z
  .strictObject({
    images: z
      .array(modelFacingGalleryImageSchema)
      .min(2)
      .max(6)
      .default(DEFAULT_GALLERY_IMAGES)
      .describe(GALLERY_IMAGES_DESCRIPTION),
  })
  .describe(IMAGE_GALLERY_PARAMS_DESCRIPTION);

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
  /*
    Each image's alt text is the copy the caller must write; the grid needs at least two of them.
  */
  contentRequirements: {
    copyParams: [],
    listParams: [{ param: "images", minimumCount: 2 }],
    imageCount: 2,
  },
  /*
    images[].src is for programmatic callers only (rehosted image URLs from
    the content-ingestion pipeline) — never for the model.
  */
  modelFacingParamsSchema: imageGalleryModelFacingParamsSchema,
  build: ({ params, random }) => {
    const composer = createSectionComposer(random);
    for (const row of chunkGalleryImages(params.images)) {
      composer.addColumns(
        row.map((image) => ({
          leaves: [
            {
              kind: "image",
              src: resolveImageSrc({ src: image.src, width: 600, height: 400 }),
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
