import { z } from "zod";
import type { GlobalStyles } from "../schema/globals";

/*
  NAMING A THEME AND A DRAFT — the vocabulary that lets the model re-theme
  something without ever holding a colour.

  THE RULE THIS MODULE EXISTS TO MAKE STRUCTURAL. The model must never supply,
  edit or invent a colour value. Today the only way it can theme anything is
  `applyTheme`, whose argument is a COMPLETE `GlobalStyles` object — so
  "use the colours you just read off wesbos.com" is asking a language model to
  transcribe a dozen hex triplets from one tool result into the next tool call,
  and every character it retypes is a character it can get wrong or improve on.
  A colour the model typed is a colour nobody chose.

  So the wire carries a NAME instead. `theme: "page"` or `theme: "Midnight"` is
  a reference the model can read off something it was given — the ingestion
  payload, the user's own sentence — and the RESOLVER on the other side turns
  it into real globals from a real source. The model cannot name a colour that
  does not exist, because it is not naming colours.

  THE SAME ARGUMENT APPLIES TO THE TARGET. `applyTheme` is a content operation
  and content operations are pure document transforms — an operation has no
  business carrying a document id, because the op log it lands in IS the
  document. What was missing is not a field on the operation but an ACTION
  above it that says which draft, and that is what `applyThemeToDraft` is.

  A DRAFT IS ADDRESSED BY NAME, NOT BY ROW ID (deliberate — see the note on
  {@link draftTargetSchema}). Both resolutions go through
  {@link matchNamedCandidate}, whose contract is the safety property: it never
  builds a pointer, it only picks an element out of a list the CALLER supplied.
  Give it the drafts on the user's own canvas and a draft on someone else's is
  not "refused", it is unreachable.

  Everything here is pure: schemas, normalization, and matching over lists the
  caller passes in. The lists themselves — this canvas's drafts, this kit's
  live themes, the page read in this turn — are gathered in the app, because
  that is where those things exist.
*/

// ---------------------------------------------------------------------------
// The reference vocabulary
// ---------------------------------------------------------------------------

/** Reference meaning "the theme the user's current draft is already wearing". */
export const CURRENT_THEME_REFERENCE = "current";

/** Reference meaning "the theme read off the page fetched in this turn". */
export const PAGE_THEME_REFERENCE = "page";

/** Draft target meaning "the draft the user is looking at right now". */
export const CURRENT_DRAFT_TARGET = "current";

/**
 * Longest reference string accepted, for a theme name or a draft name alike —
 * a NAME, never a payload. Matches `DRAFT_NAME_MAX_LENGTH`, and is declared
 * here rather than imported from compose-draft because this module must not
 * depend on that one: compose-draft reads {@link themeReferenceSchema} at
 * module-init time, and a cycle between the two would leave whichever loaded
 * second holding an undefined schema.
 */
export const MAX_REFERENCE_LENGTH = 60;

/*
  A PLAIN STRING, NOT A PATTERN. The grammar is small enough to police with a
  regex, and doing so would be the obvious move — except that the free tier of
  several OpenRouter models rejects a JSON Schema carrying `pattern` outright,
  taking the whole toolset down with it. The description carries the grammar
  and the resolver enforces it; a reference that means nothing comes back as a
  named refusal listing what WOULD have worked, which is more useful to the
  model than a schema violation anyway.
*/
export const themeReferenceSchema = z
  .string()
  .min(1)
  .max(MAX_REFERENCE_LENGTH)
  .describe(
    `Which theme to use, BY NAME — never a colour. Use "${PAGE_THEME_REFERENCE}" for the colours and fonts read off the web page you fetched this turn (the ingestion result's \`theme\`), "${CURRENT_THEME_REFERENCE}" for the theme already on the user's draft, or the name of one of this canvas's saved themes exactly as the user said it (e.g. "Midnight"). Never pass a hex value, a colour name, or a styles object: you do not author colours, you name a theme that already exists.`,
  );

/*
  WHY A NAME AND NOT A DOCUMENT ID, since the browser plainly has ids.

  1. The name is what the model has ALREADY been given. createDraft's report
     hands back the names actually allocated ("use these exact names — the
     drafts bar renames duplicates"), and it is what the user says out loud:
     "put that on Launch v2". An id would need a second surface built to
     publish it, and a name the model has to carry alongside it anyway.
  2. A name is a LOOKUP KEY, an id is a POINTER. Matching a name against the
     drafts on the user's open canvas cannot reach a draft that is not on it.
     Handing the model row ids invites the opposite shape — an address that
     means something on its own — and then the authorization has to be
     re-established at the other end, every time, forever.
  3. An id in a tool call is an id in the TRANSCRIPT, which persists across
     turns and gets replayed. Draft names are already visible to the user in
     the drafts bar; internal row ids are not, and a value the user cannot see
     is a value they cannot notice going wrong.

  The cost is ambiguity: two drafts can share a name after a rename. That is
  reported, never guessed — see {@link matchNamedCandidate}.
*/
export const draftTargetSchema = z
  .string()
  .min(1)
  .max(MAX_REFERENCE_LENGTH)
  .describe(
    `Which draft to act on, by its name in the drafts bar exactly as it appears there (createDraft's result tells you the names it actually allocated). Omit it, or pass "${CURRENT_DRAFT_TARGET}", for the draft the user is looking at.`,
  );

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * A reference reduced to what a human meant by it: case, spacing, and the
 * punctuation that separates words all dropped, so "Warm Sand", "warm-sand"
 * and "warmSand" are one key. Ids in this codebase are slugs of names
 * (`buildUniqueVariationId`), so this is also what makes an id and its display
 * name collapse onto each other without a second lookup table.
 */
