import { api } from "@convex/_generated/api";
import { generateDocumentOutline } from "@flock/agent";
import {
  emailDocumentSchema,
  type Block,
  type EmailDocument,
  type GlobalStyles,
} from "@flock/email-sdk";
import { isDataUIPart } from "ai";
import { fetchAuthQuery } from "@/lib/auth/auth-server";
import {
  GENERATION_REQUEST_DATA_PART_TYPE,
  generationRequestDataPartSchema,
  type FlockChatDataPart,
  type FlockChatMessage,
  type GenerationRequestDataPart,
} from "@/lib/chat-contract";
import { logRecord } from "@/lib/observability/log";

/**
 * The drafts menu's AI generation brief ("Ideate with AI" / "Add design
 * variation") — assembled HERE, on the server, from a minimal request.
 *
 * WHY IT LIVES SERVER-SIDE. It used to be built in the browser and SENT AS THE
 * USER'S MESSAGE TEXT, which meant the chat bubble rendered the whole thing:
 * block ids, hex colours, font stacks, the structural instruction list. None of
 * that is language a person wrote or should read. So the wire now carries only
 * what a person actually expressed —
 *
 *   text: 'Add a design variation of "RenderATL 2026" — brighter colors.'
 *   data: { kind: "designVariation", sourceDocumentId, direction }
 *
 * — and the targeted instructions are joined onto it at the LAST possible
 * moment: {@link expandGenerationBriefPart} turns that data part into a text
 * part inside the same user message, during `convertToModelMessages`. The model
 * sees one coherent user turn; the transcript renders only the sentence, since
 * the user bubble draws `text` parts and nothing else.
 *
 * The SOURCE DRAFT is likewise no longer shipped through the prompt: the id is
 * enough, because this module can read the document from Convex itself. That is
 * also why `direction` is the only free text on the wire — the person's own
 * words, which the client never parses and the model reads as instruction.
 *
 * ONE EXTRACTOR, TWO FIDELITIES. Both paths render the source with the agent
 * package's `generateDocumentOutline` — the same deterministic, token-budgeted
 * view the chat turn itself uses. This module owns only the question of HOW
 * MUCH of it travels, which is a single option:
 *
 * - "Ideate with AI" wants a fresh concept, so it takes the default 60-char
 *   clip. Subject matter and audience survive; the wording does not, which is
 *   the point — a fuller quote would pull the model into rewriting the same
 *   email.
 * - "Add design variation" must keep the words, so it raises the clip to
 *   {@link VARIATION_MAX_TEXT_CHARS}. The reported bug was partly this number:
 *   the owner's ~200-character paragraph reached the model as a third of
 *   itself, and the model filled the hole from the section templates' own
 *   sample copy.
 *
 * DEPTH STAYS "blocks" FOR BOTH, deliberately. "sections" carries no copy at
 * all, and "full" appends every explicitly-set style property of every block —
 * a blueprint the model can transcribe, which is the exact failure mode a
 * design VARIATION has to avoid, and the most expensive option on a free-tier
 * quota. "blocks" tells the model what the email contains and roughly how it
 * groups, and nothing about how it is styled.
 */

/**
 * Characters of copy quoted per text block when reimagining a draft.
 *
 * The clip applies to a whole text block — heading and paragraph joined — so
 * it has to clear both together, not just a paragraph. Measured against the
 * current (rich) starter document, the cost curve is nearly flat past a few
 * hundred: 60 → ~379 tokens, 300 → ~697, 400 → ~722, 600 → ~772, 900 → ~798.
 * Almost everything is the structure, not the copy. 600 therefore buys real
 * headroom for ~50 tokens over the point where the owner's own paragraph
 * would have survived — worth paying on a free-tier quota, where a clipped
 * paragraph costs a whole wasted generation.
 */
export const VARIATION_MAX_TEXT_CHARS = 600;

/** Most images listed in the variation's image appendix. */
const MAX_LISTED_IMAGES = 8;

// ---------------------------------------------------------------------------
// Source views
// ---------------------------------------------------------------------------

/**
 * The lossy sketch behind "Ideate with AI": enough to know what the email is
 * about, not enough to rewrite it.
 */
export function buildIdeationOutline(doc: EmailDocument): string {
  // The shared outline still describes an empty document ("(no sections)");
  // both prompts treat "" as "there is no source worth mentioning".
  return hasContent(doc) ? generateDocumentOutline({ doc }) : "";
}

