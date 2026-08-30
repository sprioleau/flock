"use client";

import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useState, useSyncExternalStore } from "react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandColorsEditor } from "@/components/studio/brand-kit/BrandColorsEditor";
import { BrandFontsEditor } from "@/components/studio/brand-kit/BrandFontsEditor";
import { BrandSocialLinksEditor } from "@/components/studio/brand-kit/BrandSocialLinksEditor";
import { BrandVoiceEditor, type BrandVoiceDraft } from "@/components/studio/brand-kit/BrandVoiceEditor";
import { EmailDesignDocEditor } from "@/components/studio/brand-kit/EmailDesignDocEditor";
import { MOCK_BRAND_KIT, type BrandColor, type BrandKit, type BrandKitFonts } from "@/lib/brand-kit";
import type { SocialLinkDraft } from "@/lib/brand-social-links";
import { getOrCreateSessionId } from "@/lib/session";
import { resolveBrandSection, type BrandSectionId } from "./brand-sections";

/*
  The content column of the /brand workspace: whichever section the URL
  resolved to, rendered against the viewer's ACTIVE brand kit.

  Session sourcing is the one thing that differs from the studio's brand modal.
  Inside /studio the kit is read through the editor store's `authorId`, but
  that store is a canvas thing and is unset here — so this page reads the
  anonymous session id straight from {@link getOrCreateSessionId} (the same
  source the studio seeds `authorId` from) and queries the active kit with it.
  Same identity, same kit, no canvas required.

  Every editor already exists as a self-contained, prop-driven component in the
  studio brand modal; this page reuses them verbatim and wires each `onCommit`
  to its mutation, exactly as BrandKitPanel does. The migration is a re-home,
  not a rewrite.
*/

const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/*
  The anonymous session id is a browser-only value (localStorage), so it must
  be null on the server and resolve on the client without a hydration mismatch.
  useSyncExternalStore is exactly that contract — server snapshot null, client
  snapshot the id — and, unlike a mount effect, it does not trip
  react-hooks/set-state-in-effect. getOrCreateSessionId returns the same string
  on every call, so the client snapshot is stable.
*/
function useSessionId(): string | null {
  return useSyncExternalStore(
    NOOP_SUBSCRIBE,
    () => getOrCreateSessionId(),
    () => null,
  );
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof ConvexError ? String(error.data) : fallback;
}

export function BrandSectionContent({ slug }: { slug: string }) {
  const section = resolveBrandSection(slug);
  const sessionId = useSessionId();

  const savedKit = useQuery(
    api.brandKits.getActiveBrandKit,
    sessionId !== null ? { sessionId } : "skip",
  );
  const hasSavedKit = savedKit !== undefined && savedKit !== null;
  const brandKit: BrandKit = hasSavedKit ? (savedKit as unknown as BrandKit) : MOCK_BRAND_KIT;

  const updateBrandColors = useMutation(api.brandKits.updateBrandColors);
  const updateBrandFonts = useMutation(api.brandKits.updateBrandFonts);
  const updateBrandToneOfVoice = useMutation(api.brandKits.updateBrandToneOfVoice);
  const updateSocialLinks = useMutation(api.brandKits.updateSocialLinks);
  const renameBrandKit = useMutation(api.brandKits.renameBrandKit);
  const clearBrandKit = useMutation(api.brandKits.clearBrandKit);
  const startDefaultBrandKit = useMutation(api.brandKits.startDefaultBrandKit);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(brandKit.name);
  const [isStartingKit, setIsStartingKit] = useState(false);

  /*
    Keep the name field in step with the loaded kit (it arrives async, and a
    save or re-scrape can change it) by reseeding DURING render when the stored
    name changes identity — the same sentinel pattern EmailDesignDocEditor
    uses, which avoids the set-state-in-effect the linter (rightly) rejects and
    never flashes the previous value.
  */
  const [seededName, setSeededName] = useState(brandKit.name);
  if (seededName !== brandKit.name) {
    setSeededName(brandKit.name);
    setNameDraft(brandKit.name);
  }

  const canEdit = hasSavedKit && sessionId !== null;

  async function runWrite(fallback: string, write: () => Promise<unknown>): Promise<void> {
    setErrorMessage(null);
    try {
      await write();
    } catch (error: unknown) {
      setErrorMessage(describeError(error, fallback));
    }
  }

  /*
    The whole workspace needs a real saved kit to write to (the email-design
    doc, the palette, the voice all live on the kit row). Until one exists,
    offer to seed the Flock starter kit — the same frictionless entry the
    studio modal offers — rather than showing editors that cannot save.
  */
  if (sessionId !== null && !hasSavedKit && savedKit !== undefined) {
    return (
      <SectionFrame section={section}>
        <div className="max-w-md rounded-lg border bg-muted/30 p-6">
          <p className="text-sm text-muted-foreground">
            You don&apos;t have a brand kit yet. Start one to edit its colors, fonts, voice,
            and email-design guidance here.
          </p>
          <Button
            className="mt-4"
            disabled={isStartingKit}
            onClick={() => {
              setIsStartingKit(true);
              void runWrite("Couldn't start a brand kit. Try again.", () =>
                startDefaultBrandKit({ sessionId }),
              ).finally(() => setIsStartingKit(false));
            }}
          >
            {isStartingKit ? "Starting…" : "Start a brand kit"}
          </Button>
          {errorMessage !== null && (
            <p className="mt-3 text-sm text-destructive">{errorMessage}</p>
          )}
        </div>
      </SectionFrame>
    );
  }

  return (
    <SectionFrame section={section}>
      {errorMessage !== null && (
        <p className="mb-4 text-sm text-destructive">{errorMessage}</p>
      )}
      {renderSection({
        sectionId: section.id,
        brandKit,
        sessionId,
        canEdit,
        nameDraft,
        setNameDraft,
        commit: {
          colors: (colors: BrandColor[]) =>
            runWrite("Couldn't save those colors. Try again.", () =>
              updateBrandColors({ sessionId: sessionId as string, colors }),
            ),
          fonts: (fonts) =>
            runWrite("Couldn't save that font. Try again.", () =>
              updateBrandFonts({ sessionId: sessionId as string, fonts }),
            ),
          voice: (draft) =>
            runWrite("Couldn't save the tone of voice. Try again.", () =>
              updateBrandToneOfVoice({ sessionId: sessionId as string, toneOfVoice: draft }),
            ),
          social: (drafts) =>
            runWrite("Couldn't save those links. Try again.", () =>
              updateSocialLinks({ sessionId: sessionId as string, socialLinks: drafts }),
            ),
          rename: () =>
            runWrite("Couldn't rename the kit. Try again.", () =>
              renameBrandKit({ sessionId: sessionId as string, name: nameDraft.trim() }),
            ),
          reset: () =>
            runWrite("Couldn't reset the kit. Try again.", () =>
              clearBrandKit({ sessionId: sessionId as string }),
            ),
        },
      })}
    </SectionFrame>
  );
}

