import { articleTemplate } from "./templates/article";
import { featureColumnsTemplate } from "./templates/feature-columns";
import { footerTemplate } from "./templates/footer";
import { headerTemplate } from "./templates/header";
import { heroTemplate } from "./templates/hero";
import { imageGalleryTemplate } from "./templates/image-gallery";
import { statsTemplate } from "./templates/stats";
import { testimonialTemplate } from "./templates/testimonial";
import type { SectionTemplate } from "./types";

/**
 * SECTION CATALOG v1 (Phase 7.2) — eight templates seeded from the React
 * Email components taxonomy (react.email/components, MIT; structural/visual
 * reference only — every builder emits our own theme-native blocks).
 *
 * Listed in typical email composition order (header → hero → content →
 * social proof → footer); the prompt's compact catalog listing preserves this
 * order, so keep it stable — it is part of the cached prompt prefix.
 */
export const SECTION_TEMPLATES: readonly SectionTemplate[] = [
  headerTemplate,
  heroTemplate,
  featureColumnsTemplate,
  articleTemplate,
  imageGalleryTemplate,
  testimonialTemplate,
  statsTemplate,
  footerTemplate,
];

/** Every catalog template id, in catalog order. */
export const SECTION_TEMPLATE_IDS = SECTION_TEMPLATES.map(
  (template) => template.id,
) as readonly string[];

/** One catalog template id. */
export type SectionTemplateId = (typeof SECTION_TEMPLATES)[number]["id"];

const templatesById: ReadonlyMap<string, SectionTemplate> = new Map(
  SECTION_TEMPLATES.map((template) => [template.id, template]),
);

/** Look up one template by id; undefined for ids not in the catalog. */
export function getSectionTemplate(templateId: string): SectionTemplate | undefined {
  return templatesById.get(templateId);
}
