"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { Loader2Icon, PaletteIcon, SparklesIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { BrandKit, BrandKitGenerateResult } from "@/lib/brand-kit";
import { useEditorStore } from "@/lib/editor-store";
import { ThemeSwatch } from "../theme/ThemeSwatch";
import { useActiveBrandKit } from "./useActiveBrandKit";

/**
 * The brand kit panel: a "Brand kit" toolbar button (next to the theme
 * selector it feeds) opening a centered MODAL dialog (owner decision — it
 * was a right-side sheet before; the modal at sm:max-w-xl gives the fields
 * and swatch rows room to read comfortably).
 *
 * v1 scope (demo-lean, no multi-kit library):
 * - shows the session's ACTIVE kit (saved kit → MOCK_BRAND_KIT fallback);
 * - "Create from website URL" → POST /api/brand-kit/generate (the scraper
 *   pipeline) → previews the returned kit's variations with the same
 *   Aa+circles swatches → Save (replaces the session's kit) or Discard;
 * - "Reset to default" clears the saved kit, dropping every tab back to the
 *   mock kit live.
 *
 * All persistence is per anonymous session (the store's authorId), which is
 * exactly what makes the kit shared across every canvas of this browser.
 */
export function BrandKitPanel() {
  const sessionId = useEditorStore((state) => state.authorId);
  const { brandKit: activeBrandKit, hasSavedKit } = useActiveBrandKit();
  const saveBrandKit = useMutation(api.brandKits.saveBrandKit);
  const clearBrandKit = useMutation(api.brandKits.clearBrandKit);

  const [isOpen, setIsOpen] = useState(false);
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateErrorMessage, setGenerateErrorMessage] = useState<string | null>(null);
  const [previewKit, setPreviewKit] = useState<BrandKit | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);

  const handleOpenChange = (nextIsOpen: boolean): void => {
    setIsOpen(nextIsOpen);
    if (nextIsOpen) {
      // Fresh visit: drop any stale preview/errors from the last session.
      setWebsiteUrl("");
      setIsGenerating(false);
      setGenerateErrorMessage(null);
      setPreviewKit(null);
      setSaveErrorMessage(null);
    }
  };

  const generateFromUrl = async (): Promise<void> => {
    const url = websiteUrl.trim();
    if (url.length === 0 || isGenerating) {
      return;
    }
    setIsGenerating(true);
    setGenerateErrorMessage(null);
    setPreviewKit(null);
    setSaveErrorMessage(null);
    try {
      const response = await fetch("/api/brand-kit/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      // Contract with the scraper route: ALWAYS a BrandKitGenerateResult JSON
      // body — { isOk: true, brandKit } or { isOk: false, message (friendly) }.
      const result = (await response.json()) as BrandKitGenerateResult;
      if (result.isOk) {
        setPreviewKit(result.brandKit);
      } else {
        setGenerateErrorMessage(result.message);
      }
    } catch {
      // Route unreachable / non-JSON reply — keep it friendly.
      setGenerateErrorMessage(
        "Couldn't generate a brand kit from that URL right now. Check the address and try again.",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const savePreviewKit = async (): Promise<void> => {
    if (previewKit === null || sessionId === null || isSaving) {
      return;
    }
    setIsSaving(true);
    setSaveErrorMessage(null);
    try {
      await saveBrandKit({
        sessionId,
        brandKit: {
          name: previewKit.name,
          ...(previewKit.sourceUrl !== undefined ? { sourceUrl: previewKit.sourceUrl } : {}),
          fonts: previewKit.fonts,
          ...(previewKit.logoUrl !== undefined ? { logoUrl: previewKit.logoUrl } : {}),
          ...(previewKit.socialImageUrl !== undefined
            ? { socialImageUrl: previewKit.socialImageUrl }
            : {}),
          variations: previewKit.variations,
        },
      });
      // The active-kit card (and every tab's ThemeMenu) updates reactively.
      setPreviewKit(null);
      setWebsiteUrl("");
    } catch (error: unknown) {
      // ConvexError.data carries the server's clear rejection message
      // (e.g. a failing contrast pairing); anything else gets a fallback.
      setSaveErrorMessage(
        error instanceof ConvexError
          ? String(error.data)
          : "Couldn't save the brand kit. Try again.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const resetToDefault = async (): Promise<void> => {
    if (sessionId === null || isResetting) {
      return;
    }
    setIsResetting(true);
    try {
      await clearBrandKit({ sessionId });
    } catch (error: unknown) {
      console.error("[brand-kit] reset failed:", error);
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            aria-label="Brand kit"
            title="Brand kit"
          />
        }
        data-testid="brand-kit-open-button"
      >
        <PaletteIcon className="size-4" />
        {/* Narrow-width degradation: icon-only below xl (the header must
            never crowd into the property panel). */}
        <span className="hidden xl:inline">Brand kit</span>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl" data-testid="brand-kit-panel">
        <DialogHeader>
          <DialogTitle>Brand kit</DialogTitle>
          <DialogDescription>
            One kit per browser — every canvas and its theme menu use it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[70vh] min-h-0 flex-col gap-4 overflow-y-auto">
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">Active kit</h3>
            <BrandKitSummary brandKit={activeBrandKit} isDefaultKit={!hasSavedKit} />
            {hasSavedKit && (
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => void resetToDefault()}
                disabled={isResetting}
                data-testid="brand-kit-reset-button"
              >
                {isResetting && <Loader2Icon className="animate-spin" />}
                Reset to default
              </Button>
            )}
          </section>

          <section className="flex flex-col gap-2 border-t pt-4">
            <Label htmlFor="brand-kit-url" className="text-xs font-medium text-muted-foreground">
              Create from website URL
            </Label>
            <form
              className="flex items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                void generateFromUrl();
              }}
            >
              {/* type=text on purpose: scheme-less addresses ("cnn.com") are
                  welcome — the backend normalizes them to https://. Native
                  type=url validation would reject exactly those. */}
              <Input
                id="brand-kit-url"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="your-brand.com"
                value={websiteUrl}
                onChange={(event) => setWebsiteUrl(event.target.value)}
                disabled={isGenerating}
                data-testid="brand-kit-url-input"
              />
              {/* Filled PRIMARY on purpose (owner call): the panel's main
                  action. Default size = h-8, matching the input beside it. */}
              <Button
                type="submit"
                className="shrink-0"
                disabled={isGenerating || websiteUrl.trim().length === 0}
                data-testid="brand-kit-generate-button"
              >
                {isGenerating ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
                {isGenerating ? "Generating…" : "Generate"}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">
              We&apos;ll scan the site for its colors and fonts, then build email-safe theme
              variations you can preview before saving.
            </p>
            {generateErrorMessage !== null && (
              <p className="text-xs text-destructive" data-testid="brand-kit-generate-error">
                {generateErrorMessage}
              </p>
            )}
          </section>

          {previewKit !== null && (
            <section className="flex flex-col gap-2" data-testid="brand-kit-preview">
              <h3 className="text-xs font-medium text-muted-foreground">Preview</h3>
              <BrandKitSummary brandKit={previewKit} isDefaultKit={false} />
              {saveErrorMessage !== null && (
                <p className="text-xs text-destructive" data-testid="brand-kit-save-error">
                  {saveErrorMessage}
                </p>
              )}
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  onClick={() => void savePreviewKit()}
                  disabled={isSaving || sessionId === null}
                  data-testid="brand-kit-save-button"
                >
                  {isSaving && <Loader2Icon className="animate-spin" />}
                  Save as my brand kit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPreviewKit(null);
                    setSaveErrorMessage(null);
                  }}
                  disabled={isSaving}
                  data-testid="brand-kit-discard-button"
                >
                  Discard
                </Button>
              </div>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One kit rendered as a card: name (+ "Default" badge for the mock fallback),
 * source URL, the heading/body font stacks (each shown in itself), and every
 * variation as a ThemeSwatch row — the same Aa+circles cue the theme dropdown
 * uses, so the panel and the menu read identically.
 */
function BrandKitSummary({
  brandKit,
  isDefaultKit,
}: {
  brandKit: BrandKit;
  isDefaultKit: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex min-w-0 items-center gap-2">
        {brandKit.logoUrl !== undefined && (
          // Plain <img> on purpose: the source is an arbitrary external host
          // (or a data:image/svg+xml URI) — next/image can't optimize either.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={brandKit.logoUrl}
            alt=""
            className="size-6 shrink-0 rounded border bg-white object-contain p-0.5"
            data-testid="brand-kit-logo"
          />
        )}
        <span className="min-w-0 truncate text-sm font-medium" data-testid="brand-kit-name">
          {brandKit.name}
        </span>
        {isDefaultKit && (
          <span className="shrink-0 rounded-full border bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
            Default
          </span>
        )}
      </div>
      {brandKit.sourceUrl !== undefined && (
        <a
          href={brandKit.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="-mt-2 truncate text-xs text-muted-foreground hover:underline"
        >
          {brandKit.sourceUrl}
        </a>
      )}
      <dl className="flex flex-col gap-1 text-xs">
        <div className="flex items-baseline gap-2">
          <dt className="w-14 shrink-0 text-muted-foreground">Heading</dt>
          <dd className="min-w-0 truncate" style={{ fontFamily: brandKit.fonts.heading }}>
            {brandKit.fonts.heading}
          </dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="w-14 shrink-0 text-muted-foreground">Body</dt>
          <dd className="min-w-0 truncate" style={{ fontFamily: brandKit.fonts.body }}>
            {brandKit.fonts.body}
          </dd>
        </div>
      </dl>
      {brandKit.socialImageUrl !== undefined && (
        // Subtle social-card peek — metadata display only, kept small.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={brandKit.socialImageUrl}
          alt=""
          className="h-14 w-auto max-w-full self-start rounded border object-cover opacity-90"
          data-testid="brand-kit-social-image"
        />
      )}
      <ul className="flex flex-col gap-1.5">
        {brandKit.variations.map((variation) => (
          <li
            key={variation.id}
            className="flex items-center gap-2"
            data-testid={`brand-kit-variation-${variation.id}`}
          >
            <ThemeSwatch globals={variation.globals} />
            <span className="min-w-0 truncate text-xs">{variation.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
