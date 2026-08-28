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

/**
 * Sections a complete email is assumed to want when the source cannot supply a
 * number of its own (a genuinely empty source draft). Header, hero, two body
 * sections, footer — the same shape SYSTEM_STATIC teaches for a from-scratch
 * compose, restated here because a brief with NO target at all is the
 * condition that produced the reported one-or-two-section emails.
 */
const FALLBACK_SECTION_TARGET = 5;

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

/**
 * Top-level sections in the source draft — the number the new draft is asked
 * to aim at.
 *
 * The owner's requirement is a COUNT ("roughly the same number of sections as
 * the previous email draft did"), and a count is the one thing a prompt can
 * state outright instead of hoping for. The server already holds the source
 * document to build the briefs above, so this costs nothing extra to compute
 * and removes the guesswork entirely.
 *
 * Root children ARE the sections: every top-level child of the root is a
 * section block (rows and columns live inside them), which is the same walk
 * `hasContent` makes.
 */
export function countSourceSections(doc: EmailDocument): number {
  return (doc.root?.childrenIds ?? []).length;
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
 * Which of three ways the variation's blank draft has already been themed.
 *
 * - `source-theme` — it wears the source's own theme (or both drafts sit on
 *   the shared defaults, which renders identically with nothing to copy).
 * - `varied-theme` — it wears a DIFFERENT theme on purpose: one of the brand
 *   kit's other variations, picked by `pickVariationTheme` so a "design
 *   variation" varies the design rather than only the boxes.
 * - `unthemed` — nothing landed. The seed failed, and the model is asked to
 *   match the source's look itself.
 */
export type VariationThemeState = "source-theme" | "varied-theme" | "unthemed";

/**
 * How the variation's draft is themed RIGHT NOW.
 *
 * Derived here rather than trusted from the client, because the server holds
 * both documents and the client only held an intention: DraftSelector writes
 * one `applyTheme` op into the new draft before the send, and this compares the
 * RESULT. That is also why the varied case has to be detected rather than
 * flagged — a seed that silently failed must not be described to the model as
 * a deliberate recolour.
 */
export function resolveVariationThemeState({
  sourceDoc,
  targetDoc,
}: {
  sourceDoc: EmailDocument;
  targetDoc: EmailDocument;
}): VariationThemeState {
  const sourceGlobals = readThemeGlobals(sourceDoc);
  const targetEntries = new Map<string, unknown>(Object.entries(readThemeGlobals(targetDoc)));
  const sourceEntries = Object.entries(sourceGlobals);
  if (sourceEntries.length === 0) {
    /*
      The source is on the shared defaults. A themed target is then a varied
      theme (the picker offers kit variations against an unthemed source too);
      an unthemed target is the "nothing to copy" match.
    */
    return targetEntries.size === 0 ? "source-theme" : "varied-theme";
  }
  if (targetEntries.size === 0) {
    return "unthemed";
  }
  const isWearingSourceTheme = sourceEntries.every(
    ([key, value]) => targetEntries.get(key) === value,
  );
  return isWearingSourceTheme ? "source-theme" : "varied-theme";
}

// ---------------------------------------------------------------------------
// Shared instructions (both generation paths)
// ---------------------------------------------------------------------------

/**
 * THE FIX FOR THE "one or two sections" DEFECT — and it is arithmetic, not
 * wording.
 *
 * Measured across three live design-variation runs: the default model
 * (gemini-3.5-flash-lite) emits exactly ONE content-op tool call per response,
 * and all three spent that one op on a theme change, producing ZERO sections.
 * The client's auto-continuation ceiling is 1
 * (MAX_AUTO_CONTINUATIONS_PER_TURN in use-flock-chat.ts), so one op per
 * response across two rounds is a budget of about TWO OPS PER TURN. A complete
 * email is six to ten. The observed output is exactly what that budget
 * predicts, and no amount of "build a full email" phrasing raises a two-op
 * ceiling.
 *
 * So the lever is ops per RESPONSE, not rounds per turn: several section calls
 * in ONE response cost nothing extra, while each extra continuation round
 * re-sends the whole tool declaration set (31 tools, ~20k tokens) against a
 * free-tier quota. That is why the ceiling was LOWERED to 1 rather than raised,
 * and why this instruction exists instead of a bigger budget.
 *
 * TENSION WITH SYSTEM_STATIC, stated so the next reader does not think it is an
 * accident. packages/agent's static prompt says "emit ONE tool call per
 * section, in reading order … never pack multiple sections into a single call,
 * and never hold sections back to emit them together." The first two clauses
 * are preserved verbatim in spirit here: one call per section, reading order.
 * The third was written about a DIFFERENT failure (a model that composes
 * silently and dumps everything at the end, defeating progressive rendering),
 * and a model reading it can easily take it as "never emit two calls in one
 * response" — the exact behaviour we need. This block therefore says the quiet
 * part explicitly, including WHY progressive rendering survives: the calls
 * still stream one after another inside the response, and the client applies
 * each one the moment it arrives.
 */
