import type { BrandColor, BrandImageStyleDoc } from "./brand-kit";

export interface BrandGenerationAsset {
  name: string;
  kind: string;
  url: string;
  width?: number;
  height?: number;
}

export interface BrandGenerationContext {
  brandName: string;
  sourceUrl?: string;
  fonts: { heading: string; body: string };
  colors: BrandColor[];
  imageStyleDoc?: BrandImageStyleDoc;
  assets: BrandGenerationAsset[];
}
