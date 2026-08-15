import { z } from "zod";
import type { Operation } from "../operations/ops";
import { getSectionTemplate, SECTION_TEMPLATES } from "../sections/catalog";
import type { SectionCategory } from "../sections/types";
import { ROOT_BLOCK_ID, type RandomFn } from "../schema/ids";
import type { GlobalStyles } from "../schema/globals";
import type { EmailDocument } from "../store/document";

/**
 * The create-draft composition primitive.
 *
 * WHY THIS EXISTS. `createDraft` used to take exactly one argument — `count` —
 * and every new draft opened on the same generic starter email. A new draft
 * was therefore the one thing the agent could create but could never fill:
 * content actions apply to the document the turn is pinned to (the drafts bar
 * never activates an agent-created draft), so "make me a draft about X" had no
 * expressible form. The model's only way to produce content about X was to
 * rewrite the draft already on screen — which is exactly the reported bug
 * (existing content wiped and rebuilt in place).
 *
 * THE PRINCIPLE (same as scaffoldSection / styleTextSpan): the model-facing
 * input stays intent-level — "a draft named this, made of these sections, with
 * this copy" — and ALL of the complexity is a deterministic translation inside
 * the SDK:
 *
 * - COMPLETENESS. Every composed draft is a real email: a header section, at
 *   least one body section, and a footer section. A plan that omits any of the
 *   three is repaired here, not rejected — an under-specified plan still
 *   produces something the user could send.
 * - THEME INHERITANCE. The new draft opens under the theme the user is already
 *   looking at (the source document's `root.properties.globals`), unless the
 *   caller explicitly opts out.
 * - CONTENT CARRY-OVER. Params the model left unspecified are filled from the
 *   SOURCE draft's own content — its headline, its supporting paragraph, its
 *   call to action, its brand name — so a new draft continues the email the
 *   user is working on instead of starting from placeholder copy.
 * - REAL VARIATION. Asking for several drafts at once and describing them
 *   identically is the common model failure; identical plans are deterministically
 *   diversified (plain hero ⇄ split hero, feature columns ⇄ feature list, …) so
 *   "explore some ideas" yields structurally different emails, not N copies.
 *
 * The output is a list of plain `addSection` (+ optional `applyTheme`)
 * operations per draft — the same replayable ops any other edit produces — so
 * a composed draft has an ordinary op log, history, and undo from birth.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Ceiling on drafts created by one createDraft call. */
export const MAX_CREATE_DRAFT_COUNT = 5;

/** Ceiling on sections in one composed draft's plan (before repair). */
export const MAX_DRAFT_PLAN_SECTIONS = 10;

/** Longest draft name accepted from the model. */
export const DRAFT_NAME_MAX_LENGTH = 60;

/** Longest text clue carried over from the source draft into a param. */
const MAX_CLUE_LENGTH = 300;

// ---------------------------------------------------------------------------
// Input schema (what the model sees)
// ---------------------------------------------------------------------------

const templateIdValues = SECTION_TEMPLATES.map((template) => template.id);

const draftSectionPlanSchema = z
  .strictObject({
    templateId: z
      .enum(templateIdValues as [string, ...string[]])
      .describe(
        "A section catalog templateId (see the section catalog listing in your instructions).",
      ),
    params: z
      .looseObject({})
      .optional()
      .describe(
        "The template's CONTENT params (headline, body, ctaLabel, ctaHref, brandName, …), exactly as scaffoldSection takes them. Every field defaults, and anything you leave out is filled from the draft the user is currently looking at — pass the copy this draft should actually say.",
      ),
  })
  .describe("One section of a new draft: which catalog template, and its copy.");

export type DraftSectionPlan = z.infer<typeof draftSectionPlanSchema>;

const draftPlanSchema = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .max(DRAFT_NAME_MAX_LENGTH)
      .optional()
      .describe(
        'Short, user-facing name for this draft, describing its angle ("Bold launch", "Story first"). Omit to let the editor number it.',
      ),
    sections: z
      .array(draftSectionPlanSchema)
      .min(1)
      .max(MAX_DRAFT_PLAN_SECTIONS)
      .describe(
        "The draft's sections in reading order. Give a header, one or more body sections (hero, feature columns, article, call to action, testimonial, …), and a footer — a missing header, body, or footer is added for you.",
      ),
  })
  .describe("One complete new draft: its name and the sections it is made of.");

