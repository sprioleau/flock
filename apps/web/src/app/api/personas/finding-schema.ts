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

/*
  PROSE VS CONTENT. Everything the truncation backstop touches is prose ABOUT
  the email — a card headline, a description, a block reference. A copy edit's
  `text` is the opposite: it is the email's own words, on their way into the
  document. Ellipsizing it would ship a half-sentence into a user's email, so
  it is never truncated. Its runaway-length guard lives in finding-ops.ts and
  REFUSES the edit instead (the finding degrades to informational), which is
  the same shape as every other way a proposed edit can fail to compose.
*/

/** Generous per-field caps applied by truncation (never by hard validation). */
export const FINDING_TEXT_CAPS = {
  title: 160,
  description: 480,
  targetBlockName: 160,
  suggestedPrompt: 480,
} as const;

/** Truncate one prose field to `cap`, marking the cut with an ellipsis. */
export function truncateFindingText({ text, cap }: { text: string; cap: number }): string {
  if (text.length <= cap) {
    return text;
  }
  return `${text.slice(0, cap - 1).trimEnd()}…`;
}

/*
  A proposed edit comes in exactly two shapes, and the union between them is
  encoded as TWO SIBLING ARRAYS (`proposedEdits` / `proposedCopyEdits`) rather
  than as one array of a `kind`-discriminated union.

  WHY NOT A DISCRIMINATED UNION, which is the obvious modelling. The model is
  Gemini via generateObject, so this schema is converted to the provider's
  OpenAPI-subset response schema: a Zod discriminated union becomes `anyOf`
  branches each pinned by a `const` discriminator (which @ai-sdk/google
  rewrites to a one-value `enum`). This project has already paid twice for
  provider schema limits — numeric literals inside nested op schemas had to be
  rewritten by hand at the glue layer (api/chat/model-schema.ts), and the
  OpenRouter free tier rejects `pattern`/`propertyNames` outright. Two flat
  arrays of flat, all-string objects contain nothing a provider can choke on:
  no `anyOf`, no `const`, no numeric `enum`, no nesting past one level. The
  union is still exactly as expressive — an edit is a property edit or a copy
  edit by which array it sits in — and it is arguably EASIER for a model to
  emit, because each array's description says what belongs in it instead of
  asking the model to first pick a tag and then honour the branch it picked.

  The second reason is blast radius: the property-edit shape below is not
  touched at all, so a run that proposes only property edits produces exactly
  the bytes it produced before this capability existed.
*/
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

/*
  The copy-rewrite half of the union: PLAIN TEXT, never a rich-text document.

  A text block's content is a Tiptap doc (nodes, attrs, inline marks), and
  asking a model for that tree in structured output is exactly the deeply
  nested schema the note above says not to ship — heading levels alone are a
  numeric literal union, the one conversion this project has already been
  bitten by. So the model writes the WORDS, one line per paragraph/heading,
  and finding-ops.ts turns them into a real `updateText` operation against the
  block's existing structure. Same principle as `styleTextSpan` and
  `scaffoldSection`: intent-level args in, deterministic translation server-side.
*/
export const proposedCopyEditSchema = z.object({
  blockId: z
    .string()
    .describe(
      "The target TEXT block's id exactly as it appears in the document outline (a txt_ id).",
    ),
  text: z
    .string()
    .describe(
      "The block's complete new wording as plain text — every word it should say after the edit, not just the part you changed. Write ONE LINE per paragraph or heading the block already has (the outline separates them with \" | \"), in the same order; the block's headings, alignment and styling are preserved for you. Never write JSON, HTML, or markdown here.",
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
      "1-3 sentences: what clashes and the concrete fix. When you attach a copy rewrite, say what applying it changes rather than pasting the rewrite itself — the user sees the words land in the email. Refer to content by its visible text, never by block ids.",
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
      "Concrete block-property edits that implement the fix, when the fix IS a property change (a color, an alignment, a size, a button's label, an image's alt text or href). Use proposedCopyEdits instead to reword a text block; omit both for anything neither can express.",
    ),
  proposedCopyEdits: z
    .array(proposedCopyEditSchema)
    .max(4)
    .optional()
    .describe(
      "Concrete COPY rewrites that implement the fix, when the fix is a change to the WORDS of a text block. Plain text only — it is converted into the block's rich text for you. Omit for property changes (a button's label is a property edit) and whenever you have no rewrite worth applying.",
    ),
  suggestedPrompt: z
    .string()
    .optional()
    .describe(
      "ONLY when you propose no edits at all: a short ready-to-send message, written in the user's first-person voice, asking their email-editing assistant to resolve this finding. Refer to content by its visible text, never by block ids. Omit whenever proposedEdits or proposedCopyEdits is present.",
    ),
});

export const runnerOutputSchema = z.object({
  findings: z
    .array(findingSchema)
    .max(4)
    .describe("All findings across all personas. An empty array is a valid, good answer."),
});

export type RunnerOutputFinding = z.infer<typeof findingSchema>;

/*
  Apply the truncation backstop to one parsed finding's prose fields.

  The spread carries every other field through untouched — notably both edit
  arrays, whose contents are values destined for the document rather than
  prose about it (see the PROSE VS CONTENT note above).
*/
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
    ...(finding.suggestedPrompt !== undefined
      ? {
          suggestedPrompt: truncateFindingText({
            text: finding.suggestedPrompt,
            cap: FINDING_TEXT_CAPS.suggestedPrompt,
          }),
        }
      : {}),
  };
}
