import { mapWithConcurrency } from "./map-with-concurrency";
import type { BrandSourceImage } from "@/lib/brand-kit";
import {
  normalizeImageContentType,
  prepareSvgBinary,
  type AssetBinary,
} from "./confirm-asset";
import { fetchBinaryResource, type FetchBinaryResult } from "./fetch-page";

/*
  Source-image downloads are evidence for a brand kit, not an unrestricted
  media importer. Keep the same five-image selection and multimodal byte
  budgets that the scrape already uses, while applying the stricter asset
  allowlist and SVG safety checks before anything reaches storage.
*/
export const MAX_SOURCE_IMAGES_TO_REHOST = 5;
export const MAX_SOURCE_IMAGE_BYTES = 750_000;
export const MAX_SOURCE_IMAGE_TOTAL_BYTES = 2_500_000;
const MAX_SOURCE_IMAGE_CONCURRENCY = 3;

export interface RehostedSourceImage {
  sourceImage: BrandSourceImage;
  url: string;
}

export type SourceImageFetcher = (args: {
  url: string;
  maxBytes: number;
}) => Promise<FetchBinaryResult>;

export type SourceImageRehoster = (args: {
  sourceImage: BrandSourceImage;
  binary: AssetBinary;
}) => Promise<string | null>;

function defaultFetchSourceImage({ url, maxBytes }: Parameters<SourceImageFetcher>[0]): Promise<FetchBinaryResult> {
  return fetchBinaryResource({ url, maxBytes });
}

/*
  Validate one fetched source image and normalize SVG bytes through the shared
  sanitizer. Returning null is intentional: a single bad image must not make
  the rest of an otherwise useful brand kit disappear.
*/
function prepareSourceImageBinary(
  result: FetchBinaryResult,
): AssetBinary | null {
  if (!result.isOk || result.bytes.byteLength > MAX_SOURCE_IMAGE_BYTES) {
    return null;
  }
  const contentType = normalizeImageContentType(result.contentType);
  if (contentType === null) {
    return null;
  }
  if (contentType === "image/svg+xml") {
    const prepared = prepareSvgBinary(
      new TextDecoder("utf-8").decode(result.bytes),
    );
    if (
      !prepared.isOk ||
      prepared.binary.bytes.byteLength > MAX_SOURCE_IMAGE_BYTES
    ) {
      return null;
    }
    return prepared.binary;
  }
  return { bytes: result.bytes, contentType };
}


/*
  Fetch and rehost selected source-page images. The caller owns the upload and
  registration seam so this helper remains usable by the HTTP scrape route
  and fully testable without a Convex client. Failures are soft and preserve
  the original selection order.
*/
export async function rehostSourceImages({
  sourceImages,
  fetchImage = defaultFetchSourceImage,
  rehost,
}: {
  sourceImages: readonly BrandSourceImage[];
  fetchImage?: SourceImageFetcher;
  rehost: SourceImageRehoster;
}): Promise<RehostedSourceImage[]> {
  const selectedImages = sourceImages.slice(0, MAX_SOURCE_IMAGES_TO_REHOST);
  const fetchedResults = await mapWithConcurrency({
    items: selectedImages,
    concurrency: MAX_SOURCE_IMAGE_CONCURRENCY,
    mapItem: async (sourceImage) => {
      try {
        return await fetchImage({
          url: sourceImage.url,
          maxBytes: MAX_SOURCE_IMAGE_BYTES,
        });
      } catch {
        return null;
      }
    },
  });

  const eligibleImages: Array<{ sourceImage: BrandSourceImage; binary: AssetBinary }> = [];
  let totalBytes = 0;

  for (const [index, sourceImage] of selectedImages.entries()) {
    if (totalBytes >= MAX_SOURCE_IMAGE_TOTAL_BYTES) {
      break;
    }
    const fetched = fetchedResults[index];
    if (fetched === null) continue;
    const binary = prepareSourceImageBinary(fetched);
    if (
      binary === null ||
      totalBytes + binary.bytes.byteLength > MAX_SOURCE_IMAGE_TOTAL_BYTES
    ) {
      continue;
    }
    totalBytes += binary.bytes.byteLength;
    eligibleImages.push({ sourceImage, binary });
  }

  const uploadResults = await mapWithConcurrency({
    items: eligibleImages,
    concurrency: MAX_SOURCE_IMAGE_CONCURRENCY,
    mapItem: async ({ sourceImage, binary }) => {
      try {
        const url = await rehost({ sourceImage, binary });
        return url !== null && url.trim().length > 0
          ? { sourceImage, url }
          : null;
      } catch {
        /* A storage failure should not discard successfully fetched siblings. */
        return null;
      }
    },
  });

  return uploadResults.filter(
    (result): result is RehostedSourceImage => result !== null,
  );
}
