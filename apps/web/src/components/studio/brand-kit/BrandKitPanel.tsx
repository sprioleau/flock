"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { CheckIcon, Loader2Icon, PaletteIcon, SparklesIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { BrandKit, BrandKitAssetKind, BrandKitGenerateResult } from "@/lib/brand-kit";
import { SOCIAL_PLATFORM_LABELS, type SocialPlatform } from "@/lib/social-links";
import { useEditorStore } from "@/lib/editor-store";
import { useUiSurfaceOpenRequest } from "@/lib/ui-surfaces";

/** Chip label for a stored platform key (tolerates unknown/legacy keys). */
function getSocialPlatformLabel(platform: string): string {
  return SOCIAL_PLATFORM_LABELS[platform as SocialPlatform] ?? platform;
}
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
 *   Aa+circles swatches → Save (patches the session's kit row in place) or
 *   Discard;
 * - Stage S (brand-kit architecture §8): the extracted logo/social card are
 *   SUGGESTIONS with confirm affordances — "Confirm & save" pulls the binary
 *   into Convex storage via POST /api/brand-kit/confirm-asset and the row's
 *   URL becomes durable ("Saved" chip). Unconfirmed suggestions render in
 *   this panel only (owner decision 4). The company name is a suggestion
 *   too: a plain editable input, persisted via renameBrandKit;
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
  const renameBrandKit = useMutation(api.brandKits.renameBrandKit);
  const removeBrandKitAsset = useMutation(api.brandKits.removeBrandKitAsset);

  const [isOpen, setIsOpen] = useState(false);
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateErrorMessage, setGenerateErrorMessage] = useState<string | null>(null);
  const [previewKit, setPreviewKit] = useState<BrandKit | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [busyAssetKind, setBusyAssetKind] = useState<BrandKitAssetKind | null>(null);
  const [assetErrorMessage, setAssetErrorMessage] = useState<string | null>(null);

  const handleOpenChange = (nextIsOpen: boolean): void => {
    setIsOpen(nextIsOpen);
    if (nextIsOpen) {
      // Fresh visit: drop any stale preview/errors from the last session.
      setWebsiteUrl("");
      setIsGenerating(false);
      setGenerateErrorMessage(null);
      setPreviewKit(null);
      setSaveErrorMessage(null);
      setBusyAssetKind(null);
      setAssetErrorMessage(null);
    }
  };

  // Agent-parity: the chat's openPanel("brand-kit") command opens this dialog
  // through the same reset-on-open path as a human click.
  useUiSurfaceOpenRequest("brand-kit", () => handleOpenChange(true));

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
          ...(previewKit.socialLinks !== undefined ? { socialLinks: previewKit.socialLinks } : {}),
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

  /** Persist a name edit on the SAVED kit (suggestion — the user's edit wins). */
  const commitActiveKitName = async (name: string): Promise<void> => {
    const trimmedName = name.trim();
    if (
      sessionId === null ||
      !hasSavedKit ||
      trimmedName.length === 0 ||
      trimmedName === activeBrandKit.name
    ) {
      return;
    }
    try {
      await renameBrandKit({ sessionId, name: trimmedName });
    } catch (error: unknown) {
      setAssetErrorMessage(
        error instanceof ConvexError ? String(error.data) : "Couldn't rename the kit. Try again.",
      );
    }
  };

  /** Confirm a suggested asset: binary → Convex storage → durable row URL. */
  const confirmAsset = async (kind: BrandKitAssetKind): Promise<void> => {
    if (sessionId === null || busyAssetKind !== null) {
      return;
    }
    setBusyAssetKind(kind);
    setAssetErrorMessage(null);
    try {
      const response = await fetch("/api/brand-kit/confirm-asset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, kind }),
      });
      const result = (await response.json()) as { isOk: boolean; message?: string };
      if (!result.isOk) {
        setAssetErrorMessage(result.message ?? "Couldn't save that image. Try again.");
      }
      // Success needs no local state: the kit row updated and the reactive
      // query swaps the card to the durable URL + "Saved" chip live.
    } catch {
      setAssetErrorMessage("Couldn't save that image right now. Try again.");
    } finally {
      setBusyAssetKind(null);
    }
  };

  const removeAsset = async (kind: BrandKitAssetKind): Promise<void> => {
    if (sessionId === null || busyAssetKind !== null) {
      return;
    }
    setBusyAssetKind(kind);
    setAssetErrorMessage(null);
    try {
      await removeBrandKitAsset({ sessionId, kind });
    } catch (error: unknown) {
      setAssetErrorMessage(
        error instanceof ConvexError
          ? String(error.data)
          : "Couldn't remove that image. Try again.",
      );
    } finally {
      setBusyAssetKind(null);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {/* Tooltip + dialog trigger on ONE element (base-ui render composition)
          — below xl the trigger is icon-only, so hover carries the label. */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <DialogTrigger
                render={
                  <Button variant="outline" size="sm" className="gap-1.5" aria-label="Brand kit" />
                }
                data-testid="brand-kit-open-button"
              >
                <PaletteIcon className="size-4" />
                {/* Narrow-width degradation: icon-only below xl (the header
                    must never crowd into the property panel). */}
                <span className="hidden xl:inline">Brand kit</span>
              </DialogTrigger>
            }
          />
          <TooltipContent side="bottom">Brand kit</TooltipContent>
        </Tooltip>
      </TooltipProvider>
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
            <BrandKitSummary
              brandKit={activeBrandKit}
              isDefaultKit={!hasSavedKit}
              onNameCommit={hasSavedKit ? (name) => void commitActiveKitName(name) : undefined}
              assetActions={
                hasSavedKit
                  ? {
                      busyKind: busyAssetKind,
                      onConfirm: (kind) => void confirmAsset(kind),
                      onRemove: (kind) => void removeAsset(kind),
                    }
                  : undefined
              }
            />
            {assetErrorMessage !== null && (
              <p className="text-xs text-destructive" data-testid="brand-kit-asset-error">
                {assetErrorMessage}
              </p>
            )}
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
              <BrandKitSummary
                brandKit={previewKit}
                isDefaultKit={false}
                onNameCommit={(name) =>
                  setPreviewKit((current) => (current === null ? null : { ...current, name }))
                }
              />
              <p className="text-xs text-muted-foreground">
                The name and images are suggestions from the site — edit the name freely; save the
                kit, then confirm its logo and social card to keep them.
              </p>
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

interface BrandKitAssetActions {
  busyKind: BrandKitAssetKind | null;
  onConfirm: (kind: BrandKitAssetKind) => void;
  onRemove: (kind: BrandKitAssetKind) => void;
}

/**
 * One kit rendered as a card: the name (editable when `onNameCommit` is
 * given — the extracted name is only a suggestion), a "Default" badge for
 * the mock fallback, source URL, the heading/body font stacks (each shown
 * in itself), the confirmable logo/social-card asset rows, and every
 * variation as a ThemeSwatch row — the same Aa+circles cue the theme
 * dropdown uses. `assetActions` present = the saved-kit context
 * (Confirm & save / Remove buttons); absent = preview/default context
 * (chips only — decision 4 keeps unconfirmed suggestions display-only
 * everywhere regardless).
 */
function BrandKitSummary({
  brandKit,
  isDefaultKit,
  onNameCommit,
  assetActions,
}: {
  brandKit: BrandKit;
  isDefaultKit: boolean;
  onNameCommit?: (name: string) => void;
  assetActions?: BrandKitAssetActions;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex min-w-0 items-center gap-2">
        {onNameCommit === undefined ? (
          <span className="min-w-0 truncate text-sm font-medium" data-testid="brand-kit-name">
            {brandKit.name}
          </span>
        ) : (
          // Uncontrolled + keyed by the current name: reactive updates (e.g.
          // a rename from another tab) reset the field; commits happen on
          // blur or Enter.
          <Input
            key={brandKit.name}
            type="text"
            defaultValue={brandKit.name}
            aria-label="Brand kit name"
            className="h-8 min-w-0 text-sm font-medium"
            onBlur={(event) => onNameCommit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
            data-testid="brand-kit-name-input"
          />
        )}
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
      {brandKit.logoUrl !== undefined && (
        <BrandAssetRow
          kind="logo"
          label="Logo"
          url={brandKit.logoUrl}
          isConfirmed={brandKit.logoConfirmedAtMs !== undefined}
          assetActions={assetActions}
        />
      )}
      {brandKit.socialImageUrl !== undefined && (
        <BrandAssetRow
          kind="socialCard"
          label="Social card"
          url={brandKit.socialImageUrl}
          isConfirmed={brandKit.socialImageConfirmedAtMs !== undefined}
          assetActions={assetActions}
        />
      )}
      {brandKit.socialLinks !== undefined && brandKit.socialLinks.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="brand-kit-social-links">
          <span className="text-[10px] font-medium text-muted-foreground">Social links</span>
          <div className="flex flex-wrap items-center gap-1">
            {brandKit.socialLinks.map(({ platform, url }) => (
              <a
                key={platform}
                href={url}
                target="_blank"
                rel="noreferrer"
                title={url}
                className="rounded-full border bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground hover:text-foreground"
                data-testid={`brand-kit-social-link-${platform}`}
              >
                {getSocialPlatformLabel(platform)}
              </a>
            ))}
          </div>
        </div>
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

/** Where an asset suggestion points, in friendly words. */
function describeAssetSource({ url, isConfirmed }: { url: string; isConfirmed: boolean }): string {
  if (isConfirmed) {
    return "Saved to your kit";
  }
  if (url.startsWith("data:")) {
    return "From the site's HTML";
  }
  try {
    return new URL(url).hostname;
  } catch {
    return "From the site";
  }
}

/**
 * One confirmable asset (§8.1): thumbnail + source + Suggested/Saved chip;
 * in the saved-kit context also [Confirm & save] / [Remove]. Unconfirmed
 * suggestions never leave this UI (owner decision 4).
 */
function BrandAssetRow({
  kind,
  label,
  url,
  isConfirmed,
  assetActions,
}: {
  kind: BrandKitAssetKind;
  label: string;
  url: string;
  isConfirmed: boolean;
  assetActions?: BrandKitAssetActions;
}) {
  const isBusy = assetActions?.busyKind === kind;
  const isAnotherAssetBusy =
    assetActions !== undefined && assetActions.busyKind !== null && !isBusy;
  return (
    <div className="flex items-center gap-2" data-testid={`brand-kit-asset-${kind}`}>
      {/* Plain <img> on purpose: the source is an arbitrary external host
          (or a data:image/svg+xml URI) — next/image can't optimize either. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt=""
        className={
          kind === "logo"
            ? "size-8 shrink-0 rounded border bg-white object-contain p-0.5"
            : "h-8 w-14 shrink-0 rounded border object-cover"
        }
        data-testid={`brand-kit-asset-${kind}-image`}
      />
      <div className="flex min-w-0 flex-col">
        <span className="text-xs font-medium">{label}</span>
        <span className="truncate text-[11px] text-muted-foreground">
          {describeAssetSource({ url, isConfirmed })}
        </span>
      </div>
      <span
        className={
          isConfirmed
            ? "ml-auto flex shrink-0 items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-1.5 py-px text-[10px] font-medium text-emerald-700"
            : "ml-auto shrink-0 rounded-full border bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground"
        }
        data-testid={`brand-kit-asset-${kind}-chip`}
      >
        {isConfirmed && <CheckIcon className="size-2.5" />}
        {isConfirmed ? "Saved" : "Suggested"}
      </span>
      {assetActions !== undefined && (
        <div className="flex shrink-0 items-center gap-1">
          {!isConfirmed && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => assetActions.onConfirm(kind)}
              disabled={isBusy || isAnotherAssetBusy}
              data-testid={`brand-kit-asset-${kind}-confirm`}
            >
              {isBusy && <Loader2Icon className="animate-spin" />}
              Confirm &amp; save
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-muted-foreground"
            onClick={() => assetActions.onRemove(kind)}
            disabled={isBusy || isAnotherAssetBusy}
            data-testid={`brand-kit-asset-${kind}-remove`}
          >
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}
