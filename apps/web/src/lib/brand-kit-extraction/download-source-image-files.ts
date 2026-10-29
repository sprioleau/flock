import { mapWithConcurrency } from "./map-with-concurrency";
import type { BrandSourceImage } from "@/lib/brand-kit";
import {
  fetchBinaryResource,
  type FetchBinaryResult,
} from "./fetch-page";

const MAX_BRAND_SOURCE_IMAGES = 5;
const MAX_BRAND_SOURCE_IMAGE_BYTES = 750_000;
const MAX_BRAND_SOURCE_IMAGE_TOTAL_BYTES = 2_500_000;
const MAX_BRAND_SOURCE_IMAGE_CONCURRENCY = 3;

export interface SourceImageFile {
  type: "file";
  mediaType: string;
  data: Uint8Array;
}

export type BrandSourceImageFetcher = (args: {
  url: string;
  maxBytes: number;
}) => Promise<FetchBinaryResult>;

function defaultFetchImage({
  url,
  maxBytes,
}: {
  url: string;
  maxBytes: number;
}): Promise<FetchBinaryResult> {
  return fetchBinaryResource({ url, maxBytes });
}


export async function downloadSourceImageFiles({
  sourceImages,
  fetchImage = defaultFetchImage,
}: {
  sourceImages: readonly BrandSourceImage[];
  fetchImage?: BrandSourceImageFetcher;
}): Promise<SourceImageFile[]> {
  const selectedImages = sourceImages.slice(0, MAX_BRAND_SOURCE_IMAGES);
  const downloadedResults = await mapWithConcurrency({
    items: selectedImages,
    concurrency: MAX_BRAND_SOURCE_IMAGE_CONCURRENCY,
    mapItem: async (sourceImage) => {
      try {
        return await fetchImage({
          url: sourceImage.url,
          maxBytes: MAX_BRAND_SOURCE_IMAGE_BYTES,
        });
      } catch {
        return null;
      }
    },
  });

  const files: SourceImageFile[] = [];
  let totalBytes = 0;

  for (const downloaded of downloadedResults) {
    if (totalBytes >= MAX_BRAND_SOURCE_IMAGE_TOTAL_BYTES) break;
    if (
      downloaded === null ||
      !downloaded.isOk ||
      downloaded.bytes.byteLength > MAX_BRAND_SOURCE_IMAGE_BYTES ||
      !downloaded.contentType.toLowerCase().startsWith("image/")
    ) {
      continue;
    }
    if (
      totalBytes + downloaded.bytes.byteLength >
      MAX_BRAND_SOURCE_IMAGE_TOTAL_BYTES
    ) {
      continue;
    }
    totalBytes += downloaded.bytes.byteLength;
    files.push({
      type: "file",
      mediaType: downloaded.contentType,
      data: downloaded.bytes,
    });
  }

  return files;
}
