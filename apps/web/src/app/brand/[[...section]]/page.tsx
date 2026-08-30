import { BrandSectionContent } from "@/components/brand/BrandSectionContent";
import { resolveBrandSection } from "@/components/brand/brand-sections";

/*
  The /brand workspace page. An optional catch-all so one file serves both
  bare /brand (the default section) and /brand/<slug> (a deep-linked section),
  without a redirect hop. The layout supplies the two navigation columns; this
  page only resolves the segment and renders the matching section content.

  An unknown slug degrades to the default section rather than 404ing
  (resolveBrandSection), so a stale link stays useful.
*/
export default async function BrandSectionPage({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}) {
  const { section } = await params;
  const resolved = resolveBrandSection(section?.[0]);
  return <BrandSectionContent slug={resolved.slug} />;
}
