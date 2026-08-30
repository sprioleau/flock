"use client";

import { useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getAvailableSocialPlatforms,
  isKnownSocialPlatform,
  type SocialLinkDraft,
} from "@/lib/brand-social-links";
import { SOCIAL_PLATFORM_LABELS, SOCIAL_PLATFORM_ORDER } from "@/lib/social-links";

/*
  The kit's social links, editable (brand-kit-user-control §7.2).

  Until now this array was the only human-facing kit field with no edit path:
  extracted, displayed, handed to the agent, and unchangeable. A brand whose
  LinkedIn the scrape missed, or whose footer linked someone's personal
  account, had nothing to do about it.

  One row per platform, because the stored shape holds one per platform — a
  second X row would be silently discarded on save, and a control that eats
  what you typed is worse than one that never offered the row. The platform
  select on each row therefore offers only platforms no other row claims.

  Validation lives in lib/brand-social-links.ts and runs again server-side; the
  rows here commit as one whole-array write on blur/Enter/add/remove, the same
  shape BrandColorsEditor uses for the palette.
*/
export function BrandSocialLinksEditor({
  socialLinks,
  isBusy,
  onCommit,
}: {
  socialLinks: { platform: string; url: string }[];
  isBusy: boolean;
  onCommit: (drafts: SocialLinkDraft[]) => void;
}) {
  /*
    Stored rows whose platform this build does not know (a legacy key) are
    dropped from the editor rather than rendered as a broken select — they
    cannot be represented by any option, and keeping them would mean the first
    save silently rewrote them anyway.
  */
  const storedDrafts: SocialLinkDraft[] = socialLinks.flatMap((link) =>
    isKnownSocialPlatform(link.platform) ? [{ platform: link.platform, url: link.url }] : [],
  );

  const [draftRows, setDraftRows] = useState<SocialLinkDraft[]>(storedDrafts);

  /*
    Reactive resync, adjusted DURING render (the BrandColorsEditor idiom): a
    save, a re-scrape or another tab re-seeds the rows. An effect would paint
    the stale list first and correct it after.
  */
  const serializedLinks = JSON.stringify(storedDrafts);
  const [seededFrom, setSeededFrom] = useState(serializedLinks);
  if (seededFrom !== serializedLinks) {
    setSeededFrom(serializedLinks);
    setDraftRows(storedDrafts);
  }

  const commit = (nextRows: SocialLinkDraft[]): void => {
    setDraftRows(nextRows);
    onCommit(nextRows);
  };

  const availablePlatforms = getAvailableSocialPlatforms(draftRows.map((row) => row.platform));

  const addRow = (): void => {
    const platform = availablePlatforms[0];
    if (platform === undefined) {
      return;
    }
    /*
      Added empty and NOT committed: an empty row is dropped by the planner,
      so committing here would be a write that stores nothing.
    */
    setDraftRows([...draftRows, { platform, url: "" }]);
  };

  return (
    <div className="flex flex-col gap-2" data-testid="brand-kit-social-links-editor">
      {draftRows.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No social links yet. Add the profiles you want in your footers.
        </p>
      )}
      <ul className="flex flex-col gap-1.5">
        {draftRows.map((row, rowIndex) => (
          <li key={row.platform} className="flex items-center gap-2">
            <select
              value={row.platform}
              aria-label={`Platform for link ${rowIndex + 1}`}
              className="h-8 shrink-0 rounded-lg border border-input bg-transparent px-1.5 text-xs outline-none focus-visible:border-ring"
              onChange={(event) => {
                const platform = event.target.value;
                if (!isKnownSocialPlatform(platform)) {
                  return;
                }
                commit(
                  draftRows.map((candidate, index) =>
                    index === rowIndex ? { ...candidate, platform } : candidate,
                  ),
                );
              }}
              disabled={isBusy}
              data-testid={`brand-kit-social-platform-${row.platform}`}
            >
              {SOCIAL_PLATFORM_ORDER.filter(
                (platform) => platform === row.platform || availablePlatforms.includes(platform),
              ).map((platform) => (
                <option key={platform} value={platform}>
                  {SOCIAL_PLATFORM_LABELS[platform]}
                </option>
              ))}
            </select>
            <Input
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={row.url}
              aria-label={`${SOCIAL_PLATFORM_LABELS[row.platform]} profile address`}
              placeholder={`https://${row.platform === "x" ? "x.com" : `${row.platform}.com`}/yourbrand`}
              className="h-8 min-w-0 flex-1 text-sm"
              onChange={(event) =>
                setDraftRows(
                  draftRows.map((candidate, index) =>
                    index === rowIndex ? { ...candidate, url: event.target.value } : candidate,
                  ),
                )
              }
              onBlur={() => commit(draftRows)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              disabled={isBusy}
              data-testid={`brand-kit-social-url-${row.platform}`}
            />
            <Button
              variant="ghost"
              size="sm"
              className="size-8 shrink-0 p-0 text-muted-foreground"
              aria-label={`Remove ${SOCIAL_PLATFORM_LABELS[row.platform]} link`}
              onClick={() => commit(draftRows.filter((_, index) => index !== rowIndex))}
              disabled={isBusy}
              data-testid={`brand-kit-social-remove-${row.platform}`}
            >
              <XIcon className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 self-start px-1.5 text-xs text-muted-foreground"
        onClick={addRow}
        disabled={isBusy || availablePlatforms.length === 0}
        data-testid="brand-kit-social-add"
      >
        <PlusIcon className="size-3" />
        Add a link
      </Button>
    </div>
  );
}