/** Whether this draft has anything in it at all. */
function hasContent(doc: EmailDocument): boolean {
  return (doc.root?.childrenIds ?? []).length > 0;
}

/** Blocks in reading order, depth-first from the root. */
function walkBlocksInReadingOrder(doc: EmailDocument): Block[] {
  const ordered: Block[] = [];
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
  for (const sectionId of doc.root?.childrenIds ?? []) {
    visit(sectionId);
  }
  return ordered;
}

/**
 * The exact image files the source uses, deduped, in reading order.
 *
 * The shared outline deliberately reduces an image src to its HOST ("image
 * srcs are long and rarely what the model needs at skim depth" — outline.ts),
 * which is right for editing a document that already holds the images and
 * wrong here: this prompt builds a DIFFERENT, empty draft, every section
 * template ships a grey placeholder, and "move the image somewhere new" is
 * meaningless if the image cannot come with it. So the addresses ride
 * separately rather than by widening the shared view for everyone.
 */
function listSourceImages(doc: EmailDocument): string {
  const seenSources = new Set<string>();
  const lines: string[] = [];
  for (const block of walkBlocksInReadingOrder(doc)) {
    if (block.type !== "image" || seenSources.has(block.properties.src)) {
      continue;
    }
    seenSources.add(block.properties.src);
    lines.push(`- "${block.properties.alt}" → ${block.properties.src}`);
    if (lines.length === MAX_LISTED_IMAGES) {
      break;
    }
  }
  return lines.join("\n");
}

/**
 * Everything the source draft SAYS, at full copy fidelity, plus the addresses
 * of the pictures it uses. "" for a draft with nothing in it.
 */
export function buildVariationBrief(doc: EmailDocument): string {
  if (!hasContent(doc)) {
    return "";
  }
  const outline = generateDocumentOutline({
    doc,
    options: { maxTextChars: VARIATION_MAX_TEXT_CHARS },
  });
  const images = listSourceImages(doc);
  return images.length === 0 ? outline : `${outline}\n\nThe pictures it uses:\n${images}`;
}

// ---------------------------------------------------------------------------
// Theme carry-over
// ---------------------------------------------------------------------------

/** A document's own theme globals, or `{}` when it is on the shared defaults. */
function readThemeGlobals(doc: EmailDocument): GlobalStyles {
  const root = doc.root;
  if (root === undefined || root.type !== "root") {
    return {};
  }
  return root.properties.globals ?? {};
}

/**
 * Whether the variation's draft is ALREADY wearing the source's theme.
 *
 * Derived here rather than trusted from the client, because the server holds
 * both documents and the client only held an intention: DraftSelector writes
 * the source globals into the new draft as one `applyTheme` op before the send,
 * and this compares the RESULT. A source on the shared defaults counts as a
 * match with nothing to copy — both drafts already render identically.
 */
