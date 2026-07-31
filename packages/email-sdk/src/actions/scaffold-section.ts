import { z } from "zod";
import { applyOperation } from "../operations/apply";
import type { AddSectionOperation, Operation } from "../operations/ops";
import { getSectionTemplate, SECTION_TEMPLATE_IDS, SECTION_TEMPLATES } from "../sections/catalog";
import { ROOT_BLOCK_ID, sectionBlockIdSchema, type RandomFn } from "../schema/ids";
import type { EmailDocument } from "../store/document";
import {
  defineEmailAction,
  type ResolvedOperationError,
} from "./define";

/**
 * `scaffoldSection` — the intent-level section-scaffolding action (Phase 7.2).
 *
 * THE PRINCIPLE (owner working agreement, same as styleTextSpan): LLM-facing
 * tools take SIMPLE intent-level args; ALL complexity lives inside the tool
 * as a deterministic translation. The model says "add a hero above the
 * footer" as `{ templateId, position, params }` — it NEVER hand-assembles
 * blocks, ids, or column arithmetic. This module is that translation: pick
 * the catalog template, resolve the position anchor against the CURRENT
 * document, validate/default the content params, build the whole subtree
 * with fresh ids, and emit ONE canonical `addSection` operation for the
 * history spine — so one scaffold is one undo step and the standard
 * `removeBlock` inverse comes for free.
 *
 * The Convex round-trip and the editor store's optimistic apply both see only
 * the resolved plain `addSection` op (the resolveOperation dispatch contract),
 * so the existing content-op apply path needs no scaffold-specific handling.
 */

// ---------------------------------------------------------------------------
// Input schema (what the model sees)
// ---------------------------------------------------------------------------

/** Where to insert the new section among the document's top-level sections. */
export const scaffoldSectionPositionSchema = z
  .union([
    z.literal("top").describe("Insert as the FIRST section of the email."),
    z.literal("bottom").describe("Insert as the LAST section of the email (the default)."),
    z
      .strictObject({
        beforeSectionId: sectionBlockIdSchema.describe(
          "Insert immediately ABOVE this existing top-level section.",
        ),
      })
      .describe("Anchored insert: place the new section directly above an existing one."),
    z
      .strictObject({
        afterSectionId: sectionBlockIdSchema.describe(
          "Insert immediately BELOW this existing top-level section.",
        ),
      })
      .describe("Anchored insert: place the new section directly below an existing one."),
  ])
  .describe(
    'Where to insert the new section: "top", "bottom", or an object anchoring it before/after an existing section id. Omit for "bottom".',
  );

export type ScaffoldSectionPosition = z.infer<typeof scaffoldSectionPositionSchema>;

/**
 * The scaffoldSection intent — `params` is typed per template in the Zod
 * schema (a discriminated union on templateId), erased to a plain record here.
 */
export interface ScaffoldSectionInput {
  name: "scaffoldSection";
  /** One of the catalog's template ids (see SECTION_TEMPLATE_IDS). */
  templateId: string;
  /** Where to insert. Omitted = "bottom". */
  position?: ScaffoldSectionPosition;
  /** The template's CONTENT params. Every field defaults; omit for a complete demo section. */
  params?: Record<string, unknown>;
}

const scaffoldSectionBranches = SECTION_TEMPLATES.map((template) =>
  z.strictObject({
    name: z.literal("scaffoldSection").describe("Action discriminator."),
    templateId: z
      .literal(template.id)
      .describe(`The "${template.name}" section template. Use when: ${template.useWhen}`),
    position: scaffoldSectionPositionSchema.optional(),
    params: (template.paramsSchema as z.ZodType)
      .optional()
      .describe(
        `Content for the ${template.name} section. Every field has a sensible default — pass only what the user's request specifies, or omit entirely for placeholder content.`,
      ),
  }),
);

/**
 * Full input schema: a discriminated union on templateId, so each template's
 * content params are typed and documented for the model. Cast to the erased
 * {@link ScaffoldSectionInput} — the per-branch param types only exist to
 * teach the model; dispatch re-validates and the resolver re-parses params.
 */
export const scaffoldSectionInputSchema = z
  .discriminatedUnion(
    "templateId",
    scaffoldSectionBranches as [
      (typeof scaffoldSectionBranches)[number],
      ...(typeof scaffoldSectionBranches)[number][],
    ],
  )
  .describe(
    "Adds one complete, professionally structured section from the section catalog in a single step: pick a templateId, give only the content the user specified, and say where it goes.",
  ) as unknown as z.ZodType<ScaffoldSectionInput>;

// ---------------------------------------------------------------------------
// Intent → canonical operation resolution
// ---------------------------------------------------------------------------

export type ResolveScaffoldSectionResult =
  | { isOk: true; op: AddSectionOperation }
  | { isOk: false; errors: ResolvedOperationError[] };

export interface ResolveScaffoldSectionOperationInput {
  /** The document to insert into. Never mutated. */
  doc: EmailDocument;
  /** Validated scaffoldSection input. */
  input: ScaffoldSectionInput;
  /** Randomness source for the new blocks' ids — injectable for tests. */
  random?: RandomFn;
}

const formatZodIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");

/** Rebuild attempts when generated ids collide with the document (vanishingly rare). */
const MAX_BUILD_ATTEMPTS = 5;

/**
 * The intent→operation translation: resolve a scaffoldSection input against a
 * document into ONE canonical `addSection` operation. Deterministic given a
 * RandomFn (ids are the only randomness). Every failure is a structured,
 * retryable repair hint: an unknown templateId lists the valid ids, a bad
 * position anchor quotes the document's ACTUAL top-level section ids, and bad
 * params carry the exact validation issues.
 */
export function resolveScaffoldSectionOperation({
  doc,
  input,
  random = Math.random,
}: ResolveScaffoldSectionOperationInput): ResolveScaffoldSectionResult {
  const template = getSectionTemplate(input.templateId);
  if (template === undefined) {
    return {
      isOk: false,
      errors: [
        {
          code: "unknown_section_template",
          message: `No section template "${input.templateId}" exists in the catalog. Valid template ids: ${SECTION_TEMPLATE_IDS.join(", ")}.`,
        },
      ],
    };
  }

  const root = doc[ROOT_BLOCK_ID];
  if (root === undefined || root.type !== "root") {
    return {
      isOk: false,
      errors: [
        {
          code: "target_not_found",
          message: 'The document has no root block — sections can only be scaffolded into a well-formed document.',
        },
      ],
    };
  }
  const sectionIds = root.childrenIds;

  const position = input.position ?? "bottom";
  let index: number;
  if (position === "top") {
    index = 0;
  } else if (position === "bottom") {
    index = sectionIds.length;
  } else {
    const isBeforeAnchor = "beforeSectionId" in position;
    const anchorId = isBeforeAnchor ? position.beforeSectionId : position.afterSectionId;
    const anchorIndex = sectionIds.indexOf(anchorId);
    if (anchorIndex === -1) {
      const currentSections =
        sectionIds.length > 0 ? sectionIds.join(", ") : "(the document has no sections yet)";
      return {
        isOk: false,
        errors: [
          {
            code: "target_not_found",
            message: `No top-level section "${anchorId}" exists to anchor the insert. Current sections, top to bottom: ${currentSections}. Anchor to one of these ids, or use "top"/"bottom".`,
            blockId: anchorId,
          },
        ],
      };
    }
    index = isBeforeAnchor ? anchorIndex : anchorIndex + 1;
  }

  const parsedParams = template.paramsSchema.safeParse(input.params ?? {});
  if (!parsedParams.success) {
    return {
      isOk: false,
      errors: [
        {
          code: "op_validation_failed",
          message: `params for section template "${template.id}" failed validation: ${formatZodIssues(parsedParams.error)}. Every field is optional (sensible defaults) — pass only valid fields for this template.`,
        },
      ],
    };
  }

  for (let attempt = 0; attempt < MAX_BUILD_ATTEMPTS; attempt += 1) {
    const built = template.build({ params: parsedParams.data, random });
    const newIds = [built.section.id, ...built.children.map((block) => block.id)];
    if (newIds.every((id) => doc[id] === undefined)) {
      return {
        isOk: true,
        op: {
          name: "addSection",
          section: built.section,
          index,
          children: built.children,
        },
      };
    }
  }
  return {
    isOk: false,
    errors: [
      {
        code: "duplicate_block_id",
        message: `Could not allocate fresh block ids for the new section after ${MAX_BUILD_ATTEMPTS} attempts — retry the scaffold.`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The action definition
// ---------------------------------------------------------------------------

/**
 * The scaffoldSection content action. `resolveOperation` is the intent→op
 * translation above; per the dispatch contract (see dispatchContentAction),
 * `run` therefore receives the RESOLVED `addSection` operation — the op log,
 * undo/redo, and AI-batch revert only ever see a standard replayable op, and
 * one scaffold is exactly one undo step.
 */
export const scaffoldSectionAction = defineEmailAction({
  name: "scaffoldSection",
  description:
    "Add a complete, professionally structured section from the section catalog in ONE step — headers, heroes, feature layouts, article, image gallery, call-to-action, product card, pricing, code sample, testimonials, stats, and footers (the catalog listing below the tools has every templateId). Give the templateId, the content the user specified (all params have sensible defaults), and where to insert it. Prefer this over hand-assembling addSection/addBlock whenever a catalog template fits; the scaffolded section inherits the document's theme automatically.",
  kind: "content",
  schema: scaffoldSectionInputSchema,
  readOnly: false,
  parallelSafe: false, // structural: sibling indices shift
  needsApproval: false,
  resolveOperation: (doc, input) => resolveScaffoldSectionOperation({ doc, input }),
  // dispatchContentAction calls run with the RESOLVED addSection operation
  // (never the raw intent input), hence the cast.
  run: (doc, input) => applyOperation(doc, input as unknown as Operation),
});
