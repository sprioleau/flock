import type { ResolvedThemeSource } from "@flock/email-sdk";
import type { ApplyThemeReport } from "@/lib/chat-contract";

/*
  WHAT THE AGENT IS ALLOWED TO SAY ABOUT A THEME IT APPLIED.

  Same rule as create-draft-report.ts and history-step-report.ts, for the same
  reason: only the browser can see what happened, so only the browser may say
  it. A theme apply has three separate ways of being described wrongly, and the
  report answers each of them with an observation rather than a plan.

  1. WHICH DRAFT. The whole reason this action exists is that `applyTheme`
     could only ever reach the turn's own document, so "theme the draft you
     just made" would have repainted the one the user was looking at. The
     report names the draft the write actually landed in, by the name in the
     drafts bar — not the name the model asked for, which may not exist.
  2. WHICH THEME, AND FROM WHERE. "I used your site's colours" is checkable
     only if the reply can say which signals produced them; the ingestion
     pipeline hands that sentence over (`theme.source`) and it is relayed here
     rather than re-derived. The model never sees a hex value at any point in
     this path, so it cannot describe one.
  3. WHETHER ANYTHING CHANGED. A draft already wearing the requested theme is
     the single most likely way for this whole feature to look like it worked
     while doing nothing — and it is exactly the outcome a naive "applied: true"
     would report identically to a real one. It gets its own arm.

  EVERY NEGATIVE OUTCOME RIDES THE SUCCESS CHANNEL. An unknown theme name, an
  unknown draft name, two drafts sharing a name — all are terminal facts the
  user needs told, and all of them come back with the list of names that WOULD
  have worked, so the model's next move is a correct call or a question rather
  than a guess. The error channel would invite it to retry blind, and the one
  thing worse than not theming a draft is theming the wrong one.
*/

/** What the executor observed. Produced by `applyThemeToDraft`; consumed here. */
export type ApplyThemeOutcome =
  | {
      kind: "applied";
      draftName: string;
      themeName: string;
      themeSource: ResolvedThemeSource;
      /** Present for a page theme: which page signals produced it. */
      derivedFrom?: string;
    }
  | {
      /** The draft was already wearing exactly this theme; nothing was written. */
      kind: "already-applied";
      draftName: string;
      themeName: string;
    }
  | {
      kind: "theme-unresolved";
      reason: "no-page-theme" | "no-current-theme" | "unknown-theme" | "ambiguous-theme";
      /** The reference the model asked for, echoed so the reply can name it. */
      requestedTheme: string;
      availableThemeNames: string[];
    }
  | {
      kind: "draft-unresolved";
      reason: "no-current-draft" | "unknown-draft" | "ambiguous-draft";
      requestedDraft: string;
      availableDraftNames: string[];
    }
  | {
      /** The write was attempted and refused — a real server outcome. */
      kind: "failed";
      draftName: string;
      themeName: string;
      message: string;
    }
  | {
      /*
        Nothing could be read or written at all. Its own arm rather than being
        folded into "unknown draft": telling the model a draft does not exist
        because Convex was unreachable is a fabrication of exactly the kind
        this module exists to prevent, and it would send the model off to
        correct a name that was never wrong.
      */
      kind: "unreachable";
    };

/** `"a", "b" and "c"` — names as a person would read them aloud. */
function toNameList(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  if (quoted.length === 0) {
    return "none";
  }
  if (quoted.length === 1) {
    return quoted[0]!;
  }
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]!}`;
}

/** How the model should describe where a resolved theme came from. */
function describeThemeSource({
  themeSource,
  themeName,
  derivedFrom,
}: {
  themeSource: ResolvedThemeSource;
  themeName: string;
  derivedFrom: string | undefined;
}): string {
  if (themeSource === "page") {
    return derivedFrom === undefined
      ? `Its colours and fonts were read off ${themeName}.`
      : `Its colours and fonts were read off ${themeName} — ${derivedFrom}. Say that, in your own words: it is what makes "I used your site's colours" checkable.`;
  }
  if (themeSource === "kit") {
    return `That is the saved "${themeName}" theme from this canvas's brand kit.`;
  }
  return "That is the theme the user's current draft was already wearing.";
}

