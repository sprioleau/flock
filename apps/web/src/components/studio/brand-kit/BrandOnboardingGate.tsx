"use client";

import { useState, useSyncExternalStore } from "react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildSaveBrandKitPayload, type BrandKit } from "@/lib/brand-kit";
import { getStarterArchetypes } from "@/lib/brand-kit-archetypes";
import { useEditorStore } from "@/lib/editor-store";
import { ThemeSwatch } from "../theme/ThemeSwatch";
import {
  nextPhaseAfterGenerate,
  persistBrandOnboardingDismissed,
  readIsBrandOnboardingDismissed,
  shouldShowBrandOnboardingGate,
  subscribeToBrandOnboardingDismissal,
  type BrandOnboardingPhase,
} from "./brand-onboarding-gate";
import { generateBrandKitFromUrl } from "./brand-kit-generate-client";
import { useSessionBrandKit } from "./useActiveBrandKit";

/*
  Brand-first onboarding (owner decision): a session with no saved brand kit
  is prompted, prominently, to set one up before it settles into the editor —
  but the prompt is never a wall.

  SEQUENTIAL, not all-options-at-once (owner correction to the first pass,
  which showed the URL box and every archetype on one screen). The gate
  starts on ONE encouraged step — scan a website — and only reveals the
  curated archetype fallback once that step has actually failed, or the
  person says up front they have no website. `nextPhaseAfterGenerate` in
  brand-onboarding-gate.ts is the one rule this file trusts for that switch.

  BOTH surviving paths now produce a REAL, SAVED brand kit through the one
  Convex mutation (`saveBrandKit`) — the exact same mutation, and the exact
  same payload-shaping helper (`buildSaveBrandKitPayload`), the brand kit
  panel's own save uses. Picking an archetype is no longer a per-draft
  `applyTheme`-only shortcut: it is a full, later-editable kit ("you can
  always edit the logos and everything else associated with the brand"),
  which is what makes the gate's cadence rule — once ANY brand exists, never
  prompt again — hold permanently rather than just for the current session.
  `hasSavedKit` flipping true is what actually closes the gate; no local
  dismissal write happens on a save, only on the low-emphasis skip.

  MOUNTS as a full-screen overlay, a SIBLING of the studio layout rather than
  a replacement for it (same reasoning as StudioTour: the document is already
  created and connected by the time this can show).
*/
export function BrandOnboardingGate() {
  const sessionId = useEditorStore((state) => state.authorId);
  const isDocumentReady = useEditorStore((state) => state.isDocumentReady);
  const { hasSavedKit } = useSessionBrandKit();
  const saveBrandKit = useMutation(api.brandKits.saveBrandKit);

  /*
    localStorage as an external store (SSR/first-paint snapshot: nothing
    dismissed yet — the gate never flashes hidden-then-shown on hydration).
  */
  const isDismissed = useSyncExternalStore(
    subscribeToBrandOnboardingDismissal,
    () => sessionId !== null && readIsBrandOnboardingDismissed(sessionId),
    () => false,
  );

  const [phase, setPhase] = useState<BrandOnboardingPhase>("url");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateErrorMessage, setGenerateErrorMessage] = useState<string | null>(null);
  const [previewKit, setPreviewKit] = useState<BrandKit | null>(null);
  const [isSavingPreview, setIsSavingPreview] = useState(false);
  const [savePreviewErrorMessage, setSavePreviewErrorMessage] = useState<string | null>(null);
  const [savingArchetypeName, setSavingArchetypeName] = useState<string | null>(null);
  const [saveArchetypeErrorMessage, setSaveArchetypeErrorMessage] = useState<string | null>(null);

  const dismiss = (): void => {
    if (sessionId !== null) {
      persistBrandOnboardingDismissed(sessionId);
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
    setSavePreviewErrorMessage(null);
    const result = await generateBrandKitFromUrl(url);
    setPhase(nextPhaseAfterGenerate({ isOk: result.isOk }));
    if (result.isOk) {
      setPreviewKit(result.brandKit);
    } else {
      /*
        Owner rule: a scrape failure never traps the user — the message
        lands right above the curated fallback the phase switch just revealed.
      */
      setGenerateErrorMessage(result.message);
    }
    setIsGenerating(false);
  };

  const discardPreview = (): void => {
    setPreviewKit(null);
    setSavePreviewErrorMessage(null);
  };

  const saveScrapedKit = async (): Promise<void> => {
    if (previewKit === null || sessionId === null || isSavingPreview) {
      return;
    }
    setIsSavingPreview(true);
    setSavePreviewErrorMessage(null);
    try {
      await saveBrandKit({ sessionId, brandKit: buildSaveBrandKitPayload(previewKit) });
      /*
        A saved kit flips `hasSavedKit` true reactively, which is what
        actually closes this gate.
      */
    } catch (error: unknown) {
      setSavePreviewErrorMessage(
        error instanceof ConvexError
          ? String(error.data)
          : "Couldn't save the brand kit. Try again.",
      );
    } finally {
      setIsSavingPreview(false);
    }
  };

  const saveArchetype = async (archetype: BrandKit): Promise<void> => {
    if (sessionId === null || savingArchetypeName !== null) {
      return;
    }
    setSavingArchetypeName(archetype.name);
    setSaveArchetypeErrorMessage(null);
    try {
      await saveBrandKit({ sessionId, brandKit: buildSaveBrandKitPayload(archetype) });
      /*
        Same close mechanism as the scraped-kit save above: `hasSavedKit`
        flips true reactively once the mutation lands.
      */
    } catch (error: unknown) {
      setSaveArchetypeErrorMessage(
        error instanceof ConvexError
          ? String(error.data)
          : "Couldn't save that brand. Try again.",
      );
    } finally {
      setSavingArchetypeName(null);
    }
  };

  if (
    sessionId === null ||
    !shouldShowBrandOnboardingGate({ isDocumentReady, hasSavedKit, isDismissed })
  ) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm"
      data-testid="brand-onboarding-gate"
    >
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col gap-5 overflow-y-auto rounded-xl border bg-background p-6 shadow-xl">
        {phase === "url" ? (
          <>
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold">Set up your brand</h2>
              <p className="text-sm text-muted-foreground">
                Give Flock a website and every email starts in your colors, fonts and voice. You
                can always change this later from the brand kit.
              </p>
            </div>

            <section className="flex flex-col gap-3">
              <Label htmlFor="brand-onboarding-url" className="text-sm leading-none font-semibold">
                Scan your website
              </Label>
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void generateFromUrl();
                }}
              >
                <Input
                  id="brand-onboarding-url"
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="your-brand.com"
                  value={websiteUrl}
                  onChange={(event) => setWebsiteUrl(event.target.value)}
                  disabled={isGenerating}
                  data-testid="brand-onboarding-url-input"
                />
                <Button
                  type="submit"
                  className="shrink-0"
                  disabled={isGenerating || websiteUrl.trim().length === 0}
                  data-testid="brand-onboarding-generate-button"
                >
                  {isGenerating ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
                  {isGenerating ? "Scanning…" : "Scan"}
                </Button>
              </form>
              {generateErrorMessage !== null && (
                <p
                  className="text-sm text-destructive"
                  data-testid="brand-onboarding-generate-error"
                >
                  {generateErrorMessage}
                </p>
              )}
              {/*
                Secondary affordance on the primary step (owner spec): jump
                straight to the curated fallback without attempting a scrape.
              */}
              {previewKit === null && (
                <button
                  type="button"
                  onClick={() => setPhase("archetypes")}
                  className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  data-testid="brand-onboarding-no-website"
                >
                  I don&apos;t have a website
                </button>
              )}
            </section>

            {previewKit !== null && (
              <section
                className="flex flex-col gap-3 rounded-lg border p-4"
                data-testid="brand-onboarding-preview"
              >
                <span className="text-sm font-medium">{previewKit.name}</span>
                <div className="flex flex-wrap gap-2">
                  {previewKit.variations.map((variation) => (
                    <ThemeSwatch key={variation.id} globals={variation.globals} />
                  ))}
                </div>
                {savePreviewErrorMessage !== null && (
                  <p className="text-sm text-destructive" data-testid="brand-onboarding-save-error">
                    {savePreviewErrorMessage}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => void saveScrapedKit()}
                    disabled={isSavingPreview}
                    data-testid="brand-onboarding-save-button"
                  >
                    {isSavingPreview && <Loader2Icon className="animate-spin" />}
                    Use this brand
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={discardPreview}
                    disabled={isSavingPreview}
                  >
                    Try a different URL
                  </Button>
                </div>
              </section>
            )}
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold">Start with a curated look</h2>
              <p className="text-sm text-muted-foreground">
                {generateErrorMessage !== null
                  ? "We couldn't read that site — pick one of these instead. It's a real brand kit: edit the colors, fonts, logo and everything else about it any time."
                  : "Pick one of these as your brand. It's a real brand kit — edit the colors, fonts, logo and everything else about it any time."}
              </p>
            </div>

            <section className="flex flex-col gap-2" data-testid="brand-onboarding-archetypes">
              {getStarterArchetypes().map((archetype) => {
                const isSavingThis = savingArchetypeName === archetype.name;
                const isAnotherSaving =
                  savingArchetypeName !== null && savingArchetypeName !== archetype.name;
                return (
                  <button
                    key={archetype.name}
                    type="button"
                    onClick={() => void saveArchetype(archetype)}
                    disabled={savingArchetypeName !== null}
                    className="flex items-center gap-3 rounded-lg border p-3 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    data-testid={`brand-onboarding-archetype-${archetype.name.toLowerCase()}`}
                  >
                    <ThemeSwatch globals={archetype.variations[0]?.globals} />
                    <span className="min-w-0 flex-1 truncate font-medium">{archetype.name}</span>
                    {isSavingThis && <Loader2Icon className="size-4 shrink-0 animate-spin" />}
                    {isAnotherSaving && <span className="sr-only">Another brand is saving</span>}
                  </button>
                );
              })}
              {saveArchetypeErrorMessage !== null && (
                <p
                  className="text-sm text-destructive"
                  data-testid="brand-onboarding-archetype-error"
                >
                  {saveArchetypeErrorMessage}
                </p>
              )}
            </section>

            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setPhase("url")}
              disabled={savingArchetypeName !== null}
              data-testid="brand-onboarding-back-to-url"
            >
              Try a website instead
            </Button>
          </>
        )}

        <div className="flex justify-end border-t pt-4">
          {/*
            Low-emphasis, always-available escape (owner: never a hard
            trap). Ghost variant, last in tab order, on every phase.
          */}
          <Button variant="ghost" size="sm" onClick={dismiss} data-testid="brand-onboarding-skip">
            Continue without a brand
          </Button>
        </div>
      </div>
    </div>
  );
}
