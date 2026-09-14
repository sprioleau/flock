"use client";

/* eslint-disable @next/next/no-img-element -- verified external brand assets have arbitrary hosts */

import { PaletteIcon, TriangleAlertIcon } from "lucide-react";
import type { BrandKit } from "@/lib/brand-kit";
import { getBrandKitPalette } from "@/lib/brand-kit";
import { requestUiSurfaceOpen } from "@/lib/ui-surfaces";
import { cn } from "@/lib/utils";
import { ArtifactProgressSteps } from "./ArtifactProgressSteps";

export interface BrandKitGenerationJobView {
  sourceUrl: string;
  status: "queued" | "running" | "succeeded" | "failed";
  step: "queued" | "reading-site" | "finding-identity" | "building-kit" | "saving-kit" | "complete";
  errorMessage?: string;
}

const STEPS = [
  { id: "reading-site", label: "Opened the website" },
  { id: "finding-identity", label: "Found the visual identity" },
  { id: "building-kit", label: "Built colors, fonts and imagery" },
  { id: "saving-kit", label: "Saved the brand kit" },
] as const;

const STEP_INDEX: Record<BrandKitGenerationJobView["step"], number> = {
  queued: -1,
  "reading-site": 0,
  "finding-identity": 1,
  "building-kit": 2,
  "saving-kit": 3,
  complete: 4,
};

const IMAGE_POSITIONS = [
  "left-[15%] top-16 -rotate-12 z-10 group-hover/artifact:left-[2%] group-hover/artifact:top-20 group-hover/artifact:-rotate-[18deg]",
  "left-[27%] top-11 -rotate-6 z-20 group-hover/artifact:left-[20%] group-hover/artifact:top-12 group-hover/artifact:-rotate-9",
  "left-1/2 top-9 -translate-x-1/2 z-40 group-hover/artifact:top-5",
  "right-[27%] top-11 rotate-6 z-20 group-hover/artifact:right-[20%] group-hover/artifact:top-12 group-hover/artifact:rotate-9",
  "right-[15%] top-16 rotate-12 z-10 group-hover/artifact:right-[2%] group-hover/artifact:top-20 group-hover/artifact:rotate-[18deg]",
] as const;

function IdentityImage({ label, url }: { label: string; url: string | undefined }) {
  if (url === undefined) {
    return null;
  }
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-md border bg-background/80 px-2 py-1.5">
      <img src={url} alt="" className="size-5 rounded object-contain" />
      <span className="truncate text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}

function GenerationSteps({ job }: { job: BrandKitGenerationJobView }) {
  return (
    <ArtifactProgressSteps
      steps={STEPS}
      currentIndex={STEP_INDEX[job.step]}
      status={job.status}
      label="Brand kit scan progress"
    />
  );
}

export function BrandKitChatArtifact({
  job,
  brandKit,
}: {
  job: BrandKitGenerationJobView;
  brandKit?: BrandKit;
}) {
  const hostname = (() => {
    try {
      return new URL(job.sourceUrl).hostname;
    } catch {
      return job.sourceUrl;
    }
  })();
  const sourceImages = brandKit?.sourceImages?.slice(0, 5) ?? [];
  const palette = brandKit === undefined ? [] : getBrandKitPalette(brandKit).slice(0, 7);
  const hasCompletedKit = job.status === "succeeded" && brandKit !== undefined;

  return (
    <section className="rounded-xl border bg-muted/20 p-3 shadow-sm" data-testid="brand-kit-chat-artifact">
      <div className="mb-3 flex items-start gap-2">
        <PaletteIcon className="mt-0.5 size-4 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Add a brand kit based on {hostname}</p>
          <p className="text-xs text-muted-foreground">
            {hasCompletedKit ? "Finished brand setup · ready to use" : "Building in the background"}
          </p>
        </div>
        {job.status === "failed" && <TriangleAlertIcon className="size-4 text-destructive" />}
      </div>

      <GenerationSteps job={job} />

      {job.status === "failed" ? (
        <p className="mt-3 rounded-md bg-destructive/5 p-2 text-xs text-destructive">
          {job.errorMessage ?? "The website could not be scanned."}
        </p>
      ) : hasCompletedKit ? (
        <button
          type="button"
          className="group/artifact mt-3 w-full overflow-hidden rounded-lg border bg-background text-left transition-shadow hover:shadow-md"
          onClick={() => requestUiSurfaceOpen("brand-kit")}
          aria-label={`Open ${brandKit.name} brand kit`}
        >
          <div className="flex items-center gap-2 px-3 pt-3">
            {brandKit.logoUrl !== undefined && (
              <img src={brandKit.logoUrl} alt="" className="size-8 rounded-md object-contain" />
            )}
            <span className="truncate text-sm font-semibold">{brandKit.name}</span>
          </div>
          <div className="grid grid-cols-3 gap-1.5 px-3 pt-2">
            <IdentityImage label="Logo" url={brandKit.logoUrl} />
            <IdentityImage label="Favicon" url={brandKit.faviconUrl} />
            <IdentityImage label="Social card" url={brandKit.socialImageUrl} />
          </div>
          {sourceImages.length > 0 && (
            <div className="relative h-36 overflow-hidden" aria-label="Representative brand images">
              {sourceImages.map((image, index) => (
                <img
                  key={image.url}
                  src={image.url}
                  alt={image.alt ?? `Brand image ${index + 1}`}
                  className={cn(
                    "absolute size-[74px] rounded-xl border-2 border-background bg-white object-cover shadow-md",
                    "transition-all duration-300 ease-out hover:-translate-y-1.5 hover:scale-105 hover:z-50",
                    IMAGE_POSITIONS[index],
                  )}
                />
              ))}
            </div>
          )}
          <div className="flex h-4 overflow-hidden rounded-b-lg" aria-label="Brand color palette">
            {palette.map((swatch) => (
              <span
                key={swatch.color}
                className="min-w-5 flex-1"
                style={{ backgroundColor: swatch.color }}
                title={swatch.color}
              />
            ))}
          </div>
          <p className="px-3 py-2 text-xs font-medium text-muted-foreground group-hover/artifact:text-foreground">
            View your brand ↗
          </p>
        </button>
      ) : null}
    </section>
  );
}
