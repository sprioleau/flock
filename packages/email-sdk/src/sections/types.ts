import { z } from "zod";
import type { Block, SectionBlock } from "../schema/blocks";
import type { RandomFn } from "../schema/ids";
import {
  isContentRequirementSatisfied,
  type SectionContentRequirements,
} from "./content-requirements";

/**
 * Section catalog types (Phase 7.2).
 *
 * A `SectionTemplate` is a pure, deterministic-given-a-RandomFn generator of
 * one complete section subtree — exactly the payload of ONE `addSection`
 * operation. Scaffolding therefore gets undo/redo, batch revert, and op-log
 * provenance for free: the history spine only ever sees a standard op.
 *
 * Design contract (docs/proposals/section-catalog.md, owner-simplified):
 * - `useWhen` is ONE crisp sentence the LLM reasons over when choosing a
 *   template; it is surfaced verbatim in the prompt's compact catalog listing.
 * - `paramsSchema` is CONTENT ONLY (headlines, body copy, CTA label/href,
 *   image alt text, stat values …) — never colors, fonts, or padding. Every
 *   field carries a `.describe()`, and `parse({})` succeeds. Copy fields
 *   default to sample text (guarded by `contentRequirements`); fields that
 *   name a PLACE carry no default at all, so a section the caller gave no
 *   destination or address renders without that element rather than with an
 *   invented one — see `previewParams` for how the gallery still shows both.
 * - Builders emit blocks with minimal/no style overrides so every scaffolded
 *   section inherits `root.properties.globals` and is theme-native: the same
 *   section reads correctly under a light theme and a dark theme alike.
 *   (Structural layout — column widths, alignment, image display width — is
 *   allowed; theme-owned styling — colors, fonts, padding — is not.)
 */

/** The catalog's category axis — groups templates for humans; the LLM selects on `useWhen`. */
export const SECTION_CATEGORIES = [
  "header",
  "hero",
  "content",
  "social-proof",
  "footer",
] as const;

export type SectionCategory = (typeof SECTION_CATEGORIES)[number];

/** What `build` returns: exactly the `addSection` op's `{ section, children }` payload. */
export interface SectionBuildResult {
  /** The new section block (parentId "root"), childrenIds wired to `children`. */
  section: SectionBlock;
  /** Every descendant block (rows, columns, leaves), parentIds wired, root-first order. */
  children: Block[];
}

/** Input to a template's `build` — single object arg per repo convention. */
export interface SectionBuildInput<TParams> {
  /** Params already validated/defaulted through the template's `paramsSchema`. */
  params: TParams;
  /** Randomness source for block ids — injectable so tests get stable ids. */
  random?: RandomFn;
}

