import { describe, expect, it, vi } from "vitest";
import type { BrandSourceImage } from "@/lib/brand-kit";
import {
  type BrandSignals,
  harvestBrandSignals,
} from "./harvest";
import { collectBrandEvidence } from "./collect-brand-evidence";

function createDeferred<Value>() {
  let resolvePromise: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolvePromise };
}

function createSignals(): BrandSignals {
  return {
    siteName: "Evidence",
    pageTitle: "Evidence page",
    themeColor: null,
    fontFamilies: [],
    rankedColors: [],
    accentCandidates: [],
    logoCandidates: [],
  };
}

describe("collectBrandEvidence", () => {
  it("starts CSS harvesting and source-image selection before either finishes, then preserves both results", async () => {
    const signals = createSignals();
    const sourceImages: BrandSourceImage[] = [
      { url: "https://example.com/first.png", alt: "First" },
      { url: "https://example.com/second.png", alt: "Second" },
    ];
    const signalsDeferred = createDeferred<BrandSignals>();
    const imagesDeferred = createDeferred<BrandSourceImage[]>();
    const harvestSignals = vi.fn(() => signalsDeferred.promise);
    const selectImages = vi.fn(() => imagesDeferred.promise);

    const evidencePromise = collectBrandEvidence(
      {
        html: "<html><head></head><body></body></html>",
        finalUrl: "https://example.com/",
      },
      { dependencies: { harvestSignals, selectImages } },
    );

    expect(harvestSignals).toHaveBeenCalledTimes(1);
    expect(selectImages).toHaveBeenCalledTimes(1);
    signalsDeferred.resolvePromise(signals);
    imagesDeferred.resolvePromise(sourceImages);

    await expect(evidencePromise).resolves.toEqual({ signals, sourceImages });
  });

  it("passes rendered colors and the injected guarded CSS fetcher through to signal harvesting", async () => {
    const signals = createSignals();
    const sourceImages: BrandSourceImage[] = [
      { url: "https://example.com/card.png", alt: "Card" },
    ];
    const renderedColors = [{ value: "#123456", count: 4 }];
    const fetchCss = vi.fn(async (url: string) => `/* fetched ${url} */`);
    const harvestSignals = vi.fn(
      async ({ fetchCss: passedFetchCss }: Parameters<typeof harvestBrandSignals>[0]) => {
        if (passedFetchCss === null) {
          throw new Error("expected the CSS fetcher to remain available");
        }
        expect(await passedFetchCss("https://example.com/site.css")).toBe(
          "/* fetched https://example.com/site.css */",
        );
        return signals;
      },
    );
    const selectImages = vi.fn(async () => sourceImages);

    const evidence = await collectBrandEvidence(
      {
        html: "<html><head></head><body></body></html>",
        finalUrl: "https://example.com/page",
        renderedColors,
      },
      { dependencies: { harvestSignals, selectImages, fetchCss } },
    );

    expect(harvestSignals).toHaveBeenCalledWith({
      html: "<html><head></head><body></body></html>",
      finalUrl: "https://example.com/page",
      fetchCss,
      renderedColors,
    });
    expect(selectImages).toHaveBeenCalledWith({
      html: "<html><head></head><body></body></html>",
      finalUrl: "https://example.com/page",
    });
    expect(fetchCss).toHaveBeenCalledWith("https://example.com/site.css");
    expect(evidence).toEqual({ signals, sourceImages });
  });
});