export type DraftPlan = z.infer<typeof draftPlanSchema>;

export const createDraftInputSchema = z
  .strictObject({
    drafts: z
      .array(draftPlanSchema)
      .min(1)
      .max(MAX_CREATE_DRAFT_COUNT)
      .optional()
      .describe(
        `The drafts to compose, up to ${MAX_CREATE_DRAFT_COUNT} in one call. Give one entry per draft; when the user wants options, make the entries genuinely different (different section order, different templates, different copy) rather than variants of one layout. Omit only when the user asked for an empty starter draft to fill in themselves.`,
      ),
    count: z
      .int()
      .min(1)
      .max(MAX_CREATE_DRAFT_COUNT)
      .optional()
      .describe(
        `How many EMPTY starter drafts to create (default 1, max ${MAX_CREATE_DRAFT_COUNT}). Ignored when \`drafts\` is given.`,
      ),
    shouldInheritTheme: z
      .boolean()
      .optional()
      .describe(
        "Whether the new drafts keep the theme currently applied to the user's draft (default true). Pass false only when the user explicitly asked for a clean, unthemed start.",
      ),
  })
  .describe(
    "Creates one or more NEW drafts alongside the current one, each a complete email (header, body, footer). The user's current draft is never touched.",
  );

export type CreateDraftInput = z.infer<typeof createDraftInputSchema>;

// ---------------------------------------------------------------------------
// Command schema (what travels to the client)
// ---------------------------------------------------------------------------

export const createDraftCommandSchema = z
  .strictObject({
    type: z.literal("createDraft").describe("Command discriminator."),
    count: z
      .int()
      .min(1)
      .max(MAX_CREATE_DRAFT_COUNT)
      .describe("Resolved number of drafts to create."),
    drafts: z
      .array(draftPlanSchema)
      .min(1)
      .max(MAX_CREATE_DRAFT_COUNT)
      .optional()
      .describe(
        "The composition plan, one entry per draft. Absent = empty starter drafts (the pre-composition behavior).",
      ),
    shouldInheritTheme: z
      .boolean()
      .describe("Whether the new drafts adopt the source draft's theme."),
  })
  .describe("Client command: add new drafts to the drafts bar, composed or empty.");

export type CreateDraftCommand = z.infer<typeof createDraftCommandSchema>;

/** Resolve the model's input into the client command (count/plan reconciled). */
export function resolveCreateDraftCommand(input: CreateDraftInput): CreateDraftCommand {
  const shouldInheritTheme = input.shouldInheritTheme ?? true;
  if (input.drafts !== undefined && input.drafts.length > 0) {
    return {
      type: "createDraft",
      count: input.drafts.length,
      drafts: input.drafts,
      shouldInheritTheme,
    };
  }
  return { type: "createDraft", count: input.count ?? 1, shouldInheritTheme };
}

// ---------------------------------------------------------------------------
// Content clues: what a new draft inherits from the draft the user is on
// ---------------------------------------------------------------------------

/**
 * The intrinsic content of the source draft, in the vocabulary the section
 * templates speak. Every field is optional — an empty source yields no clues
 * and the templates' own defaults stand.
 */
export interface DraftContentClues {
  /** The sender's brand/company, from a logo's alt text or the leading heading. */
  brandName?: string;
  /** The email's leading headline. */
  headline?: string;
  /** The first supporting paragraph under it. */
  body?: string;
  /** The primary call to action's label. */
  ctaLabel?: string;
  /** The primary call to action's destination. */
  ctaHref?: string;
  /** What the first illustrative (non-logo) image shows. */
  imageAlt?: string;
  /**
   * The copy of the source's LATER body sections, one entry per section in
   * reading order, so the second and third sections of a composed draft
   * continue the source email instead of falling back to the templates' own
   * sample copy. Header and footer sections are excluded: their text is
   * structural (logo alt, address, unsubscribe), not something a body section
   * should ever repeat.
   */
  supportingCopy?: SectionCopy[];
}

