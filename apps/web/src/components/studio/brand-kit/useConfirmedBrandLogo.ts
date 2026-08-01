"use client";

import { getConfirmedBrandAssetUrl } from "@/lib/brand-kit";
import type { BrandLogoSource } from "../block-defaults";
import { useActiveBrandKit } from "./useActiveBrandKit";

/**
 * The canvas's brand logo AS ALLOWED INTO DOCUMENTS (owner decision 4): the
 * CONFIRMED durable Convex-storage URL, or null when the kit's logo is
 * missing or still an unconfirmed suggestion. The single source both
 * insertion paths (palette click + drag) use for the Logo preset — never
 * read `brandKit.logoUrl` directly from document-writing code.
 */
export function useConfirmedBrandLogo(): BrandLogoSource | null {
  const { brandKit } = useActiveBrandKit();
  const confirmedLogoUrl = getConfirmedBrandAssetUrl({ brandKit, kind: "logo" });
  if (confirmedLogoUrl === null) {
    return null;
  }
  return { src: confirmedLogoUrl, alt: `${brandKit.name} logo` };
}
