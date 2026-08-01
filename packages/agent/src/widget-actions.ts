import {
  applyOperations,
  blockIdSchema,
  defineEmailAction,
  getSectionTemplate,
  SECTION_TEMPLATE_IDS,
  updateBlockPropertiesOperationSchema,
  type Block,
  type EmailDocument,
  type UpdateBlockPropertiesOperation,
} from "@flock/email-sdk";
import { z } from "zod";

/**
 * Generative-UI widget actions — the tools whose results render as
 * INTERACTIVE WIDGETS in the chat transcript instead of plain chips/prose.
 *
 * The split of responsibilities (mirrors fetchWebContent):
 * - THIS module owns the model-facing contract (names, schemas, descriptions)
 *   and the PURE per-request computation (`run`) where one exists —
 *   materializing section variations from the catalog, dry-run-validating
 *   proposed edits against the request document.
 * - The HOST (apps/web chat tools) owns the streaming side: it wraps these
 *   actions' runs, writes the widget's `data-*` part onto the UI-message
 *   stream, and returns a compact model-facing summary. Two actions have no
 *   meaningful run here:
 *   - askForClarification is intentionally EXECUTION-FREE (the host registers
 *     it schema-only; the turn ends on the call and the user's answer arrives
 *     as their next message),
 *   - listAssets needs the calling session's asset library (Convex), which
 *     only the host can reach — its run is a placeholder.
 *
 * All four are `kind: "analysis"` (read-only): none of them edits the
 * document. The USER's click on the rendered widget performs any edit,
 * client-side, through the normal validated dispatch path with the
 * appropriate provenance.
 */

// ---------------------------------------------------------------------------
// askForClarification
// ---------------------------------------------------------------------------

export const askForClarificationInputSchema = z
  .strictObject({
    question: z
      .string()
      .min(1)
      .max(200)
      .describe("The ONE short, specific question to ask the user."),
    options: z
      .array(z.string().min(1).max(80))
      .min(2)
      .max(4)
      .describe(
        "2-4 concrete answer options, each a short phrase the user can pick with one click.",
      ),
  })
  .describe("One clarifying question plus concrete answer options.");

export type AskForClarificationInput = z.infer<typeof askForClarificationInputSchema>;

export const askForClarificationAction = defineEmailAction({
  name: "askForClarification",
  description:
    "Ask the user ONE clarifying question, shown as clickable answer options in the chat. Use BEFORE acting when the request is too ambiguous to act on confidently (e.g. \"make it pop\") — never guess between meaningfully different interpretations. The turn ENDS after this call: do not call any other tool with it; the user's answer arrives as their next message.",
  kind: "analysis",
  schema: askForClarificationInputSchema,
  readOnly: true,
  parallelSafe: false,
  needsApproval: false,
  // Never executed: the host registers this tool WITHOUT an execute so the
  // turn ends on the call (the widget waits for the user's answer).
  run: (): null => null,
});

// ---------------------------------------------------------------------------
// proposeSectionVariations
// ---------------------------------------------------------------------------

/**
 * Intent-level content hints, shared across all templates (the owner
 * working agreement: LLM-facing tools take SIMPLE args; the deterministic
 * translation lives inside the tool). Hints a template doesn't support are
 * silently dropped; every template field has a demo default.
 */
const variationContentHintsSchema = z
  .strictObject({
    headline: z.string().min(1).max(160).optional().describe("Main heading text."),
    body: z.string().min(1).max(500).optional().describe("Supporting body copy."),
    ctaLabel: z.string().min(1).max(60).optional().describe("Call-to-action button label."),
    ctaHref: z.string().min(1).max(500).optional().describe("Call-to-action destination URL."),
    imageAlt: z.string().min(1).max(160).optional().describe("Image alt text."),
  })
  .describe(
    "Optional content for this variation. Only the fields the chosen template supports are used; omitted fields get sensible demo defaults.",
  );

export const proposeSectionVariationsInputSchema = z
  .strictObject({
    intent: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("One short line describing what the variations are exploring."),
    variations: z
      .array(
        z.strictObject({
          title: z
            .string()
            .min(1)
            .max(48)
            .describe('Short user-facing label for this take, e.g. "Bold announcement".'),
          templateId: z
            .enum(SECTION_TEMPLATE_IDS as readonly string[] as [string, ...string[]])
            .describe(
              "A section catalog templateId (same catalog as scaffoldSection). Vary the template and/or the content across variations.",
            ),
          params: variationContentHintsSchema.optional(),
        }),
      )
      .min(2)
      .max(4)
      .describe("2-4 meaningfully different takes on the requested section."),
  })
  .describe("Input for proposeSectionVariations: a handful of section takes for the user to pick from.");

