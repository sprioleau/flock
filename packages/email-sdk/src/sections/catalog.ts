import { articleTemplate } from "./templates/article";
import { codeSampleTemplate } from "./templates/code-sample";
import { ctaTemplate } from "./templates/cta";
import { featureColumnsTemplate } from "./templates/feature-columns";
import { featureListTemplate } from "./templates/feature-list";
import { footerTemplate } from "./templates/footer";
import { footerDetailedTemplate } from "./templates/footer-detailed";
import { footerSocialTemplate } from "./templates/footer-social";
import { headerTemplate } from "./templates/header";
import { headerCenteredTemplate } from "./templates/header-centered";
import { heroTemplate } from "./templates/hero";
import { heroSplitTemplate } from "./templates/hero-split";
import { imageGalleryTemplate } from "./templates/image-gallery";
import { pricingTemplate } from "./templates/pricing";
import { productTemplate } from "./templates/product";
import { statsTemplate } from "./templates/stats";
import { testimonialTemplate } from "./templates/testimonial";
import { testimonialColumnsTemplate } from "./templates/testimonial-columns";
import type { SectionTemplate } from "./types";

/*
  SECTION CATALOG v2 (Phase 7.2 seeded eight; §10 gallery expansion added ten
  variations) — patterns translated from the React Email components taxonomy
  (react.email/components, MIT; structural/visual reference only — every
  builder emits our own theme-native blocks).

  Listed in typical email composition order (header → hero → content →
  social proof → footer), variations grouped beside their base template; the
  prompt's compact catalog listing preserves this order, so keep it stable —
  it is part of the cached prompt prefix.
*/
export const SECTION_TEMPLATES: readonly SectionTemplate[] = [
  headerTemplate,
  headerCenteredTemplate,
  heroTemplate,
  heroSplitTemplate,
  featureColumnsTemplate,
  featureListTemplate,
  articleTemplate,
  imageGalleryTemplate,
  ctaTemplate,
  productTemplate,
  pricingTemplate,
  codeSampleTemplate,
  testimonialTemplate,
  testimonialColumnsTemplate,
  statsTemplate,
  footerTemplate,
  footerSocialTemplate,
  footerDetailedTemplate,
];

/*
  Every catalog template id, in catalog order.
*/
export const SECTION_TEMPLATE_IDS = SECTION_TEMPLATES.map(
  (template) => template.id,
) as readonly string[];

/*
  One catalog template id.
*/
export type SectionTemplateId = (typeof SECTION_TEMPLATES)[number]["id"];

const templatesById: ReadonlyMap<string, SectionTemplate> = new Map(
  SECTION_TEMPLATES.map((template) => [template.id, template]),
);

/*
  Look up one template by id; undefined for ids not in the catalog.
*/
export function getSectionTemplate(templateId: string): SectionTemplate | undefined {
  return templatesById.get(templateId);
}