function SectionFrame({
  section,
  children,
}: {
  section: ReturnType<typeof resolveBrandSection>;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">{section.label}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>
      </header>
      {children}
    </div>
  );
}

interface SectionCommitHandlers {
  colors: (colors: BrandColor[]) => Promise<void>;
  fonts: (fonts: BrandKitFonts) => Promise<void>;
  voice: (draft: BrandVoiceDraft) => Promise<void>;
  social: (drafts: SocialLinkDraft[]) => Promise<void>;
  rename: () => Promise<void>;
  reset: () => Promise<void>;
}

function renderSection({
  sectionId,
  brandKit,
  sessionId,
  canEdit,
  nameDraft,
  setNameDraft,
  commit,
}: {
  sectionId: BrandSectionId;
  brandKit: BrandKit;
  sessionId: string | null;
  canEdit: boolean;
  nameDraft: string;
  setNameDraft: (value: string) => void;
  commit: SectionCommitHandlers;
}) {
  switch (sectionId) {
    case "email-design":
      return (
        <EmailDesignDocEditor
          sessionId={sessionId}
          emailDesignDoc={brandKit.emailDesignDoc}
          colors={brandKit.colors ?? []}
        />
      );
    case "identity":
      return (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="brand-name">Brand name</Label>
            <div className="flex gap-2">
              <Input
                id="brand-name"
                value={nameDraft}
                disabled={!canEdit}
                onChange={(event) => setNameDraft(event.target.value)}
              />
              <Button
                variant="secondary"
                disabled={!canEdit || nameDraft.trim().length === 0}
                onClick={() => void commit.rename()}
              >
                Save
              </Button>
            </div>
          </div>
          {brandKit.sourceUrl !== undefined && (
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">Scraped from</span>
              <span className="text-sm text-muted-foreground">{brandKit.sourceUrl}</span>
            </div>
          )}
          <div className="border-t pt-6">
            <Button
              variant="outline"
              disabled={!canEdit}
              onClick={() => void commit.reset()}
            >
              Reset to default
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              Clears your saved kit and drops every section back to the Flock starter.
            </p>
          </div>
        </div>
      );
    case "colors":
      return (
        <BrandColorsEditor
          colors={brandKit.colors ?? []}
          isBusy={!canEdit}
          onCommit={(colors) => void commit.colors(colors)}
        />
      );
    case "fonts":
      return <BrandFontsEditor fonts={brandKit.fonts} onCommit={(fonts) => void commit.fonts(fonts)} />;
    case "voice":
      return (
        <BrandVoiceEditor
          brandName={brandKit.name}
          toneOfVoice={brandKit.toneOfVoice}
          isBusy={!canEdit}
          onCommit={(draft) => void commit.voice(draft)}
        />
      );
    case "links":
      return (
        <BrandSocialLinksEditor
          socialLinks={(brandKit.socialLinks ?? []).map((link) => ({
            platform: link.platform,
            url: link.url,
          }))}
          isBusy={!canEdit}
          onCommit={(drafts) => void commit.social(drafts)}
        />
      );
  }
}