export type ProposeSectionVariationsInput = z.infer<typeof proposeSectionVariationsInputSchema>;

/** One materialized variation: root-first section subtree, preview-ready. */
export interface SectionVariationPayload {
  title: string;
  templateId: string;
  /** Flat root-first subtree — `[section, ...children]` (the restoreBlocks payload shape). */
  blocks: Block[];
}

export interface ProposeSectionVariationsResult {
  variations: SectionVariationPayload[];
}

/**
 * Keep only the hint keys the template's own params schema declares, then let
 * the schema's defaults fill the rest. A hint set the template rejects
 * entirely (shouldn't happen post-filter) degrades to the full demo defaults —
 * a variation always materializes.
 */
function resolveTemplateParams({
  paramsSchema,
  hints,
}: {
  paramsSchema: z.ZodType;
  hints: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  const supportedKeys =
    paramsSchema instanceof z.ZodObject ? new Set(Object.keys(paramsSchema.shape)) : new Set<string>();
  const filteredHints = Object.fromEntries(
    Object.entries(hints ?? {}).filter(([key]) => supportedKeys.has(key)),
  );
  const parsed = paramsSchema.safeParse(filteredHints);
  if (parsed.success) {
    return parsed.data as Record<string, unknown>;
  }
  return paramsSchema.parse({}) as Record<string, unknown>;
}

/**
 * Materialize each requested variation into a full section subtree via the
 * SDK catalog — deterministic content (ids are the only nondeterminism, and
 * they are re-minted with fresh ids at insert time anyway). Unknown template
 * ids are skipped (the schema enum makes that unreachable in practice).
 */
export function materializeSectionVariations(
  input: ProposeSectionVariationsInput,
): ProposeSectionVariationsResult {
  const variations: SectionVariationPayload[] = [];
  for (const variation of input.variations) {
    const template = getSectionTemplate(variation.templateId);
    if (template === undefined) {
      continue;
    }
    const params = resolveTemplateParams({
      paramsSchema: template.paramsSchema as z.ZodType,
      hints: variation.params,
    });
    const built = template.build({ params: params as never });
    variations.push({
      title: variation.title,
      templateId: variation.templateId,
      blocks: [built.section, ...built.children],
    });
  }
  return { variations };
}

export const proposeSectionVariationsAction = defineEmailAction({
  name: "proposeSectionVariations",
  description:
    "Present 2-4 alternative takes on a section as a picker widget in the chat, each rendered as a themed preview with a \"Use this one\" button. Use when the user asks for variations, options, or alternatives for a section. NOTHING is added to the email by this call — the user picks one and only that one is inserted. Never scaffold the candidates into the email yourself.",
  kind: "analysis",
  schema: proposeSectionVariationsInputSchema,
  readOnly: true,
  parallelSafe: false,
  needsApproval: false,
  run: (_doc: EmailDocument, input: ProposeSectionVariationsInput): ProposeSectionVariationsResult | null => {
    const result = materializeSectionVariations(input);
    return result.variations.length === 0 ? null : result;
  },
});

// ---------------------------------------------------------------------------
// proposeEdits
// ---------------------------------------------------------------------------

export const proposeEditsInputSchema = z
  .strictObject({
    suggestions: z
      .array(
        z.strictObject({
          title: z
            .string()
            .min(1)
            .max(60)
            .describe('Short user-facing name for the improvement, e.g. "Stronger call to action".'),
          description: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .describe("One sentence on why this helps (plain language, no ids)."),
          edits: z
            .array(
              z.strictObject({
                blockId: blockIdSchema.describe(
                  "The target block's id, exactly as it appears in the document outline.",
                ),
                property: z
                  .string()
                  .min(1)
                  .max(48)
                  .describe('The property to change, e.g. "label", "href", "align".'),
                value: z
                  .string()
                  .max(500)
                  .describe("The new value, as a string (numbers/booleans auto-convert)."),
              }),
            )
            .min(1)
            .max(4)
            .describe("The concrete property changes this suggestion applies."),
        }),
      )
      .min(1)
      .max(4)
      .describe("1-4 focused, independently applicable suggestions."),
  })
  .describe("Input for proposeEdits: specific improvements, each with its concrete edits.");

export type ProposeEditsInput = z.infer<typeof proposeEditsInputSchema>;

/** One suggestion whose ops dry-ran cleanly against the request document. */
export interface ValidatedEditSuggestion {
  /** Stable per-call id ("s1", "s2", …) — the widget's apply/dismiss key. */
  id: string;
  title: string;
  description?: string;
  ops: UpdateBlockPropertiesOperation[];
}

export interface ProposeEditsResult {
  suggestions: ValidatedEditSuggestion[];
  /** Suggestions dropped because their ops failed validation or the dry-run. */
  droppedCount: number;
}

/** "true"/"false"/numeric strings become their typed values; all else stays a string. */
function coercePropertyValue(value: string): string | number | boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed !== "" && String(Number(trimmed)) === trimmed) {
    return Number(trimmed);
  }
  return value;
}