/** One catalog entry: metadata the LLM selects on, plus the pure builder. */
export interface SectionTemplate<TSchema extends z.ZodType = z.ZodType> {
  /** Stable catalog id (lowercase, hyphenated) — the `scaffoldSection` templateId. */
  id: string;
  /** Human-facing display name ("Hero"). */
  name: string;
  /** Catalog category, for grouping and future UI pickers. */
  category: SectionCategory;
  /** ONE sentence of LLM selection guidance — the axis the model reasons over. */
  useWhen: string;
  /** CONTENT-ONLY params: every field `.describe()`d; `parse({})` succeeds. */
  paramsSchema: TSchema;
  /*
    What this template needs before it may build a section of a REAL draft:
    which copy params, which lists and how long, how many images. Read against
    the params the CALLER supplied, so the `.default()` values above take no
    part — which is exactly why sample COPY can go on serving the gallery
    while never standing in as content. The params that name a PLACE are
    guarded differently, because requiring them here would drop the sections
    that carry them: see `previewParams`. Keys on content shape only; never on
    `pageType`. Always read it through `getContentRequirements`, and test fit
    through `sections/content-fit`.
  */
  contentRequirements: SectionContentRequirements;
  /*
    The NARROWED params schema the model is offered, for the templates whose
    `paramsSchema` carries a field the model must not be able to write.

    Today that is exactly one thing: the image-source override on the seven
    image-bearing templates. The model's job is COPY — handing it a URL field
    would let it invent or hotlink an image address, and would churn a large
    cached prompt prefix for a field it should never fill. The override exists
    for PROGRAMMATIC callers: the content-ingestion pipeline rehosts a source
    image into our own storage and passes the resulting URL through a
    createDraft section plan, which validates against `paramsSchema`.

    Templates with nothing to hide leave this undefined and are handed to the
    model untouched. Always read it through `getModelFacingParamsSchema`.
  */
  modelFacingParamsSchema?: z.ZodType;
  /*
    Sample values for the params that carry NO default, shown in the CATALOG
    GALLERY and nowhere else.

    A param that names a PLACE — a button's destination, a nav bar's links, a
    postal address — cannot carry a default, because `contentRequirements`
    cannot require it either: requiring an address would drop every footer,
    and a dropped footer takes the legally required unsubscribe link with it.
    So those params are `.optional()` and `build` simply leaves the element out
    when the caller named nothing. That is the right answer for a real draft
    and the wrong one for a thumbnail: the gallery exists to show what a
    template LOOKS like, and a hero with no button misrepresents the hero.

    These values close that one gap. They are never merged into params on any
    path that writes to a document — `scaffoldSection` and `createDraft` both
    build from what the caller supplied — so unlike a `.default()` they cannot
    reach a real email. Always read them through `getPreviewParams`.
  */
  previewParams?: Record<string, unknown>;
  /** Pure builder: validated params (+ optional RandomFn) → one addSection payload. */
  build(input: SectionBuildInput<z.output<TSchema>>): SectionBuildResult;
}

/*
  The params schema to show the model: a template's narrowed schema when it
  declares one, otherwise `paramsSchema` itself — so a template that hides
  nothing presents exactly the surface it always has.
*/
export function getModelFacingParamsSchema(template: SectionTemplate): z.ZodType {
  return template.modelFacingParamsSchema ?? template.paramsSchema;
}

/*
  The content a template needs to say something true — the second
  audience-specific view of its params, beside `getModelFacingParamsSchema`.
  Named accessor for the same reason that one has one: callers should never
  reach past it into the raw field.
*/
export function getContentRequirements(template: SectionTemplate): SectionContentRequirements {
  return template.contentRequirements;
}

/*
  The gallery's sample values — the third audience-specific view of a
  template's params, beside the model's schema and the content requirements.
  A template with no undefaulted params has nothing to fill in and returns the
  empty object, which parses to exactly what it always did.
*/
export function getPreviewParams(template: SectionTemplate): Record<string, unknown> {
  return template.previewParams ?? {};
}

/** The param names one template's schema accepts, or null when it is not an object schema. */
export function getTemplateParamKeys(paramsSchema: z.ZodType): ReadonlySet<string> | null {
  return paramsSchema instanceof z.ZodObject ? new Set(Object.keys(paramsSchema.shape)) : null;
}

/** Lowercase start, then lowercase letters/digits/hyphens: `hero`, `feature-columns`. */
const TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Define one section template: validates the metadata and returns the frozen
 * definition. Pure data + one pure `build` hook — mirrors `defineEmailAction`.
 */
export function defineSectionTemplate<TSchema extends z.ZodType>(
  template: SectionTemplate<TSchema>,
): Readonly<SectionTemplate<TSchema>> {
  if (!TEMPLATE_ID_PATTERN.test(template.id)) {
    throw new Error(
      `defineSectionTemplate: invalid template id "${template.id}" — must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.`,
    );
  }
  if (template.useWhen.trim().length === 0) {
    throw new Error(
      `defineSectionTemplate: template "${template.id}" needs a non-empty useWhen sentence — it is the model's selection guidance.`,
    );
  }
  if (!SECTION_CATEGORIES.includes(template.category)) {
    throw new Error(
      `defineSectionTemplate: template "${template.id}" has unknown category "${String(template.category)}" — expected one of: ${SECTION_CATEGORIES.join(", ")}.`,
    );
  }
  /*
    The narrowed schema must still be demo-ready on its own: the model omits
    params constantly, and a hidden field that took a default with it would
    make `scaffoldSection` fail for the model alone.
  */
  if (
    template.modelFacingParamsSchema !== undefined &&
    !template.modelFacingParamsSchema.safeParse({}).success
  ) {
    throw new Error(
      `defineSectionTemplate: template "${template.id}" has a modelFacingParamsSchema that rejects {} — the model-facing schema must still yield a complete demo section.`,
    );
  }
  assertContentRequirements(template);
  assertPreviewParams(template);
  return Object.freeze({ ...template });
}

