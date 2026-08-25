import { z } from "zod";
import { renderToHTML } from "../render/render-to-html";
import { renderToPlainText } from "../render/render-to-plain-text";
import type { EmailDocument } from "../store/document";
import { defineEmailAction } from "./define";

/**
 * `inspectRenderedEmail` — the agent's own eyes on the email it just built.
 *
 * Every other tool the agent has works on the DOCUMENT: a flat map of blocks,
 * pointers, and property bags. None of them answers the question a person asks
 * after an edit — "does the email read right?" — because the document is not
 * the email. The email is what falls out of the renderer, and until now that
 * pipeline (renderToHTML / renderToPlainText, already mounted at
 * POST /api/render for the preview dialog) was reachable by the browser and by
 * nothing else. This wraps it, unchanged, as a read-only analysis action so
 * the agent can look at its own output before telling the user it is done.
 *
 * WHAT IT RETURNS, AND WHY IT IS NOT THE HTML
 *
 * A rendered email is tens of kilobytes of table-layout HTML with an inline
 * style block on the front. Handing that back would spend most of a model's
 * context to answer a question the model then has to reverse-engineer out of
 * `<td>` soup — the classic tool-response failure mode, and the reason
 * Anthropic caps tool results at 25,000 tokens in the first place. A tool that
 * blows the window to say "looks fine" has cost more than it returned.
 *
 * So the answer is the PLAIN-TEXT rendering plus a few facts about the HTML:
 *
 *   plainText                 What a text-only client shows: the words, the
 *                             headings, and the link destinations, in reading
 *                             order, with the markup gone. This is the right
 *                             representation for the thing agents actually get
 *                             wrong — copy. Duplicated headlines, a CTA whose
 *                             label survived but whose href did not, a section
 *                             left holding placeholder text, a body that reads
 *                             as three disconnected fragments: all of it is
 *                             visible here and none of it is cheap to see in
 *                             the document JSON.
 *   isRendered                Whether the render succeeded AT ALL. The single
 *                             highest-value bit in the result: a document that
 *                             fails its integrity check produces no email, and
 *                             without this the agent has no way to discover
 *                             that short of the user reporting a blank preview.
 *   htmlByteCount             The size of the real HTML, which is a fact about
 *                             the email that cannot be read off the document
 *                             and that has a hard consequence in the wild.
 *   isAtRiskOfGmailClipping   That consequence, named. Gmail truncates a
 *                             message body past ~102KB and hides the rest
 *                             behind "View entire message" — which routinely
 *                             swallows the unsubscribe footer. Deriving the
 *                             flag here rather than making the model remember
 *                             the threshold is the difference between a number
 *                             it ignores and a problem it fixes.
 *
 * DELIBERATELY ABSENT: a block count. It reads well in a list of features and
 * tells the agent nothing it does not already have — the document outline it
 * receives every turn already enumerates the blocks, and the renderer does not
 * drop them, so the count can only ever confirm arithmetic the agent could do
 * itself. Every field here is something only rendering can tell you.
 *
 * ALSO DELIBERATELY ABSENT: an opt-in `format: "html"` escape hatch. It is the
 * obvious way to let a caller ask for the fuller result, and it does not
 * survive contact with the cap that makes this tool safe: the first several
 * thousand characters of a rendered email are the doctype, the mso conditional
 * comments, and the `<style>` block, so a capped HTML response is a budget
 * spent entirely before the first word of copy. An uncapped one is the failure
 * mode this whole design exists to avoid. If a future need is genuinely
 * HTML-shaped — verifying an attribute survived, say — the honest answer is a
 * narrow tool that queries for that attribute, not a wider pipe.
 *
 * BOUNDED BY CONSTRUCTION, not on average. `maxCharacters` lets a caller ask
 * for more of the copy when a long email is genuinely the subject, but the
 * request is CLAMPED, not trusted: the returned text can never exceed
 * RENDERED_TEXT_MAX_CHARACTERS no matter what is passed, and the failure
 * message is capped the same way, because an integrity error carries one
 * sentence per broken block and a badly broken document has many. Worst case
 * for the whole result is therefore a fixed constant — see the constants
 * below — and it does not depend on the size of the document.
 */