export function hasSourceThemeApplied({
  sourceDoc,
  targetDoc,
}: {
  sourceDoc: EmailDocument;
  targetDoc: EmailDocument;
}): boolean {
  const sourceGlobals = readThemeGlobals(sourceDoc);
  const sourceKeys = Object.keys(sourceGlobals);
  if (sourceKeys.length === 0) {
    return true;
  }
  const targetGlobals = readThemeGlobals(targetDoc) as Record<string, unknown>;
  return sourceKeys.every(
    (key) => targetGlobals[key] === (sourceGlobals as Record<string, unknown>)[key],
  );
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * "Ideate with AI": a fresh concept for this canvas. The source outline is
 * inspiration — subject matter and audience — not a layout to copy.
 */
export function buildIdeateDraftPrompt({
  sourceDraftName,
  sourceOutline,
}: {
  sourceDraftName: string;
  sourceOutline: string;
}): string {
  const contextBlock =
    sourceOutline.length > 0
      ? `For context, here is a content outline of "${sourceDraftName}", another draft on this canvas:\n\n${sourceOutline}\n\n`
      : "";
  return (
    `Design a complete email from scratch in this blank draft. ` +
    `${contextBlock}` +
    `Treat that as inspiration for the subject matter and audience — come up with a fresh concept and layout rather than copying it, ` +
    `and feel free to try a different theme or visual feel. Build the email section by section.`
  );
}

export interface DesignVariationPromptInput {
  /** The draft being reimagined, by its user-facing name. */
  sourceDraftName: string;
  /** {@link buildVariationBrief} of the source draft. */
  sourceBrief: string;
  /**
   * Whether the source draft's theme is already in place on the new draft
   * ({@link hasSourceThemeApplied} of the two documents). False only when the
   * seeding failed — then the model is asked to match the source's look itself.
   */
  hasSourceTheme: boolean;
  /**
   * What the person typed in the "Anything to change?" field, verbatim and
   * unparsed. This is the ONLY channel through which "make it lighter" can
   * reach the theme decision — the client never inspects it, the model reads
   * it as plain instruction.
   */
  direction: string;
}

/**
 * "Add design variation": the SAME email, redesigned.
 *
 * The whole prompt turns on one asymmetry — CONTENT IS FIXED, STRUCTURE IS
 * FREE. Handing a model the full source without that split makes it
 * reproduce the design it was shown; freeing the content instead is the
 * reported bug (a dark, personal email came back as white generic SaaS
 * marketing copy, because every unspecified section param falls back to the
 * template's own sample text). So the brief is introduced as what the email
 * SAYS, the structural moves are enumerated concretely — columns, section
 * order and count, image placement and size — and reusing sample copy is
 * named and forbidden.
 *
 * The theme is NOT left to the model: DraftSelector has already applied the
 * source theme to this draft. The only thing that can release it is the
 * person's own words, quoted below.
 */
export function buildDesignVariationPrompt({
  sourceDraftName,
  sourceBrief,
  hasSourceTheme,
  direction,
}: DesignVariationPromptInput): string {
  const trimmedDirection = direction.trim();
  const sections: string[] = [
    `Design a complete email in this blank draft: a new take on "${sourceDraftName}", using that draft's own content.`,
    hasSourceTheme
      ? `The theme from "${sourceDraftName}" is already applied to this draft. Keep it — same colours, same fonts, same spacing — unless the person's direction below asks for something different.`
      : `Match the look and feel of "${sourceDraftName}" — this is a layout variation, not a recolour.`,
  ];
  if (sourceBrief.length > 0) {
    sections.push(
      `Here is what "${sourceDraftName}" SAYS, in reading order. Read it for its words and its pictures — the arrangement it happens to be in right now is the one thing you are being asked to change. The block ids belong to that other draft; this draft is empty, so never refer to them.\n\n${sourceBrief}`,
    );
  }
  sections.push(
    [
      "How to build the variation:",
      "",
      "1. KEEP THE WORDS. Every headline, paragraph, button label, link and image above belongs in this email, saying the same thing about the same subject. Reword only as much as a new layout demands. Never substitute sample or marketing copy — no invented company, product or tagline that is not in the brief above. When you add a section, pass it the real copy from the brief; a section left with its own default text is a failure, not a placeholder.",
      "2. CHANGE THE STRUCTURE. This must read as a different design at a glance, not the same email with new spacing. Do at least three of: turn a stacked section into side-by-side columns (or the reverse); change how many columns a row has, or their widths; change the order the sections appear in; change how many sections there are; split one dense section into two, or fold two into one.",
      "3. MOVE THE IMAGERY. Put the image somewhere it was not — leading the email, beside the copy instead of above it, or full width and much larger. Reuse the same image addresses listed above rather than leaving placeholder pictures in place.",
      "4. ADD SOMEWHERE FOR THE EYE TO REST. Include one section the source does not have — a pull quote, a stat, a short highlight row — and fill it with real content drawn from the copy above.",
      "",
      "You have real creative freedom over the shape of this email. You have none over what it says.",
    ].join("\n"),
  );
  if (trimmedDirection.length > 0) {
    sections.push(
      `The person asked for this specifically: "${trimmedDirection}"\n` +
        `Follow it. If it asks for different colours, a different theme, or a different mood, change the theme to match — that instruction outranks keeping the current one.`,
    );
  }
  sections.push("Build the email section by section.");
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Resolution (the request → the brief)
// ---------------------------------------------------------------------------

/**
 * The generation request this turn is serving: the exact data PART that must
 * expand (compared by identity, so a request from an EARLIER turn in the same
 * thread stays collapsed and unpaid-for) and the text it expands into.
 */
export interface ResolvedGenerationBrief {
  /** The part to expand — the same object `convertDataPart` will be handed. */
  part: FlockChatDataPart;
  text: string;
}

/** The generation-request part of the LAST user message, if it carries one. */
function findGenerationRequestPart(messages: FlockChatMessage[]): {
  part: FlockChatDataPart;
  request: GenerationRequestDataPart;
} | null {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  if (lastUserMessage === undefined) {
    return null;
  }
  for (const part of lastUserMessage.parts) {
    if (!isDataUIPart(part) || part.type !== GENERATION_REQUEST_DATA_PART_TYPE) {
      continue;
    }
    const parsed = generationRequestDataPartSchema.safeParse(part.data);
    if (parsed.success) {
      return { part, request: parsed.data };
    }
    // Malformed: the turn still runs on the person's own sentence. Logged
    // because it can only mean the client and this schema disagree.
    logRecord({
      tag: "flock.chat.generationRequestRejected",
      issues: parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
    });
    return null;
  }
  return null;
}

/**
 * Read the source draft named by a generation request. Returns null when it
 * cannot be read — a foreign or deleted id, or Convex being unavailable.
 *
 * `getDocumentByKey` (not `getDocument`) on purpose: the id arrives from the
 * browser, and that query normalizes an unrecognised string to null instead of
 * throwing an argument-validation error at us.
 */
async function readSourceDraft(
  sourceDocumentId: string,
): Promise<{ name: string; doc: EmailDocument } | null> {
  try {
    const payload = await fetchAuthQuery(api.documents.getDocumentByKey, {
      documentKey: sourceDocumentId,
    });
    if (payload === null) {
      return null;
    }
    // The stored doc is typed as an opaque record over the wire; parse it so a
    // shape this build does not understand degrades to "no brief" rather than
    // throwing halfway through outline generation.
    const parsedDoc = emailDocumentSchema.safeParse(payload.doc);
    return parsedDoc.success ? { name: payload.name, doc: parsedDoc.data } : null;
  } catch {
    return null;
  }
}

/**
 * Build this turn's generation brief, or null when there is none to build
 * (the ordinary case: a typed chat message).
 *
 * FAILS SOFT in every branch. A brief that cannot be assembled leaves the
 * person's own sentence to carry the turn — the model then designs from an
 * empty draft, which is a worse variation but a live one. Nothing here throws.
 */
export async function resolveGenerationBrief({
  messages,
  targetDoc,
}: {
  messages: FlockChatMessage[];
  /** THIS request's document — the blank draft the generation streams into. */
  targetDoc: EmailDocument;
}): Promise<ResolvedGenerationBrief | null> {
  const found = findGenerationRequestPart(messages);
  if (found === null) {
    return null;
  }
  const { part, request } = found;

  const sourceDraft = await readSourceDraft(request.sourceDocumentId);
  if (sourceDraft === null) {
    logRecord({
      tag: "flock.chat.generationSourceUnreadable",
      kind: request.kind,
    });
    return null;
  }

  const text =
    request.kind === "ideate"
      ? buildIdeateDraftPrompt({
          sourceDraftName: sourceDraft.name,
          sourceOutline: buildIdeationOutline(sourceDraft.doc),
        })
      : buildDesignVariationPrompt({
          sourceDraftName: sourceDraft.name,
          sourceBrief: buildVariationBrief(sourceDraft.doc),
          hasSourceTheme: hasSourceThemeApplied({ sourceDoc: sourceDraft.doc, targetDoc }),
          direction: request.direction ?? "",
        });

  return { part, text };
}

/**
 * `convertToModelMessages`' convertDataPart hook: expand THIS turn's
 * generation request into a text part, and drop every other data part.
 *
 * Dropping is the pre-existing behaviour — no `convertDataPart` was passed
 * before, so no data part has ever reached a model — and it is deliberate:
 * `data-editor-command` and the widget payloads are UI channels whose content
 * the model already saw as tool output.
 */
export function expandGenerationBriefPart({
  part,
  brief,
}: {
  part: FlockChatDataPart;
  brief: ResolvedGenerationBrief | null;
}): { type: "text"; text: string } | undefined {
  return brief !== null && part === brief.part ? { type: "text", text: brief.text } : undefined;
}
