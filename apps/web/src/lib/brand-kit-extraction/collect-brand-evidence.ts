import { fetchTextResource } from "./fetch-page";
import {
  harvestBrandSignals,
  type BrandSignals,
  type CssFetcher,
  type RenderedColorSignal,
} from "./harvest";
import {
  selectRepresentativeSourceImages,
} from "./source-image-evidence";
import type { BrandSourceImage } from "@/lib/brand-kit";

export interface BrandEvidence {
  signals: BrandSignals;
  sourceImages: BrandSourceImage[];
}

interface CollectBrandEvidenceInput {
  html: string;
  finalUrl: string;
  renderedColors?: RenderedColorSignal[];
}

interface CollectBrandEvidenceDependencies {
  harvestSignals: typeof harvestBrandSignals;
  selectImages: typeof selectRepresentativeSourceImages;
  fetchCss: CssFetcher;
}

export async function collectBrandEvidence(
  { html, finalUrl, renderedColors = [] }: CollectBrandEvidenceInput,
  options: { dependencies?: Partial<CollectBrandEvidenceDependencies> } = {},
): Promise<BrandEvidence> {
  const dependencies: CollectBrandEvidenceDependencies = {
    harvestSignals: harvestBrandSignals,
    selectImages: selectRepresentativeSourceImages,
    fetchCss: (url) => fetchTextResource({ url }),
    ...options.dependencies,
  };

  const [signals, sourceImages] = await Promise.all([
    dependencies.harvestSignals({ html, finalUrl, fetchCss: dependencies.fetchCss, renderedColors }),
    dependencies.selectImages({ html, finalUrl }),
  ]);

  return { signals, sourceImages };
}