/**
 * How much of the plain-text rendering comes back when the caller does not
 * say. Enough for the whole of a normal marketing email — a few hundred words
 * of copy plus its link destinations — because the common case is "read what I
 * just wrote", and a default that truncates the common case trains the model
 * to always ask for the maximum.
 */
export const RENDERED_TEXT_DEFAULT_CHARACTERS = 2_000;

/**
 * The ceiling. A caller asking for more gets this instead of an error: a
 * clamp costs nothing, while a validation failure costs a whole repair
 * round-trip to teach the model a number it could have been given.
 */
export const RENDERED_TEXT_MAX_CHARACTERS = 8_000;

/**
 * Cap on the failure message. `DocumentIntegrityError` concatenates one
 * sentence per structural error, so a badly broken document produces a message
 * that scales with the document — exactly the unbounded shape this tool exists
 * to avoid. The first few errors are the ones worth acting on anyway.
 */
export const RENDER_FAILURE_MESSAGE_MAX_CHARACTERS = 600;

/**
 * Gmail stops rendering a message body past this many bytes and hides the
 * remainder behind "View entire message". 102KB, the figure Google documents
 * and the one every email deliverability guide repeats.
 */
export const GMAIL_CLIPPING_BYTE_LIMIT = 102_400;

/** Appended to any truncated string so the model knows it is reading a prefix. */
export const RENDERED_TEXT_TRUNCATION_MARKER = "\n[truncated]";

export const inspectRenderedEmailInputSchema = z
  .object({
    maxCharacters: z
      .int()
      .positive()
      .optional()
      .describe(
        `How many characters of the plain-text rendering to return. Defaults to ${RENDERED_TEXT_DEFAULT_CHARACTERS}; anything larger than ${RENDERED_TEXT_MAX_CHARACTERS} is clamped to it. Raise it only when you need to read a long email all the way through.`,
      ),
  })
  .describe(
    "Input for inspectRenderedEmail. Every field is optional — call it with {} to read the current email.",
  );

export type InspectRenderedEmailInput = z.output<typeof inspectRenderedEmailInputSchema>;

/** A successful look at the rendered email. */
export interface RenderedEmailReport {
  isRendered: true;
  /** The email as a text-only client shows it, truncated to the budget. */
  plainText: string;
  /** True when `plainText` is a prefix — raise `maxCharacters` to see more. */
  isPlainTextTruncated: boolean;
  /** Length of the FULL plain-text rendering, before truncation. */
  plainTextCharacterCount: number;
  /** Size of the rendered HTML in UTF-8 bytes — what the mail client receives. */
  htmlByteCount: number;
  /** True when `htmlByteCount` is at or past Gmail's clipping threshold. */
  isAtRiskOfGmailClipping: boolean;
}

/** The email could not be rendered — the document itself is broken. */
export interface RenderedEmailFailure {
  isRendered: false;
  /** Why, truncated to the message cap. Written to be relayed to the user. */
  message: string;
}

export type InspectRenderedEmailResult = RenderedEmailReport | RenderedEmailFailure;

/**
 * Truncate to a hard character budget, marking the cut so a prefix is never
 * mistaken for the whole. The marker is INSIDE the budget rather than added to
 * it: a bound that a suffix can push past is not a bound.
 */
function truncateToBudget(value: string, budget: number): string {
  if (value.length <= budget) {
    return value;
  }
  const bodyLength = Math.max(0, budget - RENDERED_TEXT_TRUNCATION_MARKER.length);
  return `${value.slice(0, bodyLength)}${RENDERED_TEXT_TRUNCATION_MARKER}`;
}

export interface InspectRenderedEmailOptions {
  /** The document to render. Only read — rendering never mutates it. */
  doc: EmailDocument;
  /** Requested plain-text budget. Clamped to RENDERED_TEXT_MAX_CHARACTERS. */
  maxCharacters?: number;
}

