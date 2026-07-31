import { z } from "zod";

/**
 * The persona runner's structured-output contract + the defensive length
 * handling around it (reliability fix): the schema previously hard-capped
 * prose fields (`z.string().max(60)` on targetBlockNames), and Gemini does
 * not reliably honor maxLength — one long visible label (a wordy button)
 * made generateObject fail validation and cost the WHOLE run. Twice, live.
 *
 * The contract now has three layers:
 * 1. PROMPT: the conduct rules ask for short quotes (long labels quoted
 *    partially with an ellipsis) — see PERSONA_CONDUCT_STATIC in route.ts.
 * 2. SCHEMA: prose fields validate as plain strings (array COUNTS stay
 *    capped) — an over-long string can never fail the run.
 * 3. BACKSTOP: the route truncates every prose field with
 *    {@link truncateFindingText} before recording, so stored findings stay
 *    card-sized no matter what the model returned.
 */

/** Generous per-field caps applied by truncation (never by hard validation). */
export const FINDING_TEXT_CAPS = {
  title: 160,
  description: 480,
  targetBlockName: 160,
} as const;

/** Truncate one prose field to `cap`, marking the cut with an ellipsis. */
export function truncateFindingText({ text, cap }: { text: string; cap: number }): string {
  if (text.length <= cap) {
    return text;
  }
  return `${text.slice(0, cap - 1).trimEnd()}…`;
}

export const proposedEditSchema = z.object({
  blockId: z
    .string()
    .describe("The target block's id exactly as it appears in the document outline."),
  property: z
    .string()
    .describe('The block property to change, e.g. "backgroundColor", "align", "label".'),
  value: z
    .string()
    .describe(
      'The new value as a string ("#0d9488", "center", "24"). Numbers and true/false are auto-converted.',
    ),
});

export const findingSchema = z.object({
  personaSlug: z.string().describe("The slug of the persona this finding belongs to."),
  // Prose fields are deliberately un-capped in the schema (layer 2 above):
  // length guidance lives in the prompt, and the route truncates on receipt.
  title: z.string().describe("Short card headline (a dozen words at most). Never mention block ids."),
  description: z
    .string()
    .describe(
      "1-3 sentences: what clashes and the concrete fix (include the suggested rewrite for copy findings). Refer to content by its visible text, never by block ids.",
    ),
  targetBlockNames: z
    .array(z.string())
    .min(1)
    .max(4)
    .describe(
      'Visible content references, e.g. "the button labeled \\"Buy now\\"". Never ids. Keep each short — quote only the first few words of a long label, with an ellipsis.',
    ),
  targetBlockIds: z
    .array(z.string())
    .min(1)
    .max(6)
    .describe("The outline ids of every block this finding is about (internal use only)."),
  proposedEdits: z
    .array(proposedEditSchema)
    .max(6)
    .optional()
    .describe(
      "Concrete block-property edits that implement the fix, when the fix IS a property change. Omit for copy rewrites or anything a property edit cannot express.",
    ),
});

export const runnerOutputSchema = z.object({
  findings: z
    .array(findingSchema)
    .max(4)
    .describe("All findings across all personas. An empty array is a valid, good answer."),
});

export type RunnerOutputFinding = z.infer<typeof findingSchema>;

/** Apply the truncation backstop to one parsed finding's prose fields. */
export function truncateFindingProse(finding: RunnerOutputFinding): RunnerOutputFinding {
  return {
    ...finding,
    title: truncateFindingText({ text: finding.title, cap: FINDING_TEXT_CAPS.title }),
    description: truncateFindingText({
      text: finding.description,
      cap: FINDING_TEXT_CAPS.description,
    }),
    targetBlockNames: finding.targetBlockNames.map((name) =>
      truncateFindingText({ text: name, cap: FINDING_TEXT_CAPS.targetBlockName }),
    ),
  };
}
