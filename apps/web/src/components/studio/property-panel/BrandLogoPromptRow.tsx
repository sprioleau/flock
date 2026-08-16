"use client";

import { useState } from "react";
import { ImageIcon, Loader2Icon } from "lucide-react";
import type { BlockId } from "@flock/email-sdk";
import { Button } from "@/components/ui/button";
import { confirmBrandAsset } from "@/lib/brand-asset-confirm";
import { getConfirmedBrandAssetUrl } from "@/lib/brand-kit";
import {
  buildLogoBlockUpdates,
  describeLogoApplyScope,
  getLogoBlockPromptState,
} from "@/lib/brand-logo-blocks";
import { useEditorStore } from "@/lib/editor-store";
import { requestUiSurfaceOpen } from "@/lib/ui-surfaces";
import { useActiveBrandKit, useSessionBrandKit } from "../brand-kit/useActiveBrandKit";

/*
  "Brand logo" row on the IMAGE panel, shown only for blocks marked
  `role: "logo"` (brand-kit-v2 §5).

  The problem it solves: a logo block whose brand kit has no logo — or has one
  that was never confirmed into Convex storage — is silently inert. Brand
  propagation skips it, and nothing anywhere says why. §5's answer is that the
  ask belongs IN PLACE, in the selected block's properties panel: not a toast,
  not a separate screen.

  UNCONFIRMED IS THE STATE WORTH THE MOST CARE, and it is handled in place
  rather than by punting: the suggestion is SHOWN (a user cannot judge "is
  that our logo?" from a generic icon and a sentence) and confirmed with one
  press, through the same route the brand kit panel's asset card calls. Sending
  someone to another panel to hunt for the matching control was the old
  behaviour and it was the gap — the brand kit is still one demoted press away
  for anything more involved (replace it, remove it, type a different address).

  What confirming does NOT do is loosen decision 4: it makes the logo durable
  (fetch → SSRF rails → Convex storage → durable serving URL), and only then
  does the row's own `ready` state offer to put it in the document. There is no
  "use it anyway".

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
  const sessionId = useEditorStore((state) => state.authorId);
  const { brandKit, hasSavedKit, kitId } = useActiveBrandKit();
  /*
    The viewer's OWN kit, only to answer "is the canvas's kit mine?". The
    brand kit panel already holds this subscription, so Convex serves it from
    the same cached query rather than opening a second one.
  */
  const { kitId: sessionKitId } = useSessionBrandKit();
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmErrorMessage, setConfirmErrorMessage] = useState<string | null>(null);
  /*
    A suggestion is an arbitrary third-party address that may 404, expire, or
    refuse us. Without this the panel would sit there showing a browser's
    broken-image glyph next to "confirm this" — the one moment the picture is
    load-bearing.
  */
  const [hasPreviewFailed, setHasPreviewFailed] = useState(false);

  const confirmedLogoUrl = getConfirmedBrandAssetUrl({ brandKit, kind: "logo" });
  const confirmedLogo =
    confirmedLogoUrl === null ? null : { src: confirmedLogoUrl, alt: `${brandKit.name} logo` };
  const state = getLogoBlockPromptState({
    hasSavedKit,
    logoUrl: hasSavedKit ? brandKit.logoUrl : undefined,
    /* Session-scoped confirm: only the viewer's own kit row can be confirmed. */
    isViewerOwnKit: sessionId !== null && kitId !== null && kitId === sessionKitId,
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

  /*
    Rehost the suggestion into our storage, through the brand kit panel's own
    route wrapper. Nothing here touches the document: a success only makes the
    kit's logo durable, and the reactive kit query then re-renders this row in
    its `ready` state where applying is an explicit, separate press.
  */
  const confirmLogo = async (): Promise<void> => {
    if (sessionId === null || isConfirming) {
      return;
    }
    setIsConfirming(true);
    setConfirmErrorMessage(null);
    setStatusMessage(null);
    const outcome = await confirmBrandAsset({ sessionId, kind: "logo" });
    if (outcome.isOk) {
      setStatusMessage("Saved to your brand kit — you can use it here now.");
    } else {
      /* The route's own words: it saw the failure, this panel did not. */
      setConfirmErrorMessage(outcome.message);
    }
    setIsConfirming(false);
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
              storage, so it may never enter a document (owner decision 4).
              Confirming is what changes that, and it is one press away below. */}
          <p className="text-xs text-muted-foreground">
            Your brand kit has a suggested logo that isn&apos;t saved yet. Confirm it and it becomes
            usable here.
          </p>
          <div className="flex items-center gap-2">
            {hasPreviewFailed ? (
              <span
                className="flex size-14 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"
                data-testid="brand-logo-prompt-preview-failed"
              >
                <ImageIcon />
              </span>
            ) : (
              <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted p-1.5">
                {/* Plain <img>: the source is an arbitrary external host (or a
                    data:image/svg+xml URI) and next/image can optimize neither. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={state.suggestedLogoUrl}
                  alt={`Suggested logo for ${brandKit.name}`}
                  className="size-full object-contain"
                  onError={() => setHasPreviewFailed(true)}
                  data-testid="brand-logo-prompt-suggested-image"
                />
              </span>
            )}
            {hasPreviewFailed && (
              <p className="text-xs text-muted-foreground">
                That image didn&apos;t load from its original address — saving it may fail too.
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {state.isConfirmableHere ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void confirmLogo()}
                disabled={isConfirming}
                data-testid="brand-logo-prompt-confirm-logo"
              >
                {isConfirming ? <Loader2Icon className="animate-spin" /> : <ImageIcon />}
                {isConfirming ? "Saving…" : "Confirm this logo"}
              </Button>
            ) : (
              /* Somebody else's kit is on screen: confirming from here would
                 act on the viewer's own row, so the honest offer is the panel
                 where the kit's owner-facing controls live. */
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => requestUiSurfaceOpen("brand-kit")}
                data-testid="brand-logo-prompt-confirm-logo-in-kit"
              >
                <ImageIcon />
                Confirm it in the brand kit
              </Button>
            )}
            {/* Demoted, never removed: replacing the suggestion, removing it, or
                typing a different address all still live in the full panel.
                Held shut mid-rehost because the panel carries its own confirm
                button behind its own in-flight flag — the two surfaces would
                otherwise be able to fire the same rehost twice. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => requestUiSurfaceOpen("brand-kit")}
              disabled={isConfirming}
              data-testid="brand-logo-prompt-open-brand-kit"
            >
              Open brand kit
            </Button>
          </div>
          {confirmErrorMessage !== null && (
            <p className="text-xs text-destructive" data-testid="brand-logo-prompt-confirm-error">
              {confirmErrorMessage}
            </p>
          )}
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
