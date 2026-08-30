import type { ThemeResolution } from "@flock/email-sdk";
import type { CreateDraftReport, CreatedDraftReport } from "./chat-contract";

/*
  WHAT THE AGENT IS ALLOWED TO SAY ABOUT A DRAFT IT CREATED.

  The reported defect, in the owner's words: "create a new draft based on my
  portfolio website: sprioleau.dev". Two green tool chips, then —

    "I've created a new draft in your drafts bar called 'San'Quan Prioleau -
     Portfolio', built directly from your website details and portfolio
     projects (including Flock, Dobble Go, and teeny.fun) with your portrait
     image and background included."

  The draft contained none of that. It was the catalog's sample email, and one
  of its paragraphs was character-identical to the user's OTHER draft sitting
  on screen beside it.

  Two separate failures produced that sentence, and this module answers the
  second one. The first — the composer silently backfilling from the source
  draft — is fixed in the SDK (`shouldCarryOverSourceCopy`, compose-draft.ts).
  The second is that the sentence was never derived from the draft at all: the
  model's tool result was composed SERVER-SIDE from the plan it had just sent,
  and the plan is a statement of intent. It was accurate about what the model
  meant to build and structurally incapable of being wrong about it.

  So the model is now told three things it could not previously know, all of
  them observed after the drafts exist:

  1. HOW MANY DRAFTS LANDED, and under WHAT NAMES. Draft names are deduped per
     canvas as they are allocated, so "the name I asked for" and "the name in
     the drafts bar" are routinely different strings, and the agent quoting the
     former sends the user looking for a draft that is not there.
  2. WHERE EACH DRAFT'S WORDS CAME FROM — the model's own copy, the source
     draft carried over, or the section template's sample text. This is the
     fact that makes "built directly from your website" unsayable when it is
     not true.
  3. THAT IT MUST NOT CALL createDraft AGAIN. Every negative outcome here is
     terminal: a retry does not repair a draft, it adds a second one.

  Which is the same rule history-step-report.ts follows, for the same reason:
  a partial or empty outcome is a SUCCESSFUL tool result carrying a
  descriptive payload, never `output-error`. The error channel invites the
  model to correct itself, and there is nothing to correct — the draft was
  created; it is its copy that is thin.
*/

/*
  One draft the browser actually created, and where its copy came from.
*/
export type CreatedDraftSummary = CreatedDraftReport;

/*
  What a createDraft call did, as the browser that performed it observed it.
  Produced by `createAgentDrafts`; consumed only here.
*/
export interface CreateDraftOutcome {
  /*
    How many drafts the resolved command asked for.
  */
  requestedCount: number;
  /*
    The drafts that exist now, in creation order.
  */
  createdDrafts: CreatedDraftSummary[];
  /*
    True when the call carried a composition plan (false = empty starters).
  */
  isComposed: boolean;
  /*
    Whether the source draft's copy was allowed to fill gaps this turn. False
    when the turn ingested an external source — see `shouldCarryOverSourceCopy`
    in the SDK's compose-draft.
  */
  isSourceCopyCarryOverAllowed: boolean;
  /*
    A user-facing sentence when something went wrong, else null.
  */
  failureNotice: string | null;
  /*
    What the call's `theme` reference resolved to, or null when it named no
    theme (the ordinary path: the new drafts inherit the current one).

    REPORTED SEPARATELY FROM THE DRAFTS because it can fail on its own. A
    theme name the canvas does not have must not take the draft down with it —
    the drafts are created regardless, wearing what they would have worn —
    but neither may it pass unmentioned, because the model asked for a look it
    did not get and would otherwise describe the draft as having it.
  */
  theme: ThemeResolution | null;
}

/*
  The outcome of a call that never reached the drafts machinery.
*/
export function createEmptyDraftOutcome(): CreateDraftOutcome {
  return {
    requestedCount: 0,
    createdDrafts: [],
    isComposed: false,
    isSourceCopyCarryOverAllowed: true,
    failureNotice: null,
    theme: null,
  };
}

/*
  The sentence about the new drafts' LOOK — empty on the ordinary path, where
  nothing was asked for and inheritance quietly did its job.

  A resolved theme is said because the model is about to describe the draft and
  needs to know it may. An UNRESOLVED one is said louder: the drafts exist, so
  a retry is forbidden, and without this the model would either claim the look
  it asked for or fall silent about a request it did not fulfil. Both are worse
  than naming the themes that do exist and letting the user choose.
*/
function getThemeNote(theme: ThemeResolution | null): string {
  if (theme === null) {
    return "";
  }
  if (theme.isResolved) {
    if (theme.source === "page") {
      return `The new drafts are wearing the colours and fonts read off ${theme.name}${theme.derivedFrom === undefined ? "" : ` (${theme.derivedFrom})`} — say so, and say which page, since that is what makes the claim checkable.`;
    }
    if (theme.source === "kit") {
      return `The new drafts are wearing this canvas's saved "${theme.name}" theme.`;
    }
    return "The new drafts are wearing the same theme as the draft the user is on.";
  }
  const available =
    theme.availableThemeNames.length === 0
      ? "This canvas has no saved themes."
      : `This canvas's saved themes are ${toNameList(theme.availableThemeNames)}.`;
  const cause =
    theme.reason === "no-page-theme"
      ? "no page was read this turn, so there was no page theme to use"
      : theme.reason === "no-current-theme"
        ? "the user's current draft is on the default styling, so there was no theme to copy"
        : theme.reason === "ambiguous-theme"
          ? "that name matches more than one theme"
          : "no theme by that name exists";
  return `The theme you asked for was NOT applied: ${cause}. ${available} The drafts kept the theme they would otherwise have had — tell the user that, and offer one of the names above. Do NOT call createDraft again; use applyThemeToDraft on the draft by name.`;
}