/** The reason a theme reference resolved to nothing, in words the model relays. */
function describeThemeFailure(
  outcome: Extract<ApplyThemeOutcome, { kind: "theme-unresolved" }>,
): string {
  const available =
    outcome.availableThemeNames.length === 0
      ? "This canvas has no saved themes to choose from."
      : `This canvas's saved themes are ${toNameList(outcome.availableThemeNames)}.`;
  if (outcome.reason === "no-page-theme") {
    return `No theme was applied: nothing was read from a web page this turn, so there is no page theme to use. ${available} Ask the user which theme they want, or read a page first.`;
  }
  if (outcome.reason === "no-current-theme") {
    return `No theme was applied: the user's current draft is on the default styling, so there is no theme on it to copy. ${available}`;
  }
  if (outcome.reason === "ambiguous-theme") {
    return `No theme was applied: "${outcome.requestedTheme}" matches more than one theme, so it is not clear which was meant. ${available} Ask the user which one.`;
  }
  return `No theme was applied: "${outcome.requestedTheme}" is not a theme that exists. ${available} Use one of those names exactly, or "page" for a page you read this turn — and NEVER pass a colour value.`;
}

/** The reason a draft target resolved to nothing, in words the model relays. */
function describeDraftFailure(
  outcome: Extract<ApplyThemeOutcome, { kind: "draft-unresolved" }>,
): string {
  const available =
    outcome.availableDraftNames.length === 0
      ? "There are no drafts on this canvas."
      : `The drafts on this canvas are ${toNameList(outcome.availableDraftNames)}.`;
  if (outcome.reason === "no-current-draft") {
    return `No theme was applied: there is no draft open to apply it to. ${available}`;
  }
  if (outcome.reason === "ambiguous-draft") {
    return `No theme was applied: more than one draft is called "${outcome.requestedDraft}", and re-theming the wrong one is not recoverable by asking. ${available} Ask the user which they mean.`;
  }
  return `No theme was applied: there is no draft called "${outcome.requestedDraft}" on this canvas. ${available} Use one of those names exactly.`;
}

/**
 * The tool result for one applyThemeToDraft call — the model's ONLY source of
 * truth about whether a draft was re-themed and which one. Never throws, and
 * never returns a shape the caller should route through the error channel.
 */
export function toApplyThemeToolOutput(outcome: ApplyThemeOutcome): ApplyThemeReport {
  if (outcome.kind === "applied") {
    return {
      isApplied: true,
      draftName: outcome.draftName,
      themeName: outcome.themeName,
      note: `Applied the theme to "${outcome.draftName}" — that is the draft's name in the drafts bar, so use it. ${describeThemeSource({ themeSource: outcome.themeSource, themeName: outcome.themeName, derivedFrom: outcome.derivedFrom })} Every other draft is untouched, and the user may not be looking at this one — say which draft you changed.`,
    };
  }
  if (outcome.kind === "already-applied") {
    return {
      isApplied: false,
      draftName: outcome.draftName,
      themeName: outcome.themeName,
      /*
        Nothing was written, on purpose: re-applying an identical theme would
        add a no-op step to the draft's history for the user to undo past. Told
        plainly, because "done!" over an unchanged draft is the failure this
        whole reporting layer exists to prevent.
      */
      note: `Nothing changed: "${outcome.draftName}" was ALREADY wearing that theme, so no edit was made and its history is untouched. Tell the user it already looks that way — do NOT say you applied anything, and do not call this again for the same draft and theme.`,
    };
  }
  if (outcome.kind === "theme-unresolved") {
    return { isApplied: false, note: describeThemeFailure(outcome) };
  }
  if (outcome.kind === "draft-unresolved") {
    return { isApplied: false, note: describeDraftFailure(outcome) };
  }
  if (outcome.kind === "unreachable") {
    return {
      isApplied: false,
      note: "No theme was applied: the drafts could not be reached (connection error). Tell the user it did not go through and suggest trying again — do NOT tell them a draft or a theme does not exist, because nothing was checked.",
    };
  }
  return {
    isApplied: false,
    draftName: outcome.draftName,
    themeName: outcome.themeName,
    note: `The theme was NOT applied to "${outcome.draftName}": ${outcome.message} Tell the user it did not go through; do not claim the draft changed.`,
  };
}
