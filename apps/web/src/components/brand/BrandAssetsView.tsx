"use client";

import { useQuery } from "convex/react";
import Image from "next/image";
import { api } from "@convex/_generated/api";
import type { BrandKit } from "@/lib/brand-kit";

function IdentityAssetCard({ label, url }: { label: string; url: string }) {
  return (
    <li className="overflow-hidden rounded-lg border bg-background">
      <div className="relative h-36 bg-white p-4">
        <Image
          src={url}
          alt={label}
          fill
          sizes="(min-width: 640px) 30vw, 100vw"
          className="object-contain p-4"
          unoptimized
        />
      </div>
      <p className="border-t px-3 py-2 text-sm font-medium">{label}</p>
    </li>
  );
}

export function BrandAssetsView({
  sessionId,
  brandKit,
}: {
  sessionId: string | null;
  brandKit: BrandKit;
}) {
  const assets = useQuery(
    api.assets.listForSession,
    sessionId === null ? "skip" : { sessionId },
  );
  const identityAssets = [
    brandKit.logoUrl === undefined
      ? null
      : { label: "Logo", url: brandKit.logoUrl },
    brandKit.faviconUrl === undefined
      ? null
      : { label: "Favicon", url: brandKit.faviconUrl },
    brandKit.socialImageUrl === undefined
      ? null
      : { label: "Social card", url: brandKit.socialImageUrl },
  ].filter((asset): asset is { label: string; url: string } => asset !== null);
  const scrapedAssets = (assets ?? []).filter((asset) => asset.kind === "scraped");

  return (
    <div className="flex flex-col gap-8" data-testid="brand-assets-view">
      <section aria-labelledby="brand-identity-assets-heading">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2
            id="brand-identity-assets-heading"
            className="text-base font-semibold"
          >
            Identity assets
          </h2>
          <span className="text-xs text-muted-foreground">
            From the saved brand kit
          </span>
        </div>
        {identityAssets.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            No logo, favicon, or social card has been captured yet.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-3">
            {identityAssets.map((asset) => (
              <IdentityAssetCard key={asset.label} {...asset} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="brand-scraped-assets-heading">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2
            id="brand-scraped-assets-heading"
            className="text-base font-semibold"
          >
            Images from the brand site
          </h2>
          <span className="text-xs text-muted-foreground">
            {assets === undefined
              ? "Loading…"
              : `${scrapedAssets.length} captured`}
          </span>
        </div>
        {assets === undefined ? (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            Loading captured images…
          </p>
        ) : scrapedAssets.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            Images selected during a brand scrape will appear here.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {scrapedAssets.map((asset) => (
              <li
                key={asset._id}
                className="overflow-hidden rounded-lg border bg-background"
              >
                <div className="relative aspect-[4/3] bg-white">
                  <Image
                    src={asset.url}
                    alt={asset.alt ?? asset.name}
                    fill
                    sizes="(min-width: 1024px) 30vw, (min-width: 640px) 50vw, 100vw"
                    className="object-contain p-3"
                    unoptimized
                  />
                </div>
                <div className="border-t px-3 py-2">
                  <p
                    className="truncate text-sm font-medium"
                    title={asset.name}
                  >
                    {asset.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Scraped from the brand site
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
