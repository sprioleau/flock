"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { MOCK_BRAND_KIT, type BrandKit } from "@/lib/brand-kit";
import { useEditorStore } from "@/lib/editor-store";

/**
 * The session's ACTIVE brand kit — the single source every brand-kit consumer
 * (ThemeMenu, BrandKitPanel) reads. Fallback chain: saved kit (Convex,
 * per-session) → MOCK_BRAND_KIT.
 *
 * Reactive on purpose: this is a live Convex subscription keyed by the
 * anonymous session id (the store's `authorId`, set once the document
 * connects), so saving or clearing a kit in the panel updates the theme
 * dropdown in EVERY open canvas/tab of the session instantly — "each editor
 * canvas uses the same brand kit".
 */
export function useActiveBrandKit(): {
  /** The kit to render/apply right now (never null — mock is the floor). */
  brandKit: BrandKit;
  /** True when a saved kit (not the mock fallback) is active. */
  hasSavedKit: boolean;
} {
  const sessionId = useEditorStore((state) => state.authorId);
  const savedKit = useQuery(
    api.brandKits.getActiveBrandKit,
    sessionId !== null ? { sessionId } : "skip",
  );
  const hasSavedKit = savedKit !== undefined && savedKit !== null;
  return {
    // The cast is safe at runtime: saveBrandKit validates every stored kit
    // (SDK Zod strict parse + completeness + WCAG contrast) before writing.
    brandKit: hasSavedKit ? (savedKit as BrandKit) : MOCK_BRAND_KIT,
    hasSavedKit,
  };
}