/** One section's own lead copy, as the templates would name it. */
export interface SectionCopy {
  headline?: string;
  body?: string;
}

/** Ceiling on later-section copy carried over (a long newsletter stays bounded). */
const MAX_SUPPORTING_SECTIONS = 4;

/** Depth-first plain text of a Tiptap-style rich-text node tree. */
function extractPlainText(node: unknown): string {
  if (typeof node !== "object" || node === null) {
    return "";
  }
  const candidate = node as { text?: unknown; content?: unknown };
  if (typeof candidate.text === "string") {
    return candidate.text;
  }
  if (Array.isArray(candidate.content)) {
    return candidate.content.map(extractPlainText).join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

function clampClue(text: string): string | undefined {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length <= MAX_CLUE_LENGTH ? trimmed : trimmed.slice(0, MAX_CLUE_LENGTH);
}

/** Blocks per top-level section, each in reading order, depth-first. */
function walkSectionsInReadingOrder(doc: EmailDocument): EmailDocument[string][][] {
  return (doc[ROOT_BLOCK_ID]?.childrenIds ?? []).map((sectionId) => {
    const ordered: EmailDocument[string][] = [];
    const visit = (blockId: string): void => {
      const block = doc[blockId];
      if (block === undefined) {
        return;
      }
      ordered.push(block);
      for (const childId of block.childrenIds) {
        visit(childId);
      }
    };
    visit(sectionId);
    return ordered;
  });
}

/** The lead heading and lead paragraph of one section's blocks. */
function readSectionCopy(blocks: EmailDocument[string][]): SectionCopy {
  const copy: SectionCopy = {};
  for (const block of blocks) {
    if (block.type !== "text") {
      continue;
    }
    const content = (block.properties as { text?: { content?: unknown } }).text?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const node of content) {
      const text = clampClue(extractPlainText(node));
      if (text === undefined) {
        continue;
      }
      const nodeType = (node as { type?: unknown }).type;
      if (nodeType === "heading" && copy.headline === undefined) {
        copy.headline = text;
      } else if (nodeType === "paragraph" && copy.body === undefined) {
        copy.body = text;
      }
    }
  }
  return copy;
}

/**
 * Read the source draft's standing content: the words a new draft about the
 * same subject should continue from. Pure, and safe on a blank document.
 */
export function deriveDraftContentClues(doc: EmailDocument): DraftContentClues {
  const clues: DraftContentClues = {};
  const sections = walkSectionsInReadingOrder(doc);
  /** The last section the lead headline/body was taken from; -1 = none yet. */
  let leadSectionIndex = -1;
  const blocksInReadingOrder = sections.flatMap((blocks, sectionIndex) =>
    blocks.map((block) => ({ block, sectionIndex })),
  );
  for (const { block, sectionIndex } of blocksInReadingOrder) {
    const properties = block.properties as Record<string, unknown>;
    if (block.type === "image") {
      // Header logos are conventionally alt-texted "<Brand> logo".
      const alt = typeof properties.alt === "string" ? properties.alt : "";
      const isLogo = /logo/i.test(alt);
      if (isLogo && clues.brandName === undefined) {
        const brandName = clampClue(alt.replace(/\s*logo\s*$/i, ""));
        if (brandName !== undefined) {
          clues.brandName = brandName;
        }
      } else if (!isLogo && clues.imageAlt === undefined) {
        // What the email actually pictures — better than every template's
        // "Product preview" placeholder.
        clues.imageAlt = clampClue(alt);
      }
      continue;
    }
    if (block.type === "text") {
      const content = (properties.text as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const node of content) {
        const nodeType = (node as { type?: unknown }).type;
        const text = clampClue(extractPlainText(node));
        if (text === undefined) {
          continue;
        }
        if (nodeType === "heading" && clues.headline === undefined) {
          clues.headline = text;
          leadSectionIndex = Math.max(leadSectionIndex, sectionIndex);
        } else if (nodeType === "paragraph" && clues.body === undefined) {
          clues.body = text;
          leadSectionIndex = Math.max(leadSectionIndex, sectionIndex);
        }
      }
      continue;
    }
    if (block.type === "button" && clues.ctaLabel === undefined) {
      const label = typeof properties.label === "string" ? clampClue(properties.label) : undefined;
      if (label !== undefined) {
        clues.ctaLabel = label;
        const href = typeof properties.href === "string" ? clampClue(properties.href) : undefined;
        if (href !== undefined) {
          clues.ctaHref = href;
        }
      }
    }
  }
  // A brandless document still has a subject: fall back to the headline's
  // first few words rather than leaving every header saying "Flock".
  if (clues.brandName === undefined && clues.headline !== undefined) {
    clues.brandName = clues.headline.split(" ").slice(0, 3).join(" ");
  }
  // Everything the source says AFTER its lead, one entry per section, so a
  // multi-section draft has real copy for its second and third sections. The
  // last section is the footer — structural text, never body copy.
  const supportingCopy = sections
    .slice(leadSectionIndex + 1, Math.max(sections.length - 1, leadSectionIndex + 1))
    .map(readSectionCopy)
    .filter((copy) => copy.headline !== undefined || copy.body !== undefined)
    .slice(0, MAX_SUPPORTING_SECTIONS);
  if (supportingCopy.length > 0) {
    clues.supportingCopy = supportingCopy;
  }
  return clues;
}

// ---------------------------------------------------------------------------
// Structural repair: every draft is a whole email
// ---------------------------------------------------------------------------

/** Body categories — the middle of an email, between header and footer. */
const BODY_CATEGORIES: readonly SectionCategory[] = ["hero", "content", "social-proof"];

/** Fallbacks used when a plan is missing one of the three structural parts. */
const DEFAULT_HEADER_TEMPLATE_ID = "header";
const DEFAULT_BODY_TEMPLATE_ID = "hero";
const DEFAULT_FOOTER_TEMPLATE_ID = "footer";

function getCategory(templateId: string): SectionCategory | undefined {
  return getSectionTemplate(templateId)?.category;
}

/**
 * Repair one plan into a complete email: header first, at least one body
 * section, footer last. Unknown templateIds are dropped (the schema already
 * rejects them; this is the runtime backstop for host callers).
 */
export function completeDraftSections(sections: DraftSectionPlan[]): DraftSectionPlan[] {
  const known = sections.filter((section) => getCategory(section.templateId) !== undefined);
  // A header anywhere but the front, or a footer anywhere but the back, is a
  // planning slip — keep the first header and the last footer only.
  const firstHeaderIndex = known.findIndex(
    (section) => getCategory(section.templateId) === "header",
  );
  let lastFooterIndex = -1;
  known.forEach((section, index) => {
    if (getCategory(section.templateId) === "footer") {
      lastFooterIndex = index;
    }
  });
  const withoutStrays = known.filter((section, index) => {
    const category = getCategory(section.templateId);
    if (category === "header") {
      return index === firstHeaderIndex;
    }
    if (category === "footer") {
      return index === lastFooterIndex;
    }
    return true;
  });
  const header = withoutStrays.find((section) => getCategory(section.templateId) === "header");
  const footer = withoutStrays.find((section) => getCategory(section.templateId) === "footer");
  const body = withoutStrays.filter((section) =>
    BODY_CATEGORIES.includes(getCategory(section.templateId)!),
  );
  return [
    header ?? { templateId: DEFAULT_HEADER_TEMPLATE_ID },
    ...(body.length > 0 ? body : [{ templateId: DEFAULT_BODY_TEMPLATE_ID }]),
    footer ?? { templateId: DEFAULT_FOOTER_TEMPLATE_ID },
  ];
}

// ---------------------------------------------------------------------------
// Variation: sibling drafts must actually differ
// ---------------------------------------------------------------------------

/**
 * Structural counterparts within the catalog: same job, visibly different
 * shape. Used to pull apart sibling drafts a model described identically —
 * "a plain hero in one and a split hero in another" (owner's words).
 */
const TEMPLATE_COUNTERPARTS: Readonly<Record<string, string>> = {
  header: "header-centered",
  "header-centered": "header",
  hero: "hero-split",
  "hero-split": "hero",
  "feature-columns": "feature-list",
  "feature-list": "feature-columns",
  testimonial: "testimonial-columns",
  "testimonial-columns": "testimonial",
  footer: "footer-social",
  "footer-social": "footer",
  article: "cta",
  cta: "article",
};

const toShapeKey = (sections: DraftSectionPlan[]): string =>
  sections.map((section) => section.templateId).join(">");

/** Swap the listed positions to their catalog counterparts; copy is untouched. */
function swapCounterparts({
  sections,
  shouldSwap,
}: {
  sections: DraftSectionPlan[];
  shouldSwap: (index: number) => boolean;
}): DraftSectionPlan[] {
  return sections.map((section, index) => {
    const counterpart = TEMPLATE_COUNTERPARTS[section.templateId];
    if (counterpart === undefined || !shouldSwap(index)) {
      return section;
    }
    return { ...section, templateId: counterpart };
  });
}

/** Move the body's first section to the end; header and footer stay put. */
function rotateBody(sections: DraftSectionPlan[]): DraftSectionPlan[] {
  const body = sections.slice(1, -1);
  if (body.length < 2) {
    return sections;
  }
  return [sections[0]!, ...body.slice(1), body[0]!, sections[sections.length - 1]!];
}

/**
 * Give each draft its own shape. A draft whose section sequence repeats an
 * earlier one walks a fixed ladder of restatements — swap every section to its
 * catalog counterpart, then only the body, then only the frame, then reorder —
 * and takes the first shape nobody has used yet. So "explore a few ideas"
 * yields a plain hero in one and a split hero in another rather than N copies,
 * while the model's own copy rides along untouched.
 *
 * Deterministic: same input, same output.
 */
export function diversifyDraftSections(plans: DraftSectionPlan[][]): DraftSectionPlan[][] {
  const seenShapes = new Set<string>();
  return plans.map((sections) => {
    const isFrame = (index: number): boolean => index === 0 || index === sections.length - 1;
    const candidates: DraftSectionPlan[][] = [
      sections,
      swapCounterparts({ sections, shouldSwap: () => true }),
      swapCounterparts({ sections, shouldSwap: (index) => !isFrame(index) }),
      swapCounterparts({ sections, shouldSwap: isFrame }),
      rotateBody(sections),
      rotateBody(swapCounterparts({ sections, shouldSwap: () => true })),
    ];
    const chosen =
      candidates.find((candidate) => !seenShapes.has(toShapeKey(candidate))) ??
      candidates[candidates.length - 1]!;
    seenShapes.add(toShapeKey(chosen));
    return chosen;
  });
}

// ---------------------------------------------------------------------------
// Plan → operations
// ---------------------------------------------------------------------------

/** One composed draft: what to call it and the ops that build it. */
export interface ComposedDraft {
  /** The model's name for this draft, when it gave one. */
  name?: string;
  /** Ops in apply order: an optional applyTheme, then one addSection per section. */
  ops: Operation[];
}

export interface BuildComposedDraftsInput {
  /** The draft the user is currently on — the theme and content source. */
  sourceDoc: EmailDocument;
  /** The resolved client command. */
  command: CreateDraftCommand;
  /** Randomness source for the new blocks' ids — injectable for tests. */
  random?: RandomFn;
}

/** The param names a template accepts, or null when its schema is not an object. */
function getTemplateParamKeys(templateId: string): ReadonlySet<string> | null {
  const shape = (getSectionTemplate(templateId)?.paramsSchema as { shape?: unknown } | undefined)
    ?.shape;
  if (typeof shape !== "object" || shape === null) {
    return null;
  }
  return new Set(Object.keys(shape));
}

/**
 * Fill the params the model left out from the source draft's own content.
 * The FIRST section that takes a headline gets the source's lead copy;
 * subsequent headline-taking sections get the source's LATER sections in
 * order (repeating one headline down the whole email would read like a
 * mistake, and leaving them empty means every one of them silently falls back
 * to the template's own sample marketing copy). Brand, CTA and image clues
 * apply wherever a template accepts them, which is how a real email repeats
 * them. Copy the model actually specified always wins.
 */
function applyContentClues({
  sections,
  clues,
}: {
  sections: DraftSectionPlan[];
  clues: DraftContentClues;
}): DraftSectionPlan[] {
  /** Lead copy first, then one entry per later source section, consumed in order. */
  const leadFirstCopy: SectionCopy[] = [
    {
      ...(clues.headline === undefined ? {} : { headline: clues.headline }),
      ...(clues.body === undefined ? {} : { body: clues.body }),
    },
    ...(clues.supportingCopy ?? []),
  ];
  let nextCopyIndex = 0;
  return sections.map((section) => {
    const paramKeys = getTemplateParamKeys(section.templateId);
    if (paramKeys === null) {
      return section;
    }
    const givenParams = section.params ?? {};
    const filled: Record<string, unknown> = { ...givenParams };
    const fill = (key: string, value: string | undefined): void => {
      if (value !== undefined && paramKeys.has(key) && filled[key] === undefined) {
        filled[key] = value;
      }
    };
    fill("brandName", clues.brandName);
    fill("companyName", clues.brandName);
    fill("ctaLabel", clues.ctaLabel);
    fill("ctaHref", clues.ctaHref);
    fill("imageAlt", clues.imageAlt);
    if (paramKeys.has("headline") && nextCopyIndex < leadFirstCopy.length) {
      const copy = leadFirstCopy[nextCopyIndex]!;
      fill("headline", copy.headline);
      fill("body", copy.body);
      nextCopyIndex += 1;
    }
    return Object.keys(filled).length === 0 ? section : { ...section, params: filled };
  });
}

/** Rebuild attempts when generated ids collide within one draft (vanishingly rare). */
const MAX_BUILD_ATTEMPTS = 5;

/**
 * Turn a resolved createDraft command into the ops that build each draft.
 * Returns an empty list for the empty-starter form (no `drafts` plan) — the
 * host then falls back to its plain new-draft path, unchanged.
 */
export function buildComposedDrafts({
  sourceDoc,
  command,
  random = Math.random,
}: BuildComposedDraftsInput): ComposedDraft[] {
  if (command.drafts === undefined || command.drafts.length === 0) {
    return [];
  }
  const clues = deriveDraftContentClues(sourceDoc);
  const sourceRoot = sourceDoc[ROOT_BLOCK_ID];
  const sourceGlobals: GlobalStyles | undefined =
    command.shouldInheritTheme && sourceRoot !== undefined && sourceRoot.type === "root"
      ? sourceRoot.properties.globals
      : undefined;
  const hasThemeToInherit = sourceGlobals !== undefined && Object.keys(sourceGlobals).length > 0;

  const diversified = diversifyDraftSections(
    command.drafts.map((plan) => completeDraftSections(plan.sections)),
  );

  return command.drafts.map((plan, draftIndex) => {
    const sections = applyContentClues({ sections: diversified[draftIndex]!, clues });
    const ops: Operation[] = hasThemeToInherit
      ? [{ name: "applyTheme", globals: sourceGlobals }]
      : [];
    // Ids must be unique across the WHOLE new document, not just per section.
    const usedIds = new Set<string>([ROOT_BLOCK_ID]);
    sections.forEach((section, sectionIndex) => {
      const template = getSectionTemplate(section.templateId);
      if (template === undefined) {
        return;
      }
      const parsedParams = template.paramsSchema.safeParse(section.params ?? {});
      // Clue-filled params can still miss a template's expectations (an
      // inherited href that isn't a URL, say) — fall back to the template's
      // own defaults rather than dropping the section.
      const params = parsedParams.success ? parsedParams.data : template.paramsSchema.parse({});
      for (let attempt = 0; attempt < MAX_BUILD_ATTEMPTS; attempt += 1) {
        const built = template.build({ params, random });
        const newIds = [built.section.id, ...built.children.map((block) => block.id)];
        if (newIds.every((id) => !usedIds.has(id))) {
          for (const id of newIds) {
            usedIds.add(id);
          }
          ops.push({
            name: "addSection",
            section: built.section,
            index: sectionIndex,
            children: built.children,
          });
          return;
        }
      }
    });
    return { ...(plan.name === undefined ? {} : { name: plan.name }), ops };
  });
}
