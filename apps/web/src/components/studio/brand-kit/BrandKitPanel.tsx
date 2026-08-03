"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { CheckIcon, Loader2Icon, PaletteIcon, SparklesIcon, ZoomInIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { ImageLightbox } from "@/components/ui/image-lightbox";
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
import {
  BRAND_COLOR_CATEGORY_LABELS,
  sortBrandColorsForDisplay,
  type BrandColor,
  type BrandKit,
  type BrandKitAssetKind,
  type BrandKitFonts,
  type BrandKitGenerateResult,
} from "@/lib/brand-kit";
import { describeBrandKitReconciliation } from "@/lib/brand-kit-reconcile";
import { SOCIAL_PLATFORM_LABELS, type SocialPlatform } from "@/lib/social-links";
import { useEditorStore } from "@/lib/editor-store";
import { useUiSurfaceOpenRequest } from "@/lib/ui-surfaces";

/** Chip label for a stored platform key (tolerates unknown/legacy keys). */
function getSocialPlatformLabel(platform: string): string {
  return SOCIAL_PLATFORM_LABELS[platform as SocialPlatform] ?? platform;
}
import { ThemeSwatch } from "../theme/ThemeSwatch";
import { BrandApplyDialog } from "./BrandApplyDialog";
import { BrandColorsEditor } from "./BrandColorsEditor";
import { BrandFontsEditor } from "./BrandFontsEditor";
import { BrandVoiceEditor, type BrandVoiceDraft } from "./BrandVoiceEditor";
import { useSessionBrandKit } from "./useActiveBrandKit";

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
  const canvasId = useEditorStore((state) => state.canvasId);
  // The panel edits the VIEWER's kit (session-scoped library object); the
  // canvas binding below decides which kit this canvas USES (Stage M §3.2).
  const { brandKit: activeBrandKit, hasSavedKit, kitId: sessionKitId } = useSessionBrandKit();
  const brandStatus = useQuery(
    api.brandKits.getCanvasBrandStatus,
    canvasId !== null ? { canvasId } : "skip",
  );
  const saveBrandKit = useMutation(api.brandKits.saveBrandKit);
  const clearBrandKit = useMutation(api.brandKits.clearBrandKit);
  const renameBrandKit = useMutation(api.brandKits.renameBrandKit);
  const updateBrandColors = useMutation(api.brandKits.updateBrandColors);
  const updateBrandFonts = useMutation(api.brandKits.updateBrandFonts);
  const updateBrandToneOfVoice = useMutation(api.brandKits.updateBrandToneOfVoice);
  const removeBrandKitAsset = useMutation(api.brandKits.removeBrandKitAsset);
  const bindSessionKitToCanvas = useMutation(api.brandKits.bindSessionKitToCanvas);
  const unbindCanvasBrandKit = useMutation(api.brandKits.unbindCanvasBrandKit);

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
  const [isBindingBusy, setIsBindingBusy] = useState(false);
  const [bindingErrorMessage, setBindingErrorMessage] = useState<string | null>(null);
  const [isApplyPromptOpen, setIsApplyPromptOpen] = useState(false);
  // §8.2: what a re-scrape KEPT of the human's, said out loud. Silent skipping
  // is the failure mode provenance exists to prevent.
  const [reconciliationMessage, setReconciliationMessage] = useState<string | null>(null);
  const [contentErrorMessage, setContentErrorMessage] = useState<string | null>(null);

  const canvasBinding = brandStatus?.binding ?? null;
  const isCanvasBoundToMyKit =
    canvasBinding !== null && sessionKitId !== null && canvasBinding.kitId === sessionKitId;

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
      setReconciliationMessage(null);
      setContentErrorMessage(null);
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
    setReconciliationMessage(null);
    try {
      const result = await saveBrandKit({
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
          ...(previewKit.colors !== undefined ? { colors: previewKit.colors } : {}),
          ...(previewKit.toneOfVoice !== undefined ? { toneOfVoice: previewKit.toneOfVoice } : {}),
          variations: previewKit.variations,
        },
      });
      // §8.2: say what survived the re-scrape instead of skipping silently.
      setReconciliationMessage(
        describeBrandKitReconciliation({
          keptUserEditedColors: result.keptUserEditedColors,
          keptUserToneOfVoice: result.keptUserToneOfVoice,
        }),
      );
      // The active-kit card (and every tab's ThemeMenu) updates reactively.
      setPreviewKit(null);
      setWebsiteUrl("");
      // Stage M §5.2 situation (b): saving the CANVAS-BOUND kit bumps its
      // revision, so the actor — and only the actor — gets the propagation
      // prompt. Everyone else sees per-draft pills.
      if (isCanvasBoundToMyKit) {
        setIsOpen(false);
        setIsApplyPromptOpen(true);
      }
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

  /**
   * Commit a font pick (v2 §1). The write re-fonts every theme in the kit, so
   * it DOES bump the revision — bound drafts are legitimately out of date and
   * their pills should say so. Nothing is restyled until somebody confirms
   * "Update drafts…".
   */
  const commitBrandFonts = async (fonts: BrandKitFonts): Promise<void> => {
    if (sessionId === null || !hasSavedKit) {
      return;
    }
    setAssetErrorMessage(null);
    try {
      await updateBrandFonts({ sessionId, fonts });
    } catch (error: unknown) {
      setAssetErrorMessage(
        error instanceof ConvexError ? String(error.data) : "Couldn't save that font. Try again.",
      );
    }
  };

  /**
   * Commit the whole palette (§3.2): one write, no revision bump — the
   * palette is a source for the picker and the agent, not something a draft
   * renders. Provenance ("this one is the human's now") is stamped
   * server-side, which is what makes the edit survive the next re-scrape.
   */
  const commitBrandColors = async (colors: BrandColor[]): Promise<void> => {
    if (sessionId === null || !hasSavedKit) {
      return;
    }
    setContentErrorMessage(null);
    try {
      await updateBrandColors({ sessionId, colors });
    } catch (error: unknown) {
      setContentErrorMessage(
        error instanceof ConvexError ? String(error.data) : "Couldn't save those colors. Try again.",
      );
    }
  };

  /** Commit the tone of voice (§5). `null` clears it back to the scrape's. */
  const commitToneOfVoice = async (draft: BrandVoiceDraft | null): Promise<void> => {
    if (sessionId === null || !hasSavedKit) {
      return;
    }
    setContentErrorMessage(null);
    try {
      await updateBrandToneOfVoice({ sessionId, toneOfVoice: draft });
    } catch (error: unknown) {
      setContentErrorMessage(
        error instanceof ConvexError
          ? String(error.data)
          : "Couldn't save the tone of voice. Try again.",
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

  /**
   * Bind the viewer's kit as this canvas's brand (Stage M §3.3): a shared
   * metadata write that restyles NOTHING — the §5.2 prompt that follows is
   * where the user chooses which drafts actually update.
   */
  const bindKitToCanvas = async (): Promise<void> => {
    if (canvasId === null || sessionId === null || isBindingBusy) {
      return;
    }
    setIsBindingBusy(true);
    setBindingErrorMessage(null);
    try {
      await bindSessionKitToCanvas({ canvasId, sessionId });
      setIsOpen(false);
      setIsApplyPromptOpen(true);
    } catch (error: unknown) {
      setBindingErrorMessage(
        error instanceof ConvexError
          ? String(error.data)
          : "Couldn't set the brand for this canvas. Try again.",
      );
    } finally {
      setIsBindingBusy(false);
    }
  };

  /** Remove the canvas binding (metadata only — drafts keep their look). */
  const stopUsingOnCanvas = async (): Promise<void> => {
    if (canvasId === null || isBindingBusy) {
      return;
    }
    setIsBindingBusy(true);
    setBindingErrorMessage(null);
    try {
      await unbindCanvasBrandKit({ canvasId });
    } catch {
      setBindingErrorMessage("Couldn't remove the brand from this canvas. Try again.");
    } finally {
      setIsBindingBusy(false);
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
    <>
      {/* The §5.2 propagation prompt — a SIBLING dialog (the panel closes
          first): opened after binding a kit here or saving the bound kit. */}
      <BrandApplyDialog isOpen={isApplyPromptOpen} onOpenChange={setIsApplyPromptOpen} />
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
      <DialogContent className="gap-5 p-6 sm:max-w-xl" data-testid="brand-kit-panel">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">Brand kit</DialogTitle>
          <DialogDescription>
            Your kit is saved per browser. Choose it for a canvas and everyone there shares its
            themes.
          </DialogDescription>
        </DialogHeader>

        <div className="-mr-2 flex max-h-[70vh] min-h-0 flex-col gap-6 overflow-y-auto pr-2">
          {/* The generate flow LEADS the modal (owner call): the URL scrape is
              what creates the kit, so it reads as the primary entry point,
              with its Preview directly below and the active kit after. */}
          <section className="flex flex-col gap-3">
            <Label htmlFor="brand-kit-url" className="text-sm leading-none font-semibold">
              Create from website URL
            </Label>
            <p className="text-xs text-muted-foreground">
              We&apos;ll scan the site for its colors and fonts, then build email-safe theme
              variations you can preview before saving.
            </p>
            <form
              className="flex items-center gap-2"
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
            {generateErrorMessage !== null && (
              <p className="text-sm text-destructive" data-testid="brand-kit-generate-error">
                {generateErrorMessage}
              </p>
            )}
          </section>

          {previewKit !== null && (
            <section className="flex flex-col gap-3 border-t pt-5" data-testid="brand-kit-preview">
              <h3 className="text-sm leading-none font-semibold">Preview</h3>
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
                <p className="text-sm text-destructive" data-testid="brand-kit-save-error">
                  {saveErrorMessage}
                </p>
              )}
              <div className="flex items-center gap-2">
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

          <section className="flex flex-col gap-3 border-t pt-5">
            <h3 className="text-sm leading-none font-semibold">Active kit</h3>
            <BrandKitSummary
              brandKit={activeBrandKit}
              isDefaultKit={!hasSavedKit}
              onNameCommit={hasSavedKit ? (name) => void commitActiveKitName(name) : undefined}
              onFontsCommit={hasSavedKit ? (fonts) => void commitBrandFonts(fonts) : undefined}
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
            {reconciliationMessage !== null && (
              <p className="text-sm text-muted-foreground" data-testid="brand-kit-reconciliation">
                {reconciliationMessage}
              </p>
            )}
            {assetErrorMessage !== null && (
              <p className="text-sm text-destructive" data-testid="brand-kit-asset-error">
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

          {hasSavedKit && (
            <section className="flex flex-col gap-3 border-t pt-5" data-testid="brand-kit-colors-section">
              <h3 className="text-sm leading-none font-semibold">Colors</h3>
              <p className="text-xs text-muted-foreground">
                We named and grouped what we found on the site. Rename, recolor, regroup — this is
                your palette.
              </p>
              <BrandColorsEditor
                colors={activeBrandKit.colors ?? []}
                isBusy={sessionId === null}
                onCommit={(colors) => void commitBrandColors(colors)}
              />
            </section>
          )}

          {hasSavedKit && (
            <section className="flex flex-col gap-3 border-t pt-5" data-testid="brand-kit-voice-section">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm leading-none font-semibold">Tone of voice</h3>
                {activeBrandKit.toneOfVoice !== undefined && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-muted-foreground"
                    onClick={() => void commitToneOfVoice(null)}
                    data-testid="brand-kit-voice-clear"
                  >
                    Clear
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                How your brand writes, so the assistant writes the same way.
              </p>
              <BrandVoiceEditor
                brandName={activeBrandKit.name}
                toneOfVoice={activeBrandKit.toneOfVoice}
                isBusy={sessionId === null}
                onCommit={(draft) => void commitToneOfVoice(draft)}
              />
            </section>
          )}

          {contentErrorMessage !== null && (
            <p className="text-sm text-destructive" data-testid="brand-kit-content-error">
              {contentErrorMessage}
            </p>
          )}

          <section
            className="flex flex-col gap-3 border-t pt-5"
            data-testid="brand-kit-canvas-section"
          >
            <h3 className="text-sm leading-none font-semibold">This canvas</h3>
            {canvasBinding === null ? (
              <>
                <p className="text-sm text-muted-foreground">
                  No brand chosen for this canvas yet. Choosing one doesn&apos;t restyle anything —
                  you pick which drafts update.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => void bindKitToCanvas()}
                  disabled={!hasSavedKit || isBindingBusy || canvasId === null}
                  data-testid="brand-kit-bind-button"
                >
                  {isBindingBusy && <Loader2Icon className="animate-spin" />}
                  Use this kit for the canvas
                </Button>
                {!hasSavedKit && (
                  <p className="text-xs text-muted-foreground">
                    Save a kit first, then choose it here.
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground" data-testid="brand-kit-binding-label">
                  Uses{" "}
                  <span className="font-medium text-foreground">
                    &ldquo;{canvasBinding.name}&rdquo;
                  </span>
                  {isCanvasBoundToMyKit ? " — your kit." : " — a collaborator's kit."}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setIsOpen(false);
                      setIsApplyPromptOpen(true);
                    }}
                    data-testid="brand-kit-update-drafts-button"
                  >
                    Update drafts…
                  </Button>
                  {!isCanvasBoundToMyKit && hasSavedKit && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void bindKitToCanvas()}
                      disabled={isBindingBusy}
                      data-testid="brand-kit-rebind-button"
                    >
                      {isBindingBusy && <Loader2Icon className="animate-spin" />}
                      Use my kit instead
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void stopUsingOnCanvas()}
                    disabled={isBindingBusy}
                    data-testid="brand-kit-unbind-button"
                  >
                    Stop using
                  </Button>
                </div>
              </>
            )}
            {bindingErrorMessage !== null && (
              <p className="text-sm text-destructive" data-testid="brand-kit-binding-error">
                {bindingErrorMessage}
              </p>
            )}
          </section>
        </div>
      </DialogContent>
      </Dialog>
    </>
  );
}

interface BrandKitAssetActions {
  busyKind: BrandKitAssetKind | null;
  onConfirm: (kind: BrandKitAssetKind) => void;
  onRemove: (kind: BrandKitAssetKind) => void;
}

/** Sub-label style shared by the card's inner groups (Fonts/Images/Themes). */
const KIT_GROUP_LABEL_CLASSNAME = "text-xs font-medium tracking-wide text-muted-foreground";

/**
 * One kit rendered as a card: the name (editable when `onNameCommit` is
 * given — the extracted name is only a suggestion), a "Default" badge for
 * the mock fallback, source URL, then labeled groups — the heading/body
 * fonts (email-safe dropdowns when `onFontsCommit` is given, otherwise the
 * stacks shown in themselves), the confirmable logo/social-card
 * asset squares (uniform 1:1 tiles; click to enlarge in a lightbox), social
 * links, and every variation as a ThemeSwatch row — the same Aa+circles cue
 * the theme dropdown uses. `assetActions` present = the saved-kit context
 * (Confirm & save / Remove buttons); absent = preview/default context
 * (chips only — decision 4 keeps unconfirmed suggestions display-only
 * everywhere regardless).
 */
function BrandKitSummary({
  brandKit,
  isDefaultKit,
  onNameCommit,
  onFontsCommit,
  assetActions,
}: {
  brandKit: BrandKit;
  isDefaultKit: boolean;
  onNameCommit?: (name: string) => void;
  onFontsCommit?: (fonts: BrandKitFonts) => void;
  assetActions?: BrandKitAssetActions;
}) {
  // ONE lightbox per card, pointed at whichever asset square was clicked.
  const [enlargedAsset, setEnlargedAsset] = useState<{ url: string; label: string } | null>(null);
  const hasAnyAsset = brandKit.logoUrl !== undefined || brandKit.socialImageUrl !== undefined;

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      <ImageLightbox
        isOpen={enlargedAsset !== null}
        onOpenChange={(isLightboxOpen) => {
          if (!isLightboxOpen) {
            setEnlargedAsset(null);
          }
        }}
        imageUrl={enlargedAsset?.url ?? null}
        title={enlargedAsset?.label ?? ""}
      />
      <div className="flex min-w-0 flex-col gap-1">
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
              className="h-9 min-w-0 text-sm font-medium"
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
            <span className="shrink-0 rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Default
            </span>
          )}
        </div>
        {brandKit.sourceUrl !== undefined && (
          <a
            href={brandKit.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="truncate text-xs text-muted-foreground hover:underline"
          >
            {brandKit.sourceUrl}
          </a>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className={KIT_GROUP_LABEL_CLASSNAME}>Fonts</span>
        {onFontsCommit === undefined ? (
          <dl className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-3">
              <dt className="w-16 shrink-0 text-xs text-muted-foreground">Heading</dt>
              <dd
                className="min-w-0 truncate text-sm"
                style={{ fontFamily: brandKit.fonts.heading }}
              >
                {brandKit.fonts.heading}
              </dd>
            </div>
            <div className="flex items-baseline gap-3">
              <dt className="w-16 shrink-0 text-xs text-muted-foreground">Body</dt>
              <dd className="min-w-0 truncate text-sm" style={{ fontFamily: brandKit.fonts.body }}>
                {brandKit.fonts.body}
              </dd>
            </div>
          </dl>
        ) : (
          <>
            <BrandFontsEditor fonts={brandKit.fonts} onCommit={onFontsCommit} />
            <p className="text-xs text-muted-foreground">
              Changing a font updates every theme in this kit. Drafts keep their look until you
              choose to update them.
            </p>
          </>
        )}
      </div>
      {hasAnyAsset && (
        <div className="flex flex-col gap-1.5">
          <span className={KIT_GROUP_LABEL_CLASSNAME}>Images</span>
          <div className="grid grid-cols-2 gap-3">
            {brandKit.logoUrl !== undefined && (
              <BrandAssetCard
                kind="logo"
                label="Logo"
                url={brandKit.logoUrl}
                isConfirmed={brandKit.logoConfirmedAtMs !== undefined}
                assetActions={assetActions}
                onEnlarge={() =>
                  setEnlargedAsset(
                    brandKit.logoUrl === undefined
                      ? null
                      : { url: brandKit.logoUrl, label: "Logo" },
                  )
                }
              />
            )}
            {brandKit.socialImageUrl !== undefined && (
              <BrandAssetCard
                kind="socialCard"
                label="Social card"
                url={brandKit.socialImageUrl}
                isConfirmed={brandKit.socialImageConfirmedAtMs !== undefined}
                assetActions={assetActions}
                onEnlarge={() =>
                  setEnlargedAsset(
                    brandKit.socialImageUrl === undefined
                      ? null
                      : { url: brandKit.socialImageUrl, label: "Social card" },
                  )
                }
              />
            )}
          </div>
        </div>
      )}
      {brandKit.colors !== undefined && brandKit.colors.length > 0 && (
        <div className="flex flex-col gap-1.5" data-testid="brand-kit-colors-preview">
          <span className={KIT_GROUP_LABEL_CLASSNAME}>Colors</span>
          <div className="flex flex-wrap items-center gap-2">
            {sortBrandColorsForDisplay(brandKit.colors).map((color) => (
              <span
                key={color.id}
                className="flex items-center gap-1.5 rounded-full border py-0.5 pr-2 pl-1 text-[11px] text-muted-foreground"
                title={`${color.name} — ${color.hex} (${BRAND_COLOR_CATEGORY_LABELS[color.category].toLowerCase()})`}
              >
                <span
                  className="size-3.5 shrink-0 rounded-full border border-input"
                  style={{ backgroundColor: color.hex }}
                />
                {color.name}
              </span>
            ))}
          </div>
        </div>
      )}
      {brandKit.toneOfVoice !== undefined && brandKit.toneOfVoice.descriptors.length > 0 && (
        <div className="flex flex-col gap-1.5" data-testid="brand-kit-voice-preview">
          <span className={KIT_GROUP_LABEL_CLASSNAME}>Tone of voice</span>
          <span className="text-sm">{brandKit.toneOfVoice.descriptors.join(", ")}</span>
        </div>
      )}
      {brandKit.socialLinks !== undefined && brandKit.socialLinks.length > 0 && (
        <div className="flex flex-col gap-1.5" data-testid="brand-kit-social-links">
          <span className={KIT_GROUP_LABEL_CLASSNAME}>Social links</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {brandKit.socialLinks.map(({ platform, url }) => (
              <a
                key={platform}
                href={url}
                target="_blank"
                rel="noreferrer"
                title={url}
                className="rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                data-testid={`brand-kit-social-link-${platform}`}
              >
                {getSocialPlatformLabel(platform)}
              </a>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <span className={KIT_GROUP_LABEL_CLASSNAME}>Themes</span>
        <ul className="flex flex-col">
          {brandKit.variations.map((variation) => (
            <li
              key={variation.id}
              className="flex items-center gap-3 py-2.5"
              data-testid={`brand-kit-variation-${variation.id}`}
            >
              <ThemeSwatch globals={variation.globals} />
              <span className="min-w-0 truncate text-sm">{variation.name}</span>
            </li>
          ))}
        </ul>
      </div>
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
 * One confirmable asset (§8.1) as a uniform grid tile: a 1:1 muted square
 * with the image contain-fit inside (the wide social card letterboxes, the
 * square-ish logo fills — the tiles stay identical side by side), then the
 * label + Suggested/Saved chip and the source line; in the saved-kit context
 * also [Confirm & save] / [Remove]. Clicking the square opens the card's
 * lightbox. Unconfirmed suggestions never leave this UI (owner decision 4).
 */
function BrandAssetCard({
  kind,
  label,
  url,
  isConfirmed,
  assetActions,
  onEnlarge,
}: {
  kind: BrandKitAssetKind;
  label: string;
  url: string;
  isConfirmed: boolean;
  assetActions?: BrandKitAssetActions;
  onEnlarge: () => void;
}) {
  const isBusy = assetActions?.busyKind === kind;
  const isAnotherAssetBusy =
    assetActions !== undefined && assetActions.busyKind !== null && !isBusy;
  return (
    <div
      className="flex min-w-0 flex-col overflow-hidden rounded-lg border"
      data-testid={`brand-kit-asset-${kind}`}
    >
      <button
        type="button"
        onClick={onEnlarge}
        aria-label={`View ${label.toLowerCase()} larger`}
        className="group relative flex aspect-square w-full cursor-zoom-in items-center justify-center overflow-hidden bg-muted p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {/* Plain <img> on purpose: the source is an arbitrary external host
            (or a data:image/svg+xml URI) — next/image can't optimize either. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt=""
          className="size-full object-contain"
          data-testid={`brand-kit-asset-${kind}-image`}
        />
        <span className="absolute right-2 bottom-2 flex size-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <ZoomInIcon className="size-3.5" />
        </span>
      </button>
      <div className="flex min-w-0 flex-col gap-1 border-t p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{label}</span>
          <span
            className={
              isConfirmed
                ? "flex shrink-0 items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success"
                : "shrink-0 rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
            }
            data-testid={`brand-kit-asset-${kind}-chip`}
          >
            {isConfirmed && <CheckIcon className="size-3" />}
            {isConfirmed ? "Saved" : "Suggested"}
          </span>
        </div>
        <span className="truncate text-xs text-muted-foreground">
          {describeAssetSource({ url, isConfirmed })}
        </span>
        {assetActions !== undefined && (
          <div className="mt-1 flex items-center gap-1">
            {!isConfirmed && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
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
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => assetActions.onRemove(kind)}
              disabled={isBusy || isAnotherAssetBusy}
              data-testid={`brand-kit-asset-${kind}-remove`}
            >
              Remove
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
