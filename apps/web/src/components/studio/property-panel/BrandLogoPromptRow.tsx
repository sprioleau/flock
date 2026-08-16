"use client";

import { useState } from "react";
import { ImageIcon } from "lucide-react";
import type { BlockId } from "@flock/email-sdk";
import { Button } from "@/components/ui/button";
import { getConfirmedBrandAssetUrl } from "@/lib/brand-kit";
import {
  buildLogoBlockUpdates,
  describeLogoApplyScope,
  getLogoBlockPromptState,
} from "@/lib/brand-logo-blocks";
import { useEditorStore } from "@/lib/editor-store";
import { requestUiSurfaceOpen } from "@/lib/ui-surfaces";
import { useActiveBrandKit } from "../brand-kit/useActiveBrandKit";

/*
  "Brand logo" row on the IMAGE panel, shown only for blocks marked
  `role: "logo"` (brand-kit-v2 §5).

  The problem it solves: a logo block whose brand kit has no logo — or has one
  that was never confirmed into Convex storage — is silently inert. Brand
  propagation skips it, and nothing anywhere says why. §5's answer is that the
  ask belongs IN PLACE, in the selected block's properties panel: not a toast,
  not a separate screen. So each of the three states gets a button that opens
  the brand kit modal at the step that fixes it.

  The fourth state — a confirmed logo this block is not using — is where
  "apply to all logo blocks" lives. It mirrors the shape of
  `applyBrandToDocuments`: the scope is named with a count before it runs, it
  is one deliberate gesture, and it lands as ordinary user-authored dispatches
  coalesced into ONE undo entry (`endCoalescing` closes the gesture), so a
  three-block apply is one press to undo rather than three.

  All state selection is in lib/brand-logo-blocks.ts with unit tests; this is
  the renderer.
*/
export function BrandLogoPromptRow({ blockId }: { blockId: BlockId }) {
  const doc = useEditorStore((state) => state.doc);
  const dispatch = useEditorStore((state) => state.dispatch);
  const endCoalescing = useEditorStore((state) => state.endCoalescing);
  const { brandKit, hasSavedKit } = useActiveBrandKit();
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const confirmedLogoUrl = getConfirmedBrandAssetUrl({ brandKit, kind: "logo" });
  const confirmedLogo =
    confirmedLogoUrl === null ? null : { src: confirmedLogoUrl, alt: `${brandKit.name} logo` };
  const state = getLogoBlockPromptState({
    hasSavedKit,
    logoUrl: hasSavedKit ? brandKit.logoUrl : undefined,
    confirmedLogo,
    doc,
    blockId,
  });

  /* Apply the confirmed logo to one block or to every logo block, in one gesture. */
  const applyLogo = (blockIds: BlockId[] | undefined): void => {
    if (confirmedLogo === null) {
      return;
    }
    const updates = buildLogoBlockUpdates({ doc, logo: confirmedLogo, blockIds });
    if (updates.length === 0) {
      setStatusMessage("Already using your brand logo.");
      return;
    }
    for (const { blockId: targetId, properties } of updates) {
      dispatch({ name: "updateBlockProperties", blockId: targetId, properties });
    }
    endCoalescing();
    setStatusMessage(
      updates.length === 1
        ? "Updated from your brand kit."
        : `Updated ${updates.length} logo blocks from your brand kit.`,
    );
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid="brand-logo-prompt">
      <span className="text-xs font-medium text-muted-foreground">Brand logo</span>
      {state.kind === "no-kit" && (
        <>
          <p className="text-xs text-muted-foreground">
            This block is marked as your logo, but this canvas has no brand kit yet.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => requestUiSurfaceOpen("brand-kit")}
            data-testid="brand-logo-prompt-open-kit"
          >
            <ImageIcon />
            Set up your brand kit
          </Button>
        </>
      )}
      {state.kind === "no-logo" && (
        <>
          <p className="text-xs text-muted-foreground">
            Your brand kit doesn&apos;t have a logo yet. Add one and every logo block can use it.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => requestUiSurfaceOpen("brand-kit")}
            data-testid="brand-logo-prompt-add-logo"
          >
            <ImageIcon />
            Add a logo to your brand kit
          </Button>
        </>
      )}
      {state.kind === "unconfirmed" && (
        <>
          {/* Deliberately not offered as "use it anyway": an unconfirmed logo is
              still a third-party URL that has not been rehosted into our
              storage, so it may never enter a document (owner decision 4). */}
          <p className="text-xs text-muted-foreground">
            Your brand kit has a suggested logo that isn&apos;t saved yet. Confirm it and it becomes
            usable here.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => requestUiSurfaceOpen("brand-kit")}
            data-testid="brand-logo-prompt-confirm-logo"
          >
            <ImageIcon />
            Confirm your logo
          </Button>
        </>
      )}
      {state.kind === "ready" && state.staleBlockCount === 0 && (
        <p className="text-xs text-muted-foreground" data-testid="brand-logo-prompt-current">
          Using your brand kit&apos;s logo.
        </p>
      )}
      {state.kind === "ready" && state.staleBlockCount > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {!state.isBlockUsingLogo && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => applyLogo([blockId])}
              data-testid="brand-logo-prompt-apply-one"
            >
              <ImageIcon />
              Use brand logo
            </Button>
          )}
          {/* Only worth its own button when it would reach past this block. */}
          {(state.staleBlockCount > 1 || state.isBlockUsingLogo) && (
            <Button
              type="button"
              variant={state.isBlockUsingLogo ? "outline" : "ghost"}
              size="sm"
              onClick={() => applyLogo(undefined)}
              data-testid="brand-logo-prompt-apply-all"
            >
              {describeLogoApplyScope(state.staleBlockCount)}
            </Button>
          )}
        </div>
      )}
      {statusMessage !== null && (
        <p className="text-xs text-muted-foreground" data-testid="brand-logo-prompt-status">
          {statusMessage}
        </p>
      )}
    </div>
  );
}
