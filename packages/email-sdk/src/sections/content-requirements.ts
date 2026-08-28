/*
  WHAT A TEMPLATE NEEDS IN ORDER TO SAY SOMETHING TRUE.

  Every content param on every catalog template carries a `.default()`, and
  that is deliberate: `parse({})` must keep yielding a complete, demo-ready
  section for the gallery and for `scaffoldSection`. The cost of that
  invariant, left unguarded, was a draft built from a stranger's About page
  whose every section was sample copy — including an invented endorsement
  attributed to a person who does not exist.

  So a template declares, separately from its defaults, the content it needs
  before it may be used to build a REAL draft. The declaration is read against
  the params the CALLER supplied — never against the defaulted output — which
  is the whole mechanism: a default is invisible here, so a default can never
  satisfy a requirement, so a default can never stand in as content.

  Requirements key on CONTENT SHAPE only. There is deliberately no way to
  express "this template is for a person profile": `pageType` is an output on
  this project, and branching on it is an architectural regression a previous
  session removed on purpose.

  The declaration is metadata on the template, exactly like `category` and
  `useWhen`. It is never a param, so it never reaches the model-facing params
  schema, which has to stay flat and explicitly named — Gemini's constrained
  decoding cannot emit a key that is not a declared property.
*/

/** One list-shaped param and the fewest real entries it needs to be worth rendering. */
export interface SectionListRequirement {
  /** The param's name, as `paramsSchema` spells it (`features`, `stats`, `images`). */
  param: string;
  /** How many entries the caller must supply. Always at least one. */
  minimumCount: number;
}

/**
 * What one template needs to render real content, in the three shapes content
 * actually arrives in: prose, lists, and pictures.
 */
export interface SectionContentRequirements {
  /**
   * Params that must arrive as non-blank copy — the words that carry the
   * section's substance and would otherwise be asserted by a default.
   *
   * Structural chrome is deliberately absent: an unsubscribe merge tag, a
   * postal address, a nav bar, a code fence's language, or a button label on
   * a section whose substance is its prose are furniture the sender is
   * expected to configure, not claims invented about a subject.
   *
   * Absent from HERE is not the same as unguarded. Requiring the chrome would
   * drop nearly every hero and every footer, and a dropped footer takes the
   * unsubscribe link with it — so the chrome that names a PLACE (a
   * destination, a postal address) is guarded the other way instead: it
   * carries no `.default()` at all, and `build` leaves the element out when
   * the caller named nothing. See `previewParams` in `sections/types` for how
   * the catalog gallery still shows a hero's button and a footer's address.
   */
  copyParams: readonly string[];
  /** List-shaped params and the fewest entries each needs. */
  listParams: readonly SectionListRequirement[];
  /**
   * How many images the built section shows. Declared for the record — the
   * catalog test holds it to what `build` really emits, and the forward-looking
   * image-reuse policy will read it — but NOT part of the eligibility test:
   * image SOURCES are the pipeline's job, never the model's, and the fallback
   * is a visibly grey `placehold.co` box rather than invented content.
   */
  imageCount: number;
}

/** A supplied copy param counts only when it is a string with something in it. */
function hasCopy(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Whether the params the caller SUPPLIED satisfy one template's declared
 * requirements. Defaults take no part: the input is the raw params object, so
 * an absent field is absent, not "the sample value".
 */
export function isContentRequirementSatisfied({
  requirements,
  params,
}: {
  requirements: SectionContentRequirements;
  params: Record<string, unknown>;
}): boolean {
  for (const copyParam of requirements.copyParams) {
    if (!hasCopy(params[copyParam])) {
      return false;
    }
  }
  for (const listParam of requirements.listParams) {
    const value = params[listParam.param];
    if (!Array.isArray(value) || value.length < listParam.minimumCount) {
      return false;
    }
  }
  return true;
}
