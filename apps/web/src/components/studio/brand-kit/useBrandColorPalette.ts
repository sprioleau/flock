"use client";

import { useMemo } from "react";
import { getBrandKitPalette, type BrandPaletteSwatch } from "@/lib/brand-kit";
import { useActiveBrandKit } from "./useActiveBrandKit";

/*
  The active brand kit's palette for color-picker swatch rows. Empty when
  the session has no SAVED kit (the mock fallback is not the user's brand —
  "no kit → no swatch row"). Reactive: saving/clearing a kit updates every
  open picker live.
*/
export function useBrandColorPalette(): BrandPaletteSwatch[] {
  const { brandKit, hasSavedKit } = useActiveBrandKit();
  return useMemo(
    () => (hasSavedKit ? getBrandKitPalette(brandKit) : []),
    [brandKit, hasSavedKit],
  );
}