const PARALLEL_SECTION_CALLS_NOTE = [
  "SEND EVERY SECTION IN ONE RESPONSE.",
  "Emit one tool call per section, in reading order, top to bottom — and put them ALL in this one response rather than emitting a single call and waiting.",
  "Nothing is held back by doing this: the calls still stream out one after another, and each section appears on the canvas the moment its own call completes, so the person watches the email assemble either way.",
  "You get very few rounds. A response carrying one section produces a one-section email, which is the single outcome that counts as a failure here.",
].join(" ");

/**
 * The source-parity target, as a number the model is told rather than a
 * property we hope for.
 *
 * "ROUGHLY" IS THE REQUIREMENT AND IT STAYS ROUGHLY. A design variation is
 * supposed to change how many sections there are — the variation prompt below
 * explicitly invites splitting one section into two, folding two into one, and
 * adding a section the source does not have — so a hard equality target would
 * fight the feature. What the target really supplies is a FLOOR: nobody has
 * ever complained that a generated draft had too many sections.
 */
function buildSectionTargetLine({
  sourceDraftName,
  sourceSectionCount,
}: {
  sourceDraftName: string;
  sourceSectionCount: number;
}): string {
  if (sourceSectionCount <= 0) {
    return `HOW BIG IT SHOULD BE. Build a complete email — about ${FALLBACK_SECTION_TARGET} sections: a header, something that leads, two or three body sections, and a footer. One or two sections is not an email.`;
  }
  const target =
    `HOW BIG IT SHOULD BE. "${sourceDraftName}" has ${sourceSectionCount} ` +
    `${sourceSectionCount === 1 ? "section" : "sections"}, so build about ${sourceSectionCount} — give or take one or two.`;
  // The floor only needs saying when there is room to fall short of it; on a
  // one- or two-section source the target IS one or two, and warning against
  // that number would contradict the line above it.
  return sourceSectionCount <= 2
    ? target
    : `${target} Going over is fine; coming in well under is not — a ${sourceSectionCount}-section email that comes back as one or two sections is not a version of it at all.`;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export interface IdeateDraftPromptInput {
  /** The draft being riffed on, by its user-facing name. */
  sourceDraftName: string;
  /** {@link buildIdeationOutline} of the source draft — the LOSSY view. */
  sourceOutline: string;
  /** {@link countSourceSections} of the source draft. 0 when it is empty. */
  sourceSectionCount: number;
  /**
   * What the person typed in the ideate dialog's direction field, verbatim and
   * unparsed. Empty when they just picked "Ideate with AI" and pressed go —
   * which is the common case and must still produce a whole email.
   */
  direction: string;
}

/**
 * "Ideate with AI": a fresh concept for this canvas, on the same subject.
 *
 * WHAT THE SOURCE OUTLINE IS HERE, AND THE TENSION IT CREATES. This path takes
 * the outline's DEFAULT 60-char clip (see the module header): subject matter
 * and audience survive, the wording does not. That is not an oversight — it is
 * what makes ideate ideate rather than paraphrase, and it is the only thing
 * separating this feature from "Add design variation", which deliberately
 * raises the clip to {@link VARIATION_MAX_TEXT_CHARS} so the words DO survive.
 *
 * The owner then asked this path to "base the new text content off of the
 * existing text content", which wants more fidelity than 60 characters carries.
 * RESOLVED BY CHANGING THE ASK, NOT THE CLIP: the prompt below tells the model
 * to carry the SUBJECT, the claims and the offer forward and to write the copy
 * fresh, and to riff on the section TYPES the source uses rather than its
 * sentences. That is what "base … off of" and "different VARIANTS of the
 * sections" describe; "keep the words" is variation's language, and variation
 * already has it. Raising the clip would have quietly merged the two features,
 * and if they are going to converge the honest move is to merge them, not to
 * let them drift.
 *
 * The other three defaults the owner listed — try various layouts, make style
 * updates, and vary the sections that exist in the source — are stated outright
 * here for the same reason: the user should not have to type any of them.
 */
export function buildIdeateDraftPrompt({
  sourceDraftName,
  sourceOutline,
  sourceSectionCount,
  direction,
}: IdeateDraftPromptInput): string {
  const trimmedDirection = direction.trim();
  const sections: string[] = ["Design a complete email from scratch in this blank draft."];
  if (sourceOutline.length > 0) {
    sections.push(
      `For context, here is a content outline of "${sourceDraftName}", another draft on this canvas:\n\n${sourceOutline}\n\n` +
        `That outline is CLIPPED on purpose: it tells you what the email is about, who it talks to and how it is put together, but not its exact sentences. ` +
        `The block ids in it belong to that other draft; this draft is empty, so never refer to them.`,
    );
  }
  sections.push(
    [
      "How to build it:",
      "",
      "1. SAME SUBJECT, FRESH WORDS. Carry over what the source is about — its topic, its audience, its claims, its offer, its call to action — and write the copy yourself in your own words. You are not reconstructing sentences you cannot see, and you are not inventing a different company, product or campaign either. Everything this email says should be recognisably about the same thing the outline describes.",
      "2. RIFF ON THE SECTIONS IT HAS. Look at the section types the source uses and build VARIANTS of them: if it leads with a plain headline, try a hero with the headline over an image; if it has a three-column feature row, try two columns with a bigger picture, or a stacked list, or a stat row. Same job, different execution.",
      "3. TRY A DIFFERENT LAYOUT. This should not read as the same email retyped. Change the order things appear in, change how many columns a row has, put an image where the source had none, lead with something else entirely.",
      "4. RESTYLE IT. You have the theme here — unlike a design variation, nothing has been pre-applied. Pick colours, fonts and spacing that suit the subject and commit to them rather than leaving the defaults.",
      "",
      buildSectionTargetLine({ sourceDraftName, sourceSectionCount }),
    ].join("\n"),
  );
  if (trimmedDirection.length > 0) {
    sections.push(
      `The person asked for this specifically: "${trimmedDirection}"\n` +
        `Follow it. It outranks the defaults above wherever the two disagree — it is the whole reason they typed instead of just pressing the button.`,
    );
  }
  sections.push(PARALLEL_SECTION_CALLS_NOTE);
  return sections.join("\n\n");
}

export interface DesignVariationPromptInput {
  /** The draft being reimagined, by its user-facing name. */
  sourceDraftName: string;
  /** {@link buildVariationBrief} of the source draft. */
  sourceBrief: string;
  /** {@link countSourceSections} of the source draft. 0 when it is empty. */
  sourceSectionCount: number;
  /**
   * How the new draft is already themed ({@link resolveVariationThemeState} of
   * the two documents) — the source's theme, a deliberately varied one from
   * the brand kit, or nothing at all because the seed failed.
   */
  themeState: VariationThemeState;
  /**
   * What the person typed in the "Anything to change?" field, verbatim and
   * unparsed. This is the ONLY channel through which "make it lighter" can
   * reach the theme decision — the client never inspects it, the model reads
   * it as plain instruction.
   */
  direction: string;
}

/*
  The one sentence that tells the model what has ALREADY been done to this
  draft's theme, per {@link VariationThemeState}.

  `varied-theme` is the sentence this whole feature turned on. The variation's
  draft is now seeded with a DIFFERENT theme from the brand kit — the owner's
  point being that "it is a design variation after all" — and the old copy
  ("keep the theme from X", or worse, "match the look and feel of X") would have
  read as an instruction to undo the recolour that was the point. It still says
  KEEP, because the theme is a real kit variation the draft is now an instance
  of and re-picking colours would detach it; what changes is that it never
  claims the colours came from the source.
*/
const VARIATION_THEME_LINES: Readonly<
  Record<VariationThemeState, (input: { sourceDraftName: string }) => string>
> = {
  "source-theme": ({ sourceDraftName }) =>
    `The theme from "${sourceDraftName}" is already applied to this draft. Keep it — same colours, same fonts, same spacing — unless the person's direction below asks for something different.`,
  "varied-theme": () =>
    `A DIFFERENT theme from this brand kit is already applied to this draft, and that change of colours is part of the variation — it is deliberate, not a mistake to correct. Keep it exactly as it is — same colours, same fonts, same spacing — and design the layout to suit it, unless the person's direction below asks for something different.`,
  unthemed: ({ sourceDraftName }) =>
    `Match the look and feel of "${sourceDraftName}" — this is a layout variation, not a recolour.`,
};

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
 *
 * WHAT THE OWNER'S BRIEF ADDED, AND WHY IT IS ADDITIVE. The stated goal is
 * "I want the design variations to look visually appealing, and a lot of that
 * is with the images and theme that is selected." Most of the dimensions that
 * follow from it were already enumerated below — column flips, section order
 * and count, image placement and size — so three things are grafted on rather
 * than rewritten: the HERO move is named outright (it was only implied by
 * "leading the email … or full width and much larger"), the section-count
 * TARGET is stated (see {@link buildSectionTargetLine}), and the ASSET LIBRARY
 * becomes a second source of imagery. The "content is fixed, structure is free"
 * split and the ban on template sample copy are load-bearing and untouched:
 * they were written in response to a real regression.
 */
export function buildDesignVariationPrompt({
  sourceDraftName,
  sourceBrief,
  sourceSectionCount,
  themeState,
  direction,
}: DesignVariationPromptInput): string {
  const trimmedDirection = direction.trim();
  const sections: string[] = [
    `Design a complete email in this blank draft: a new take on "${sourceDraftName}", using that draft's own content.`,
    VARIATION_THEME_LINES[themeState]({ sourceDraftName }),
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
      "3. MOVE THE IMAGERY, AND CONSIDER LEADING WITH A HERO. Put the image somewhere it was not — beside the copy instead of above it, or full width and much larger. A hero is the strongest version of this move: one section at the top where a single image and the main headline carry the whole width, so the email opens with something to look at instead of a line of text. Reuse the same image addresses listed above rather than leaving placeholder pictures in place — a grey placeholder in a finished variation is a defect.",
      "4. ADD SOMEWHERE FOR THE EYE TO REST. Include one section the source does not have — a pull quote, a stat, a short highlight row — and fill it with real content drawn from the copy above.",
      "5. THE PERSON'S OWN IMAGE LIBRARY IS AVAILABLE, SECOND. The pictures listed above are known to belong to this email, so they come first. If the variation wants an image the source does not have — a backdrop for that hero, a logo in the footer, a photo beside a body section — call listAssets ON ITS OWN FIRST, before any section call: it returns this person's saved images and the results come back in the same turn, so asking costs nothing. Pick by the NAME, which is the only description you get, and by the kind when a name says little: reach for a \"Logo\" for a brand mark and an \"Uploaded\" or \"AI generated\" image for a photo or illustration. If nothing in the library plainly fits this email's subject, use none of it — an unrelated picture is a worse outcome than reusing the source's own.",
      "",
      "You have real creative freedom over the shape of this email. You have none over what it says.",
      "",
      buildSectionTargetLine({ sourceDraftName, sourceSectionCount }),
    ].join("\n"),
  );
  if (trimmedDirection.length > 0) {
    sections.push(
      `The person asked for this specifically: "${trimmedDirection}"\n` +
        `Follow it. If it asks for different colours, a different theme, or a different mood, change the theme to match — that instruction outranks keeping the current one.`,
    );
  }
  sections.push(PARALLEL_SECTION_CALLS_NOTE);
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

  // The source-parity target both prompts state (§1.4): one walk of the root's
  // children, on a document this function already had to read.
  const sourceSectionCount = countSourceSections(sourceDraft.doc);
  const direction = request.direction ?? "";

  const text =
    request.kind === "ideate"
      ? buildIdeateDraftPrompt({
          sourceDraftName: sourceDraft.name,
          sourceOutline: buildIdeationOutline(sourceDraft.doc),
          sourceSectionCount,
          direction,
        })
      : buildDesignVariationPrompt({
          sourceDraftName: sourceDraft.name,
          sourceBrief: buildVariationBrief(sourceDraft.doc),
          sourceSectionCount,
          themeState: resolveVariationThemeState({ sourceDoc: sourceDraft.doc, targetDoc }),
          direction,
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
