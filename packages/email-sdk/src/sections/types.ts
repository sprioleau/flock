import type { z } from "zod";
import type { Block, SectionBlock } from "../schema/blocks";
import type { RandomFn } from "../schema/ids";

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
 *   field carries a `.describe()` and a sensible default, so `parse({})`
 *   yields a complete, demo-ready section.
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
  /** CONTENT-ONLY params: every field `.describe()`d and defaulted; `parse({})` succeeds. */
  paramsSchema: TSchema;
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
  return Object.freeze({ ...template });
}
