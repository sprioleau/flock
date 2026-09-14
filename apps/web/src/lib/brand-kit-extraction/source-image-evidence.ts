import {
  MAX_BRAND_SOURCE_IMAGES,
  type BrandSourceImage,
} from "@/lib/brand-kit";
import { extractPage } from "@/lib/content-ingestion/extract-page";
import type { ImageCandidate } from "@/lib/content-ingestion/page-scrape";
import { isImageUrlRenderable } from "./verify-image-url";

const MAX_IMAGE_CANDIDATES_TO_VERIFY = 8;

export type ImageUrlVerifier = (url: string) => Promise<boolean>;

async function verifyImageUrlByDefault(url: string): Promise<boolean> {
  return isImageUrlRenderable({ url });
}

function isDecorativeCandidate(candidate: ImageCandidate): boolean {
  const labels = [candidate.alt, candidate.nearestHeading, candidate.sourceUrl, ...candidate.hints]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLowerCase();
  const isLogoOrIcon = /(?:^|[\s/_-])(favicon|icon|logo|sprite)(?:[\s/_.-]|$)/i.test(labels);
  const isSmall =
    candidate.width !== undefined &&
    candidate.height !== undefined &&
    (candidate.width < 100 || candidate.height < 100);
  return isLogoOrIcon || isSmall;
}

function getCandidateScore(candidate: ImageCandidate): number {
  let score = 0;
  if (candidate.origin === "inline" || candidate.origin === "css-background") {
    score += 40;
  } else if (candidate.origin === "structured-data") {
    score += 24;
  } else if (candidate.origin === "og-image") {
    score += 16;
  }
  if (candidate.width !== undefined && candidate.height !== undefined) {
    const shortestEdge = Math.min(candidate.width, candidate.height);
    score += shortestEdge >= 400 ? 24 : shortestEdge >= 200 ? 12 : 0;
  }
  if ((candidate.alt?.trim().length ?? 0) > 0) {
    score += 10;
  }
  if ((candidate.nearestHeading?.trim().length ?? 0) > 0) {
    score += 8;
  }
  if ((candidate.surroundingText?.trim().length ?? 0) > 0) {
    score += 4;
  }
  return score;
}

function toBrandSourceImage(candidate: ImageCandidate): BrandSourceImage {
  return {
    url: candidate.sourceUrl,
    ...(candidate.alt === undefined ? {} : { alt: candidate.alt }),
    ...(candidate.width === undefined ? {} : { width: candidate.width }),
    ...(candidate.height === undefined ? {} : { height: candidate.height }),
  };
}

/*
  Select a small, verifiably renderable visual sample from the same generic
  page-image harvest used by content ingestion. Selection is deterministic:
  content images with useful dimensions/context beat metadata fallbacks, while
  logos, icons, and tiny chrome are removed. A site that exposes fewer than
  four honest candidates returns fewer rather than padding with inventions.
*/
export async function selectRepresentativeSourceImages({
  html,
  finalUrl,
  verifyImageUrl = verifyImageUrlByDefault,
}: {
  html: string;
  finalUrl: string;
  verifyImageUrl?: ImageUrlVerifier;
}): Promise<BrandSourceImage[]> {
  const extraction = extractPage({ html, finalUrl });
  if (!extraction.isOk) {
    return [];
  }
  const rankedCandidates = extraction.scrape.imageCandidates
    .filter((candidate) => !isDecorativeCandidate(candidate))
    .sort((left, right) => {
      const scoreDifference = getCandidateScore(right) - getCandidateScore(left);
      return scoreDifference === 0 ? left.documentOrder - right.documentOrder : scoreDifference;
    })
    .slice(0, MAX_IMAGE_CANDIDATES_TO_VERIFY);
  const verification = await Promise.all(
    rankedCandidates.map(async (candidate) => ({
      candidate,
      isRenderable: await verifyImageUrl(candidate.sourceUrl),
    })),
  );
  return verification
    .filter(({ isRenderable }) => isRenderable)
    .slice(0, MAX_BRAND_SOURCE_IMAGES)
    .map(({ candidate }) => toBrandSourceImage(candidate));
}
