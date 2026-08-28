import { SECTION_TEMPLATES } from "./catalog";
import { isContentRequirementSatisfied } from "./content-requirements";
import { getContentRequirements, getTemplateParamKeys, type SectionTemplate } from "./types";
import type { SectionCategory } from "./types";

/*
  DOES THIS CONTENT FIT THIS TEMPLATE — the mechanical half of section
  selection.

  The split worth insisting on: "does this content fit this template" is a
  question with an answer, and should not be delegated to a model, while
  "which of these fitting sections tells the better story" genuinely is
  editorial. The motivating run is the argument — the agent chose sensible
  template ids for a scraped About page and then failed exactly this half,
  emitting a `testimonial` for a page that contained no quotes at all.

  Nothing here reads `pageType`. Fit is decided from the shape of the content
  in hand and from nothing else.
*/

export { isContentRequirementSatisfied };
export type {
  SectionContentRequirements,
  SectionListRequirement,
} from "./content-requirements";

/** Keep only the params a template actually accepts; the rest cannot fit it by definition. */
export function projectParamsOntoTemplate({
  template,
  params,
}: {
  template: SectionTemplate;
  params: Record<string, unknown>;
}): Record<string, unknown> {
  const paramKeys = getTemplateParamKeys(template.paramsSchema);
  if (paramKeys === null) {
    return params;
  }
  return Object.fromEntries(Object.entries(params).filter(([key]) => paramKeys.has(key)));
}

/**
 * Whether the caller's content can build a REAL section from this template:
 * the template's declared requirements are met by the supplied params, and
 * those params are ones the template's own schema accepts.
 *
 * Both halves matter. Requirements alone would wave through a headline the
 * schema rejects; the schema alone is what let an empty params object render
 * a complete, fictional email.
 */
export function hasContentForTemplate({
  template,
  params,
  shouldProjectParams = false,
}: {
  template: SectionTemplate;
  params: Record<string, unknown>;
  /**
   * Whether params the template does not accept are dropped rather than
   * failing it. False for the template the caller ASKED for — its params are
   * held to its own schema exactly, which is what `strictObject` is for. True
   * for a substitute, whose params are necessarily a projection of content
   * gathered for something else.
   */
  shouldProjectParams?: boolean;
}): boolean {
  const candidateParams = shouldProjectParams
    ? projectParamsOntoTemplate({ template, params })
    : params;
  if (
    !isContentRequirementSatisfied({
      requirements: getContentRequirements(template),
      params: candidateParams,
    })
  ) {
    return false;
  }
  return template.paramsSchema.safeParse(candidateParams).success;
}

/** A substitute template and the subset of the available content it takes. */
export interface ContentFittingTemplate {
  template: SectionTemplate;
  /** `params` narrowed to the substitute's own schema — what to build it from. */
  params: Record<string, unknown>;
}

/**
 * The first template in a category whose requirements the available content
 * satisfies — the substitution step. Searches in catalog order so the choice
 * is deterministic and reviewable, and skips the template that was already
 * tried and did not fit.
 *
 * Returns undefined when the whole category is unsatisfiable, which is the
 * case the drop path exists for: for a page with no quotes and no numbers,
 * `testimonial` needs a quote, `testimonial-columns` needs several and
 * `stats` needs numbers, so substitution has nothing to substitute to.
 */
export function findContentFittingTemplate({
  category,
  excludedTemplateId,
  params,
}: {
  category: SectionCategory;
  /** The template already found not to fit — never returned as its own substitute. */
  excludedTemplateId: string;
  params: Record<string, unknown>;
}): ContentFittingTemplate | undefined {
  for (const template of SECTION_TEMPLATES) {
    if (template.category !== category || template.id === excludedTemplateId) {
      continue;
    }
    if (hasContentForTemplate({ template, params, shouldProjectParams: true })) {
      return { template, params: projectParamsOntoTemplate({ template, params }) };
    }
  }
  return undefined;
}
