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

const defaultFetchSourceImage: SourceImageFetcher = ({ url, maxBytes }) =>
  fetchBinaryResource({ url, maxBytes });

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
  const rehosted: RehostedSourceImage[] = [];
  let totalBytes = 0;

  for (const sourceImage of sourceImages.slice(
    0,
    MAX_SOURCE_IMAGES_TO_REHOST,
  )) {
    if (totalBytes >= MAX_SOURCE_IMAGE_TOTAL_BYTES) {
      break;
    }
    let fetched: FetchBinaryResult;
    try {
      fetched = await fetchImage({
        url: sourceImage.url,
        maxBytes: MAX_SOURCE_IMAGE_BYTES,
      });
    } catch {
      continue;
    }
    const binary = prepareSourceImageBinary(fetched);
    if (
      binary === null ||
      totalBytes + binary.bytes.byteLength > MAX_SOURCE_IMAGE_TOTAL_BYTES
    ) {
      continue;
    }
    totalBytes += binary.bytes.byteLength;
    try {
      const url = await rehost({ sourceImage, binary });
      if (url !== null && url.trim().length > 0) {
        rehosted.push({ sourceImage, url });
      }
    } catch {
      /* A storage failure should not discard successfully fetched siblings. */
    }
  }

  return rehosted;
}
