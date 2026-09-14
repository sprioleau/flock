"use client";

export interface BrandSourceScreenshotReference {
  dataUrl: string;
  mediaType: "image/jpeg";
  width: number;
  height: number;
  byteLength: number;
}

export interface BrandSourceImageReference {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
}

export interface BrandSourceReferenceSelection {
  url: string;
  label: string;
}

function sourceLabel(sourceUrl: string | undefined): string {
  if (sourceUrl === undefined) {
    return "the scanned website";
  }
  try {
    return new URL(sourceUrl).hostname;
  } catch {
    return "the scanned website";
  }
}

function representativeSourceImages(
  sourceImages: BrandSourceImageReference[] | undefined,
): BrandSourceImageReference[] {
  if (sourceImages === undefined) {
    return [];
  }
  const seenUrls = new Set<string>();
  return sourceImages
    .filter((image) => {
      const url = image.url.trim();
      if (url.length === 0 || seenUrls.has(url)) {
        return false;
      }
      seenUrls.add(url);
      return true;
    })
    .slice(0, 5);
}

export function BrandSourceReferences({
  sourceUrl,
  sourceScreenshot,
  sourceImages,
  onEnlarge,
}: {
  sourceUrl?: string;
  sourceScreenshot?: BrandSourceScreenshotReference;
  sourceImages?: BrandSourceImageReference[];
  onEnlarge: (selection: BrandSourceReferenceSelection) => void;
}) {
  const images = representativeSourceImages(sourceImages);
  if (sourceScreenshot === undefined && images.length === 0) {
    return null;
  }

  const websiteLabel = sourceLabel(sourceUrl);
  return (
    <section className="flex flex-col gap-2" aria-label="Source references">
      <div className="flex flex-col gap-0.5">
        <h4 className="text-xs font-medium tracking-wide text-muted-foreground">
          Source references
        </h4>
        <p className="text-xs text-muted-foreground">
          Visuals captured from {websiteLabel} and used to ground this kit.
        </p>
      </div>

      {sourceScreenshot !== undefined && (
        <figure className="overflow-hidden rounded-lg border bg-muted">
          <button
            type="button"
            className="block aspect-[16/7] w-full cursor-zoom-in overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            aria-label={`View page screenshot of ${websiteLabel} larger`}
            onClick={() =>
              onEnlarge({
                url: sourceScreenshot.dataUrl,
                label: `Page screenshot of ${websiteLabel}`,
              })
            }
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={sourceScreenshot.dataUrl}
              alt={`Page screenshot of ${websiteLabel}`}
              className="size-full object-cover object-top"
              data-testid="brand-source-screenshot"
            />
          </button>
          <figcaption className="border-t bg-background px-3 py-2 text-xs font-medium">
            Page screenshot
          </figcaption>
        </figure>
      )}

      {images.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="brand-source-images">
          {images.map((image, index) => {
            const label = `Source image ${index + 1}`;
            const alt = image.alt?.trim() || `${label} from ${websiteLabel}`;
            return (
              <figure key={image.url} className="min-w-0 overflow-hidden rounded-md border bg-muted">
                <button
                  type="button"
                  className="block aspect-square w-full cursor-zoom-in overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  aria-label={`View ${label.toLowerCase()} larger`}
                  onClick={() => onEnlarge({ url: image.url, label })}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.url} alt={alt} className="size-full object-cover" />
                </button>
                <figcaption className="truncate border-t bg-background px-2 py-1.5 text-[11px] text-muted-foreground">
                  {label}
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
    </section>
  );
}