/**
 * Render the document and report on the result.
 *
 * Both representations are produced, in parallel, from the same document read
 * — the same thing POST /api/render does for the preview dialog's three tabs,
 * and for the same reason: two renders of one document can never disagree
 * about what the email says, whereas two renders taken a moment apart can.
 * The HTML is rendered but never returned; only its size leaves this function.
 *
 * A render throw is CAUGHT rather than propagated. `renderToHTML` throws
 * `DocumentIntegrityError` when the document fails its integrity check, and an
 * uncaught throw would reach the model as a bare tool error — the least
 * actionable form of the most actionable finding this tool produces. Turning
 * it into `isRendered: false` plus the reason keeps "the email is broken" a
 * normal, readable answer.
 */
export async function inspectRenderedEmail({
  doc,
  maxCharacters,
}: InspectRenderedEmailOptions): Promise<InspectRenderedEmailResult> {
  /*
    The clamp lives here, not only in the schema, so the bound holds for every
    caller — including one that skips validation — rather than only for the
    ones that came through a dispatcher.
  */
  const budget = Math.min(
    maxCharacters ?? RENDERED_TEXT_DEFAULT_CHARACTERS,
    RENDERED_TEXT_MAX_CHARACTERS,
  );
  let html: string;
  let plainText: string;
  try {
    [html, plainText] = await Promise.all([renderToHTML(doc), renderToPlainText(doc)]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      isRendered: false,
      message: truncateToBudget(
        `The email could not be rendered: ${reason}`,
        RENDER_FAILURE_MESSAGE_MAX_CHARACTERS,
      ),
    };
  }
  /*
    TextEncoder, not Buffer: this package runs in the browser as well as on the
    server, and byte length is the only honest measure of what a mail client
    receives — an email full of non-ASCII copy is bigger than its character
    count suggests, and Gmail's threshold is counted in bytes.
  */
  const htmlByteCount = new TextEncoder().encode(html).length;
  return {
    isRendered: true,
    plainText: truncateToBudget(plainText, budget),
    isPlainTextTruncated: plainText.length > budget,
    plainTextCharacterCount: plainText.length,
    htmlByteCount,
    isAtRiskOfGmailClipping: htmlByteCount >= GMAIL_CLIPPING_BYTE_LIMIT,
  };
}

/**
 * The action. Analysis kind, so `readOnly: true` is enforced by the factory;
 * parallel-safe because it only reads; no approval and no `authorize` gate,
 * because looking at the email the caller is already editing grants no access
 * the caller did not already have.
 *
 * `run` returns the promise rather than awaiting it, which is the contract
 * `dispatchAnalysisAction` documents for async analysis actions (the agent
 * package's web-content and person-research actions are the precedent): the
 * dispatcher stays synchronous and hands the value straight back, and the
 * calling surface awaits.
 */
export const inspectRenderedEmailAction = defineEmailAction({
  name: "inspectRenderedEmail",
  description:
    "Render the CURRENT email and read it back as a text-only mail client shows it — the words, headings, and link destinations in reading order — plus whether it rendered at all, the HTML size in bytes, and whether it is big enough for Gmail to clip. Read-only; the document is unchanged. Call it after you finish a set of edits and BEFORE telling the user the email is done, to check the copy actually reads the way you intended: duplicated or leftover placeholder text, a section that says nothing, a call to action whose link is missing, an ordering that does not flow. If isRendered is false the document is structurally broken and no email exists — relay the reason and fix the structure before anything else. The HTML itself is never returned (it is tens of kilobytes of layout markup); pass maxCharacters to read more of a long email's copy.",
  kind: "analysis",
  schema: inspectRenderedEmailInputSchema,
  readOnly: true,
  parallelSafe: true,
  needsApproval: false,
  run: (doc, input): Promise<InspectRenderedEmailResult> =>
    inspectRenderedEmail({ doc, maxCharacters: input.maxCharacters }),
});