/**
 * Turn one suggestion's intent-level edits into validated ops: group per
 * block, coerce values, parse with the op schema, then DRY-RUN the whole
 * batch against the request document (the personaFindings pattern). Returns
 * null when anything fails — the suggestion is dropped, never half-kept.
 */
function composeSuggestionOps({
  doc,
  edits,
}: {
  doc: EmailDocument;
  edits: ProposeEditsInput["suggestions"][number]["edits"];
}): UpdateBlockPropertiesOperation[] | null {
  const propertiesByBlockId = new Map<string, Record<string, unknown>>();
  for (const edit of edits) {
    const properties = propertiesByBlockId.get(edit.blockId) ?? {};
    properties[edit.property] = coercePropertyValue(edit.value);
    propertiesByBlockId.set(edit.blockId, properties);
  }
  const ops: UpdateBlockPropertiesOperation[] = [];
  for (const [blockId, properties] of propertiesByBlockId) {
    const parsed = updateBlockPropertiesOperationSchema.safeParse({
      name: "updateBlockProperties",
      blockId,
      properties,
    });
    if (!parsed.success) {
      return null;
    }
    ops.push(parsed.data);
  }
  const dryRun = applyOperations(doc, ops);
  return dryRun.isOk ? ops : null;
}

/** Dry-run-validate every suggestion against `doc`; invalid ones are dropped. */
export function validateEditSuggestions({
  doc,
  input,
}: {
  doc: EmailDocument;
  input: ProposeEditsInput;
}): ProposeEditsResult {
  const suggestions: ValidatedEditSuggestion[] = [];
  let droppedCount = 0;
  input.suggestions.forEach((suggestion, index) => {
    const ops = composeSuggestionOps({ doc, edits: suggestion.edits });
    if (ops === null) {
      droppedCount += 1;
      return;
    }
    suggestions.push({
      id: `s${index + 1}`,
      title: suggestion.title,
      ...(suggestion.description === undefined ? {} : { description: suggestion.description }),
      ops,
    });
  });
  return { suggestions, droppedCount };
}

export const proposeEditsAction = defineEmailAction({
  name: "proposeEdits",
  description:
    "Present 1-4 specific improvement suggestions as cards in the chat, each with an Apply button. Use when the user asks how to improve the email (or for feedback/review) WITHOUT asking you to change it directly. Each suggestion carries concrete property edits that are validated against the current document before being shown. NOTHING is applied by this call — the user applies or dismisses each card. Do not also apply the edits yourself.",
  kind: "analysis",
  schema: proposeEditsInputSchema,
  readOnly: true,
  parallelSafe: false,
  needsApproval: false,
  run: (doc: EmailDocument, input: ProposeEditsInput): ProposeEditsResult =>
    validateEditSuggestions({ doc, input }),
});

// ---------------------------------------------------------------------------
// listAssets
// ---------------------------------------------------------------------------

export const listAssetsInputSchema = z
  .strictObject({})
  .describe("No input — lists the session's saved library assets.");

export type ListAssetsInput = z.infer<typeof listAssetsInputSchema>;

/** One library asset, as the model sees it (url is usable as an image src). */
export interface AssetSummary {
  name: string;
  kind: "uploaded" | "generated" | "logo" | "social-card";
  /** Durable serving URL — valid as an image block's `src`. */
  url: string;
  createdAtMs: number;
  sizeBytes?: number;
}

export interface ListAssetsResult {
  assets: AssetSummary[];
  totalCount: number;
}

export const listAssetsAction = defineEmailAction({
  name: "listAssets",
  description:
    "List the images saved in this session's library (uploads, AI generations, brand logos) — name, type, and serving URL, newest first. Read-only; also shows the user a compact table in the chat. Use to answer questions like \"what images do I have?\" or to find an existing image's URL before setting it on an image block with updateBlockProperties (src).",
  kind: "analysis",
  schema: listAssetsInputSchema,
  readOnly: true,
  parallelSafe: true,
  needsApproval: false,
  // Placeholder: the session's asset library lives in the host's Convex
  // deployment — the host (apps/web chat tools) replaces execution with a
  // session-scoped query and never calls this run.
  run: (): null => null,
});

/** Every generative-UI widget action, registration order preserved. */
export const widgetActions = [
  askForClarificationAction,
  proposeSectionVariationsAction,
  proposeEditsAction,
  listAssetsAction,
] as const;