/*
  Preview values may only FILL GAPS, never restate or override what the schema
  already says. Held here so `previewParams` cannot quietly become a second
  copy layer drifting away from the schema beside it — the gallery must keep
  showing the same template everyone else builds.
*/
function assertPreviewParams(template: SectionTemplate<z.ZodType>): void {
  const previewParams = getPreviewParams(template);
  const previewKeys = Object.keys(previewParams);
  if (previewKeys.length === 0) {
    return;
  }
  const paramKeys = getTemplateParamKeys(template.paramsSchema);
  if (paramKeys !== null) {
    const unknownParams = previewKeys.filter((param) => !paramKeys.has(param));
    if (unknownParams.length > 0) {
      throw new Error(
        `defineSectionTemplate: template "${template.id}" declares previewParams for ${unknownParams.map((param) => `"${param}"`).join(", ")}, which its paramsSchema does not accept.`,
      );
    }
  }
  const defaulted = z
    .record(z.string(), z.unknown())
    .safeParse(template.paramsSchema.safeParse({}).data);
  if (defaulted.success) {
    const alreadyDefaulted = previewKeys.filter((param) => defaulted.data[param] !== undefined);
    if (alreadyDefaulted.length > 0) {
      throw new Error(
        `defineSectionTemplate: template "${template.id}" declares previewParams for ${alreadyDefaulted.map((param) => `"${param}"`).join(", ")}, which its paramsSchema already defaults — preview values fill the gaps the schema deliberately leaves, they never restate or override it.`,
      );
    }
  }
  if (!template.paramsSchema.safeParse(previewParams).success) {
    throw new Error(
      `defineSectionTemplate: template "${template.id}" has previewParams its own paramsSchema rejects — the gallery builds through that schema like everyone else.`,
    );
  }
}

/*
  The declaration has to be true of the schema beside it, and it has to be
  worth having. Both are checked here, at definition time, so a nineteenth
  template cannot quietly reintroduce the fabrication: a requirement naming a
  param that does not exist would never be checkable, and a requirement asking
  for nothing would let the template's own sample copy satisfy it.
*/
function assertContentRequirements(template: SectionTemplate<z.ZodType>): void {
  const { copyParams, listParams, imageCount } = template.contentRequirements;
  const paramKeys = getTemplateParamKeys(template.paramsSchema);
  if (paramKeys !== null) {
    const declared = [...copyParams, ...listParams.map((listParam) => listParam.param)];
    const unknownParams = declared.filter((param) => !paramKeys.has(param));
    if (unknownParams.length > 0) {
      throw new Error(
        `defineSectionTemplate: template "${template.id}" declares contentRequirements for ${unknownParams.map((param) => `"${param}"`).join(", ")}, which its paramsSchema does not accept.`,
      );
    }
  }
  for (const listParam of listParams) {
    if (!Number.isInteger(listParam.minimumCount) || listParam.minimumCount < 1) {
      throw new Error(
        `defineSectionTemplate: template "${template.id}" declares a minimumCount of ${listParam.minimumCount} for "${listParam.param}" — a list requirement asks for at least one entry.`,
      );
    }
  }
  if (!Number.isInteger(imageCount) || imageCount < 0) {
    throw new Error(
      `defineSectionTemplate: template "${template.id}" declares an imageCount of ${imageCount} — it must be a whole number of images, zero or more.`,
    );
  }
  if (isContentRequirementSatisfied({ requirements: template.contentRequirements, params: {} })) {
    throw new Error(
      `defineSectionTemplate: template "${template.id}" has contentRequirements that an EMPTY params object already satisfies — every param here carries a sample default, so a template that requires nothing would render that sample copy as if it were the sender's own words.`,
    );
  }
}