export function normalizeReferenceKey(reference: string): string {
  return reference.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** What a name lookup found in the caller's list. */
export type NamedCandidateMatch<Candidate> =
  | { isMatched: true; candidate: Candidate }
  /** Nothing in the list answers to that name. */
  | { isMatched: false; reason: "unknown" }
  /** Two or more do. Refused rather than picked — see below. */
  | { isMatched: false; reason: "ambiguous" };

/**
 * Pick the ONE element of `candidates` that answers to `query`, or say why
 * not.
 *
 * AMBIGUITY IS A REFUSAL, not a tie-break. Picking the first of two drafts
 * called "Launch" restyles a real document the user did not mean, and the only
 * evidence would be a sentence claiming the other one. Every failure here is
 * recoverable by asking; a wrong apply is recoverable only by undo, in a draft
 * the user is not looking at.
 *
 * Each candidate may answer to several names (a theme has an id AND a display
 * name); matching any of them counts as one match for that candidate.
 */
export function matchNamedCandidate<Candidate>({
  query,
  candidates,
  getNames,
}: {
  query: string;
  candidates: readonly Candidate[];
  /** Every name this candidate answers to. */
  getNames: (candidate: Candidate) => readonly string[];
}): NamedCandidateMatch<Candidate> {
  const key = normalizeReferenceKey(query);
  if (key.length === 0) {
    return { isMatched: false, reason: "unknown" };
  }
  const matches = candidates.filter((candidate) =>
    getNames(candidate).some((name) => normalizeReferenceKey(name) === key),
  );
  const [first] = matches;
  if (first === undefined) {
    return { isMatched: false, reason: "unknown" };
  }
  if (matches.length > 1) {
    return { isMatched: false, reason: "ambiguous" };
  }
  return { isMatched: true, candidate: first };
}

// ---------------------------------------------------------------------------
// Theme resolution
// ---------------------------------------------------------------------------

/**
 * One theme the resolver may choose: a name a person would say, the id it is
 * stored under, and the COMPLETE globals payload `applyTheme` takes.
 *
 * The caller builds this list, and what it leaves out is as load-bearing as
 * what it puts in: a soft-deleted variation must never appear here, because a
 * draft wearing a theme its kit no longer offers is the stranded state soft
 * deletion exists to avoid (`getLiveThemeVariations` is that filter).
 */
export interface NamedTheme {
  /** Stable id within its kit ("warm-sand"). */
  id: string;
  /** Human-readable name as the dropdown shows it ("Warm Sand"). */
  name: string;
  /** The complete `applyTheme` argument. */
  globals: GlobalStyles;
}

/** The page's own theme, when this turn read a page that declared one. */
export interface PageTheme {
  globals: GlobalStyles;
  /** Which page signals produced it — the model relays this, not the hexes. */
  source: string;
  /** The page it came off, for the sentence the user reads. */
  url: string;
}

/** Where a resolved theme came from — the model says this, in its own words. */
export type ResolvedThemeSource = "page" | "kit" | "current";

export type ThemeResolution =
  | {
      isResolved: true;
      source: ResolvedThemeSource;
      /** How to refer to it in prose ("wesbos.com's own colours", "Midnight"). */
      name: string;
      globals: GlobalStyles;
      /** Present for a page theme: which signals produced it. */
      derivedFrom?: string;
      /** Present for a kit theme: the variation id, for the brand pointer. */
      variationId?: string;
    }
  | {
      isResolved: false;
      reason: "no-page-theme" | "no-current-theme" | "unknown-theme" | "ambiguous-theme";
      /** The names that WOULD have worked — the model's way back. */
      availableThemeNames: string[];
    };

export interface ResolveThemeReferenceInput {
  /** The model's reference. */
  reference: string;
  /** The page theme this turn read, or null when it read no page (or an unstyled one). */
  pageTheme: PageTheme | null;
  /** This canvas's LIVE themes — soft-deleted variations must not be here. */
  kitThemes: readonly NamedTheme[];
  /**
   * The globals on the draft the user is currently looking at, or null when it
   * is on the shared defaults. `{}` and null mean the same thing here: there
   * is no theme to copy, only the renderer's own.
   */
  currentGlobals: GlobalStyles | null;
}

/**
 * Turn one reference into real globals, or into the honest reason it could
 * not be. NEVER invents, adjusts, or completes a colour: every arm returns a
 * payload that was authored by the page, by the kit, or by the user's own
 * draft.
 *
 * The failure arms all carry `availableThemeNames`, because a refusal that
 * does not say what would have worked makes the model guess, and guessing at a
 * theme name is one step from guessing at a colour.
 */
export function resolveThemeReference({
  reference,
  pageTheme,
  kitThemes,
  currentGlobals,
}: ResolveThemeReferenceInput): ThemeResolution {
  const availableThemeNames = kitThemes.map((theme) => theme.name);
  const key = normalizeReferenceKey(reference);

  if (key === normalizeReferenceKey(PAGE_THEME_REFERENCE)) {
    if (pageTheme === null) {
      return { isResolved: false, reason: "no-page-theme", availableThemeNames };
    }
    return {
      isResolved: true,
      source: "page",
      name: pageTheme.url,
      globals: pageTheme.globals,
      derivedFrom: pageTheme.source,
    };
  }

  if (key === normalizeReferenceKey(CURRENT_THEME_REFERENCE)) {
    if (currentGlobals === null || Object.keys(currentGlobals).length === 0) {
      return { isResolved: false, reason: "no-current-theme", availableThemeNames };
    }
    return { isResolved: true, source: "current", name: "the current theme", globals: currentGlobals };
  }

  const match = matchNamedCandidate({
    query: reference,
    candidates: kitThemes,
    getNames: (theme) => [theme.id, theme.name],
  });
  if (!match.isMatched) {
    return {
      isResolved: false,
      reason: match.reason === "ambiguous" ? "ambiguous-theme" : "unknown-theme",
      availableThemeNames,
    };
  }
  return {
    isResolved: true,
    source: "kit",
    name: match.candidate.name,
    globals: match.candidate.globals,
    variationId: match.candidate.id,
  };
}

// ---------------------------------------------------------------------------
// Draft resolution
// ---------------------------------------------------------------------------

/** One draft the target may name — whatever the caller uses to reach it. */
export interface NamedDraft<DocumentId> {
  documentId: DocumentId;
  name: string;
}

export type DraftTargetResolution<DocumentId> =
  | { isResolved: true; documentId: DocumentId; name: string }
  | {
      isResolved: false;
      reason: "no-current-draft" | "unknown-draft" | "ambiguous-draft";
      /** The drafts on this canvas — the model's way back. */
      availableDraftNames: string[];
    };

/**
 * Resolve which draft to act on, ONLY ever to one of `drafts`.
 *
 * `drafts` is the caller's own canvas listing, which is the whole
 * authorization argument: a name that matches nothing on this canvas resolves
 * to nothing, so a draft belonging to another canvas or another person is not
 * refused by a check that could be forgotten — it was never a candidate.
 */
export function resolveDraftTarget<DocumentId>({
  target,
  drafts,
  currentDocumentId,
}: {
  /** The model's target, or undefined for "the draft the user is on". */
  target: string | undefined;
  /** Every draft on the user's current canvas. */
  drafts: readonly NamedDraft<DocumentId>[];
  /** The draft the user is looking at, when there is one. */
  currentDocumentId: DocumentId | null;
}): DraftTargetResolution<DocumentId> {
  const availableDraftNames = drafts.map((draft) => draft.name);
  const isCurrentRequested =
    target === undefined || normalizeReferenceKey(target) === normalizeReferenceKey(CURRENT_DRAFT_TARGET);

  if (isCurrentRequested) {
    const current =
      currentDocumentId === null
        ? undefined
        : drafts.find((draft) => draft.documentId === currentDocumentId);
    if (current === undefined) {
      return { isResolved: false, reason: "no-current-draft", availableDraftNames };
    }
    return { isResolved: true, documentId: current.documentId, name: current.name };
  }

  const match = matchNamedCandidate({
    query: target,
    candidates: drafts,
    getNames: (draft) => [draft.name],
  });
  if (!match.isMatched) {
    return {
      isResolved: false,
      reason: match.reason === "ambiguous" ? "ambiguous-draft" : "unknown-draft",
      availableDraftNames,
    };
  }
  return { isResolved: true, documentId: match.candidate.documentId, name: match.candidate.name };
}

// ---------------------------------------------------------------------------
// The applyThemeToDraft action's wire shapes
// ---------------------------------------------------------------------------

export const applyThemeToDraftInputSchema = z
  .strictObject({
    theme: themeReferenceSchema,
    draft: draftTargetSchema.optional(),
  })
  .describe(
    "Applies an EXISTING theme — the page you just read, one of this canvas's saved themes, or the current draft's — to one draft, which may be a draft the user is not looking at. Names a theme; never carries colours.",
  );

export type ApplyThemeToDraftInput = z.infer<typeof applyThemeToDraftInputSchema>;

export const applyThemeToDraftCommandSchema = z
  .strictObject({
    type: z.literal("applyThemeToDraft").describe("Command discriminator."),
    theme: themeReferenceSchema,
    draft: draftTargetSchema.optional().describe("Target draft name; absent = the user's current draft."),
  })
  .describe("Client command: resolve a theme reference and a draft name, then re-theme that draft.");

export type ApplyThemeToDraftCommand = z.infer<typeof applyThemeToDraftCommandSchema>;
