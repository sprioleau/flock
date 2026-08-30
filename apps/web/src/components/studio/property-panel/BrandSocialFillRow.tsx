"use client";

import { useState } from "react";
import { Share2Icon } from "lucide-react";
import type { BlockId } from "@flock/email-sdk";
import { Button } from "@/components/ui/button";
import { buildSocialFillUpdates, hasSocialRow } from "@/lib/brand-kit-social-fill";
import type { BrandSocialLink, SocialPlatform } from "@/lib/social-links";
import { useEditorStore } from "@/lib/editor-store";
import { useActiveBrandKit } from "../brand-kit/useActiveBrandKit";

/*
  "Brand social links" row on the SECTION panel (item 26, part 3 — see the
  semantics note in lib/brand-kit-social-fill.ts): shown only when this
  section contains a social row AND the active kit carries social links.
  Clicking rebuilds the section's social links from the kit — ordinary
  user-authored dispatches (undoable); nothing ever syncs behind the user's
  back, and manual editing stays untouched otherwise.
*/
export function BrandSocialFillRow({ sectionId }: { sectionId: BlockId }) {
  const doc = useEditorStore((state) => state.doc);
  const dispatch = useEditorStore((state) => state.dispatch);
  const endCoalescing = useEditorStore((state) => state.endCoalescing);
  const { brandKit, hasSavedKit } = useActiveBrandKit();
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const socialLinks: BrandSocialLink[] = (hasSavedKit ? (brandKit.socialLinks ?? []) : []).map(
    ({ platform, url }) => ({ platform: platform as SocialPlatform, url }),
  );
  const isFillable = socialLinks.length > 0 && hasSocialRow({ doc, sectionId });
  if (!isFillable) {
    return null;
  }

  const fillFromBrandKit = (): void => {
    const updates = buildSocialFillUpdates({ doc, sectionId, socialLinks });
    if (updates.length === 0) {
      setStatusMessage("These links already match your brand kit.");
      return;
    }
    for (const { blockId, properties } of updates) {
      dispatch({ name: "updateBlockProperties", blockId, properties });
    }
    endCoalescing();
    setStatusMessage("Links updated from your brand kit.");
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">Brand social links</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={fillFromBrandKit}
        data-testid="brand-social-fill-button"
      >
        <Share2Icon />
        Fill from brand kit
      </Button>
      {statusMessage !== null && (
        <p className="text-xs text-muted-foreground" data-testid="brand-social-fill-status">
          {statusMessage}
        </p>
      )}
    </div>
  );
}
