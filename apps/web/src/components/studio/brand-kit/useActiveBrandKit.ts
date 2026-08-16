"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { MOCK_BRAND_KIT, type BrandKit } from "@/lib/brand-kit";
import { useEditorStore } from "@/lib/editor-store";

/**
 * The CANVAS's active brand kit — the single source every brand consumer
 * (ThemeMenu, color palette, social fill) reads. Stage M scoping (brand-kit
 * architecture §3.2): the brand is canvas state, so every capability holder
 * resolves it THROUGH the canvas — bound kit → canvas creator-session's kit
 * (legacy fallback) → MOCK_BRAND_KIT — never through their own session.
 * That's what makes two collaborators' theme menus finally agree.
 *
 * Reactive on purpose: binding a kit, saving it (revision bump), or clearing
 * it updates every subscribed tab of every collaborator live.
 */
export function useActiveBrandKit(): {
  /** The kit to render/apply right now (never null — mock is the floor). */
  brandKit: BrandKit;
  /** True when a saved kit (not the mock fallback) resolved for this canvas. */
  hasSavedKit: boolean;
  /** True when the kit came from the canvas BINDING (not the legacy session fallback). */
  isBoundToCanvas: boolean;
  /*
    The resolved kit's row id (null for the mock fallback). Compare it against
    `useSessionBrandKit().kitId` to answer "is the kit on screen MINE?" — the
    question every session-scoped write (renaming, confirming an asset) has to
    settle before it offers a control, since it would otherwise act on the
    viewer's own kit rather than the one the canvas is showing.
  */
  kitId: Id<"brandKits"> | null;
} {
  const canvasId = useEditorStore((state) => state.canvasId);
  const resolved = useQuery(
    api.brandKits.getBrandKitForCanvas,
    canvasId !== null ? { canvasId } : "skip",
  );
  const hasSavedKit = resolved !== undefined && resolved !== null;
  return {
    // The cast is safe at runtime: saveBrandKit validates every stored kit
    // (SDK Zod strict parse + completeness + WCAG contrast) before writing.
    brandKit: hasSavedKit ? (resolved.kit as unknown as BrandKit) : MOCK_BRAND_KIT,
    hasSavedKit,
    isBoundToCanvas: hasSavedKit && resolved.source === "binding",
    kitId: hasSavedKit ? resolved.kitId : null,
  };
}

/**
 * The VIEWER's own saved kit — the library object the brand-kit panel edits
 * (scrape/save/rename/confirm are session-scoped; the canvas binding above
 * decides which kit a canvas USES). Kept separate so a collaborator editing
 * their own kit never mistakes the canvas's bound kit for it.
 */
export function useSessionBrandKit(): {
  /** The viewer's saved kit, mock fallback when none. */
  brandKit: BrandKit;
  /** True when the viewer has a saved kit of their own. */
  hasSavedKit: boolean;
  /** The saved kit's stable row id (null for the mock fallback) — compared against the canvas binding. */
  kitId: Id<"brandKits"> | null;
} {
  const sessionId = useEditorStore((state) => state.authorId);
  const savedKit = useQuery(
    api.brandKits.getActiveBrandKit,
    sessionId !== null ? { sessionId } : "skip",
  );
  const hasSavedKit = savedKit !== undefined && savedKit !== null;
  return {
    brandKit: hasSavedKit ? (savedKit as unknown as BrandKit) : MOCK_BRAND_KIT,
    hasSavedKit,
    kitId: hasSavedKit ? savedKit.kitId : null,
  };
}
