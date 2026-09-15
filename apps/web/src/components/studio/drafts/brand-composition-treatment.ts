import type { BrandCompositionTreatment } from "@flock/email-sdk";
import type { BrandKit } from "@/lib/brand-kit";

const MAX_GUIDANCE_LENGTH = 24_000;

/*
  Convert authored/scraped brand prose into a small allow-list of email-safe
  composition choices. The prose is treated as data: it can select a known
  primitive, but it cannot introduce CSS, markup, or arbitrary measurements.
*/
export function deriveBrandCompositionTreatment(
  brandKit: BrandKit,
): BrandCompositionTreatment | null {
  const guidance = [brandKit.emailDesignDoc?.markdown, brandKit.imageStyleDoc?.markdown]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .slice(0, MAX_GUIDANCE_LENGTH)
    .toLowerCase();
  if (guidance.length === 0) {
    return null;
  }
  const shouldOutlineButtons = /\b(outline|outlined|bordered|double[- ]stroke)\b.{0,40}\b(button|cta)\b|\b(button|cta)\b.{0,40}\b(outline|outlined|bordered|double[- ]stroke)\b/.test(
    guidance,
  );
  const shouldFrameImages = /\b(image|imagery|photo|photography|visual)\b.{0,40}\b(frame|framed|border|bordered|outline|outlined)\b|\b(frame|framed|border|bordered|outline|outlined)\b.{0,40}\b(image|imagery|photo|photography|visual)\b/.test(
    guidance,
  );
  const shouldSeparateSections = /\b(section|content)\b.{0,40}\b(hairline|rule|divider|separator)\b|\b(hairline|rule|divider|separator)\b.{0,40}\b(section|content)\b/.test(
    guidance,
  );
  if (!shouldOutlineButtons && !shouldFrameImages && !shouldSeparateSections) {
    return null;
  }
  return { shouldOutlineButtons, shouldFrameImages, shouldSeparateSections };
}