/*
  `"a", "b" and "c"` — draft names as a person would read them aloud.
*/
function toNameList(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  if (quoted.length <= 1) {
    return quoted.join("");
  }
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]!}`;
}

function sumSections(drafts: CreatedDraftSummary[], key: keyof CreatedDraftSummary): number {
  return drafts.reduce((total, draft) => {
    const value = draft[key];
    return total + (typeof value === "number" ? value : 0);
  }, 0);
}

/*
  The copy-provenance sentence — the one that stops "built directly from your
  website" being said over sample text. Written as a plain count rather than a
  verdict, because the model is the one holding the source it read and is
  better placed than this module to say what is missing from which section.
*/
function getCopyProvenanceNote(outcome: CreateDraftOutcome): string {
  const { createdDrafts, isSourceCopyCarryOverAllowed } = outcome;
  const templateDefaultCount = sumSections(createdDrafts, "templateDefaultSectionCount");
  const carriedOverCount = sumSections(createdDrafts, "carriedOverSectionCount");
  const notes: string[] = [];
  if (templateDefaultCount > 0) {
    notes.push(
      `${templateDefaultCount} section${templateDefaultCount === 1 ? "" : "s"} had no copy in your plan and ${templateDefaultCount === 1 ? "is" : "are"} showing the section template's SAMPLE text${isSourceCopyCarryOverAllowed ? "" : " (this turn read an external source, so the user's other draft was not used to fill the gaps)"}. Do not describe ${templateDefaultCount === 1 ? "it" : "them"} as written from anything — tell the user those sections still need real copy, and offer to write them.`,
    );
  }
  if (carriedOverCount > 0) {
    notes.push(
      `${carriedOverCount} section${carriedOverCount === 1 ? "" : "s"} had no copy in your plan and ${carriedOverCount === 1 ? "was" : "were"} filled from the draft the user is already looking at. That copy is theirs, not yours and not from any source you read — do not present it as new.`,
    );
  }
  /*
    The two sentences that replace the sample-copy one. Composition no longer
    invents copy for a section the plan left empty — it rebuilds the section as
    a template the copy does fit, or leaves it out. Both are silent changes to
    what the model asked for, so both have to be said: without this the model
    describes an article and a footer it planned and neither of which exists,
    which is the same overclaim the sample-copy sentence was written to stop.
  */
  const substitutedCount = sumSections(createdDrafts, "substitutedSectionCount");
  const droppedCount = sumSections(createdDrafts, "droppedSectionCount");
  if (substitutedCount > 0) {
    notes.push(
      `${substitutedCount} section${substitutedCount === 1 ? "" : "s"} did not fit the template you asked for and ${substitutedCount === 1 ? "was" : "were"} rebuilt as a different one that fits the copy you gave. Describe what the draft actually contains, not the template you named.`,
    );
  }
  if (droppedCount > 0) {
    notes.push(
      `${droppedCount} section${droppedCount === 1 ? "" : "s"} had no copy to render and nothing in ${droppedCount === 1 ? "its" : "their"} category fitted, so ${droppedCount === 1 ? "it is" : "they are"} NOT in the draft. Do not describe ${droppedCount === 1 ? "it" : "them"} to the user — say what is missing, and offer to write it.`,
    );
  }
  return notes.join(" ");
}

/*
  The tool result for one createDraft call — the model's ONLY source of truth
  about what is now in the drafts bar. Never throws, and never returns a shape
  the caller should route through the error channel.
*/
export function toCreateDraftToolOutput(outcome: CreateDraftOutcome): CreateDraftReport {
  const { createdDrafts, requestedCount, failureNotice } = outcome;
  const createdCount = createdDrafts.length;

  if (createdCount === 0) {
    return {
      isCreated: false,
      createdDrafts: [],
      note: `No new draft was created. ${failureNotice ?? "The drafts bar was not reachable."} Tell the user in your own words that nothing was added, and do NOT call createDraft again.`,
    };
  }

  const names = toNameList(createdDrafts.map((draft) => draft.name));
  const namedAs = `named ${names} in the drafts bar (use these exact names — the drafts bar renames duplicates, so they may not be the names you asked for)`;

  if (createdCount < requestedCount) {
    return {
      isCreated: true,
      createdDrafts,
      note: `Only ${createdCount} of the ${requestedCount} drafts were created, ${namedAs}. ${failureNotice ?? ""} Tell the user which drafts exist and that the rest did not get made; do NOT call createDraft again to make up the difference. ${getCopyProvenanceNote(outcome)} ${getThemeNote(outcome.theme)}`.trim(),
    };
  }

  if (!outcome.isComposed) {
    return {
      isCreated: true,
      createdDrafts,
      note: `Created ${createdCount} EMPTY starter draft${createdCount === 1 ? "" : "s"}, ${namedAs}. ${createdCount === 1 ? "It has" : "They have"} no content — the user fills ${createdCount === 1 ? "it" : "them"} in. The user's current draft is untouched. Do NOT call createDraft again. ${getThemeNote(outcome.theme)}`.trim(),
    };
  }

  const provenanceNote = getCopyProvenanceNote(outcome);
  return {
    isCreated: true,
    createdDrafts,
    note: `Created ${createdCount} new draft${createdCount === 1 ? "" : "s"}, ${namedAs}. The user's current draft is untouched. ${provenanceNote === "" ? "Every section was built from the copy you passed. Tell the user what each new draft says." : `${provenanceNote} Then tell the user what each new draft actually says.`} ${getThemeNote(outcome.theme)} Do NOT call createDraft again.`.replace(/  +/g, " "),
  };
}
