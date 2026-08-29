import type { BlockId } from "@flock/email-sdk";
import type { FlockChatMessage } from "@/lib/chat-contract";

/**
 * The chat transcript's NARRATION ENGINE — every word the panel says about
 * what the agent is doing, while it is doing it. Pure functions only, so the
 * phrasing is unit-testable without a DOM (see turn-activity.test.ts).
 *
 * Two laws govern every string produced here:
 *
 * 1. NOTHING INTERNAL REACHES THE SCREEN. Not a tool name, not a camelCase
 *    identifier de-camel-cased into words, not a block id, not an enum value.
 *    A tool this module has never heard of falls back to deliberately neutral
 *    copy ({@link FALLBACK_ACTIVITY_PHRASE}) — the agent's toolset changes
 *    faster than this map does, and a missing entry must read as calm plain
 *    English, never as a leaked identifier.
 * 2. PRESENT TENSE WHILE IT HAPPENS, PAST TENSE ONCE IT LANDED. A streaming
 *    turn reads as a live account ("Adding a section"), and the finished
 *    transcript reads as a record of what was done ("Added a section").
 *
 * The surfaces that consume this: ToolPartChip (one step) and
 * TurnActivityIndicator (the gaps BETWEEN steps, where nothing else narrates).
 */

// ---------------------------------------------------------------------------
// Per-step phrasing
// ---------------------------------------------------------------------------

export interface ActivityPhrase {
  /** Shown while the step is running: "Adding a section". */
  present: string;
  /** Shown once the step landed: "Added a section". */
  past: string;
}

/** Tools that only LOOK at things — the chip renders them quieter. */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "getBlockDetails",
  "readWebPage",
  "listAssets",
]);

/**
 * A tool whose phrasing depends on its arguments (plurals, mostly). Returning
 * a phrase from the input keeps the common case declarative.
 */
type ActivityPhraseResolver = (input: Readonly<Record<string, unknown>>) => ActivityPhrase;

type ActivityEntry = ActivityPhrase | ActivityPhraseResolver;

/**
 * Internal tool name → what the user is told. Deliberately verb-first and
 * short: the chip is ~300px wide and these read as a running commentary.
 */
const ACTIVITY_PHRASES: Readonly<Record<string, ActivityEntry>> = {
  updateBlockProperties: { present: "Restyling", past: "Restyled" },
  replaceBlockProperties: { present: "Restyling", past: "Restyled" },
  updateDocumentSettings: {
    present: "Updating the overall look",
    past: "Updated the overall look",
  },
  applyTheme: { present: "Applying the theme", past: "Applied the theme" },
  addBlock: { present: "Adding", past: "Added" },
  addSection: { present: "Adding a section", past: "Added a section" },
  scaffoldSection: { present: "Building a section", past: "Built a section" },
  restoreBlocks: { present: "Putting content back", past: "Put content back" },
  removeBlock: { present: "Removing", past: "Removed" },
  moveBlock: { present: "Moving", past: "Moved" },
  reorderChildren: { present: "Reordering", past: "Reordered" },
  placeBlockBeside: { present: "Placing side by side", past: "Placed side by side" },
  unplaceBlockBeside: { present: "Stacking back into one column", past: "Stacked back into one column" },
  updateText: { present: "Rewriting the wording", past: "Rewrote the wording" },
  styleTextSpan: { present: "Styling the wording", past: "Styled the wording" },
  showPreview: { present: "Switching the preview", past: "Switched the preview" },
  sendTestEmail: { present: "Sending a test email", past: "Sent a test email" },
  generateImage: { present: "Creating an image", past: "Created an image" },
  openPanel: { present: "Opening", past: "Opened" },
  undo: { present: "Undoing the last change", past: "Undid the last change" },
  redo: { present: "Redoing the last change", past: "Redid the last change" },
  goToVersion: { present: "Restoring", past: "Restored" },
  createDraft: (input) =>
    typeof input.count === "number" && input.count > 1
      ? { present: "Starting new drafts", past: "Started new drafts" }
      : { present: "Starting a new draft", past: "Started a new draft" },
  createPersona: { present: "Creating a persona", past: "Created a persona" },
  /*
    Named in the chip when the call names a draft, because this is the one
    action that can change a draft the user is NOT looking at — a neutral
    "Applying the theme" over an off-screen draft is a change with no visible
    cause.
  */
  applyThemeToDraft: (input) =>
    typeof input.draft === "string" && input.draft.length > 0
      ? { present: `Theming “${input.draft}”`, past: `Themed “${input.draft}”` }
      : { present: "Applying the theme", past: "Applied the theme" },
  // Widget tools: the chip shows only while the call streams in / when no
  // widget part was written — the widget itself supersedes it otherwise.
  askForClarification: { present: "Thinking of a question", past: "Asked a question" },
  proposeSectionVariations: { present: "Putting options together", past: "Put options together" },
  proposeEdits: { present: "Looking for improvements", past: "Found some improvements" },
  listAssets: { present: "Checking your image library", past: "Checked your image library" },
  getBlockDetails: { present: "Taking a closer look", past: "Took a closer look" },
  /*
    Deliberately neutral. This chip is written BEFORE the page has been read,
    so it cannot say what kind of page it is without making exactly the guess
    this pipeline was rebuilt to stop making.
  */
  readWebPage: { present: "Reading the page you linked", past: "Read the page you linked" },
};

/**
 * What an UNMAPPED tool says. Neutral on purpose: it must be true of any
 * plausible new tool and must never hint at an internal name. This is the
 * safety net for the toolset changing underneath the UI — a tool being renamed
 * or added downgrades the copy's specificity, never its safety.
 */
export const FALLBACK_ACTIVITY_PHRASE: ActivityPhrase = {
  present: "Working on your email",
  past: "Updated your email",
};

/** True when this module has curated copy for the tool. */
export function getIsKnownTool(toolName: string): boolean {
  return Object.hasOwn(ACTIVITY_PHRASES, toolName);
}

export interface GetActivityPhraseInput {
  toolName: string;
  /** The tool call's arguments, if any have streamed in yet. */
  input?: unknown;
  /**
   * The tool's RESULT, once it has one. Only consulted for steps that can
   * legitimately do nothing — see {@link getUnsteppedHistoryPhrase}.
   */
  output?: unknown;
}

/*
  THE STEP THAT DIDN'T HAPPEN.

  undo and redo are the only tools whose successful result can mean "nothing
  changed": the browser performs the real history mutation and reports
  `isStepped: false` when the draft had no step left to take. Law 2 above tenses
  the sentence, but tense alone would still say "Undid the last change" over a
  document nobody touched — the same fabricated confirmation the agent's own
  prose used to give. So the OUTCOME, not just the state, picks the words.
*/
function getIsUnsteppedHistoryOutput(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    "isStepped" in output &&
    output.isStepped === false
  );
}

const UNSTEPPED_HISTORY_PHRASES: Readonly<Record<string, ActivityPhrase>> = {
  undo: { present: "Undoing the last change", past: "Nothing left to undo" },
  redo: { present: "Redoing the last change", past: "Nothing to redo" },
};

function getUnsteppedHistoryPhrase({
  toolName,
  output,
}: GetActivityPhraseInput): ActivityPhrase | undefined {
  const phrase = UNSTEPPED_HISTORY_PHRASES[toolName];
  if (phrase === undefined || !getIsUnsteppedHistoryOutput(output)) {
    return undefined;
  }
  return phrase;
}

/** The phrase pair for one tool call — never the tool's own name. */
export function getActivityPhrase({
  toolName,
  input,
  output,
}: GetActivityPhraseInput): ActivityPhrase {
  const unsteppedPhrase = getUnsteppedHistoryPhrase({ toolName, output });
  if (unsteppedPhrase !== undefined) {
    return unsteppedPhrase;
  }
  const entry = ACTIVITY_PHRASES[toolName];
  if (entry === undefined) {
    return FALLBACK_ACTIVITY_PHRASE;
  }
  if (typeof entry !== "function") {
    return entry;
  }
  const argumentObject =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  return entry(argumentObject);
}

/** The single line a chip shows, tensed by whether the step has landed. */
export function getActivityLabel(
  input: GetActivityPhraseInput & { isComplete: boolean },
): string {
  const phrase = getActivityPhrase(input);
  return input.isComplete ? phrase.past : phrase.present;
}

// ---------------------------------------------------------------------------
// Target labels ("… · button")
// ---------------------------------------------------------------------------

/**
 * Block type → what the user calls it. Only the types whose internal name is
 * not already plain English need an entry; everything else ("button", "image",
 * "text"…) is its own best label.
 */
const BLOCK_TYPE_LABELS: Readonly<Record<string, string>> = {
  root: "whole email",
  row: "layout row",
  code: "custom code",
};

/** The user-facing name of the block a step targets. */
export function getBlockTypeLabel(blockType: string | undefined): string | undefined {
  if (blockType === undefined) {
    return undefined;
  }
  return BLOCK_TYPE_LABELS[blockType] ?? blockType;
}

/** openPanel enum value → the human surface name shown after "Opening ·". */
const PANEL_TARGET_LABELS: Readonly<Record<string, string>> = {
  theme: "theme",
  "brand-kit": "brand kit",
  library: "asset library",
  agents: "agent personas",
  recommendations: "recommendations",
  history: "version history",
  blocks: "blocks tab",
  properties: "properties tab",
  "send-test": "send test",
};

/** The step's target blockId, if its input carries one (never user-facing). */
export function getTargetBlockId(input: unknown): BlockId | undefined {
  const argumentObject = input as Record<string, unknown> | undefined;
  return typeof argumentObject?.blockId === "string"
    ? (argumentObject.blockId as BlockId)
    : undefined;
}

/**
 * Human-readable non-block target: a recipient, a viewport mode, a panel…
 *
 * Gated on the tool being KNOWN. These fields are read positionally out of
 * model-supplied arguments, so for a tool this module has never seen there is
 * no guarantee that `mode`/`panel`/`name` hold anything a user should read —
 * an unmapped tool therefore contributes no target at all. The block-type
 * target is exempt from that rule elsewhere: it is looked up in the document,
 * not taken from the model.
 */
export function getNonBlockTargetLabel({ toolName, input }: GetActivityPhraseInput): string | undefined {
  if (!getIsKnownTool(toolName)) {
    return undefined;
  }
  const argumentObject = input as Record<string, unknown> | undefined;
  if (argumentObject === undefined || argumentObject === null) {
    return undefined;
  }
  if (typeof argumentObject.mode === "string") {
    return argumentObject.mode;
  }
  if (typeof argumentObject.to === "string") {
    return argumentObject.to;
  }
  if (typeof argumentObject.panel === "string") {
    return PANEL_TARGET_LABELS[argumentObject.panel] ?? undefined;
  }
  if (typeof argumentObject.version === "number") {
    return `version ${argumentObject.version}`;
  }
  if (typeof argumentObject.count === "number" && argumentObject.count > 1) {
    return `${argumentObject.count} drafts`;
  }
  // createPersona: the persona's display name is the target.
  if (typeof argumentObject.name === "string" && toolName === "createPersona") {
    return argumentObject.name;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Between-step narration (the TurnActivityIndicator)
// ---------------------------------------------------------------------------

/**
 * The shape the indicator needs out of the live turn's parts. Deliberately
 * narrow so the phase logic is testable without constructing AI SDK messages.
 */
export type TurnPart =
  | { kind: "text"; hasContent: boolean }
  | { kind: "step"; isSettled: boolean }
  | { kind: "other" };

/**
 * Tool-part states that mean "this step is over, one way or another" — the
 * agent is no longer executing it, so the turn's next silence belongs to the
 * model deciding what to do next, not to this step.
 */
const SETTLED_TOOL_PART_STATES: ReadonlySet<string> = new Set([
  "output-available",
  "output-error",
  "output-denied",
]);

/**
 * Project a live assistant message's parts down to what the indicator needs.
 * Anything that is not prose or a step (widget data parts, sources, files)
 * counts as settled content: it was written, so the agent has moved on.
 */
export function toTurnParts(parts: readonly FlockChatMessage["parts"][number][]): TurnPart[] {
  return parts.map((part): TurnPart => {
    if (part.type === "text") {
      return { kind: "text", hasContent: part.text.length > 0 };
    }
    if (part.type.startsWith("tool-")) {
      const state = (part as { state?: unknown }).state;
      return {
        kind: "step",
        isSettled: typeof state === "string" && SETTLED_TOOL_PART_STATES.has(state),
      };
    }
    return { kind: "other" };
  });
}

/**
 * What the indicator says right now, or null when another surface is already
 * narrating (a spinning step chip, or prose streaming in) and a second live
 * status line would just be noise.
 */
export interface TurnActivity {
  /**
   * "waiting" — the request is out and nothing has come back yet.
   * "next-step" — a step landed and the agent is deciding what to do next.
   * Distinguished so the indicator can key its animation and tests can assert
   * the phase without matching on copy.
   */
  phase: "waiting" | "next-step";
  message: string;
}

/**
 * How long a silent wait runs before the copy acknowledges it. A first model
 * response usually lands well inside this; past it, silence starts to read as
 * a hang, so the indicator says so rather than repeating itself.
 */
export const SLOW_TURN_THRESHOLD_MS = 9_000;

export interface DescribeTurnActivityInput {
  /** True while the turn is in flight (submitted or streaming). */
  isTurnInProgress: boolean;
  /** The live turn's parts, oldest first. Empty before anything streams back. */
  parts: readonly TurnPart[];
  /** Milliseconds since this turn was submitted. */
  elapsedMs: number;
}

export function describeTurnActivity({
  isTurnInProgress,
  parts,
  elapsedMs,
}: DescribeTurnActivityInput): TurnActivity | null {
  if (!isTurnInProgress) {
    return null;
  }
  // Ignore parts that say nothing (an empty text part is written the moment
  // the assistant message opens, before a single token arrives).
  const narratableParts = parts.filter(
    (part) => !(part.kind === "text" && !part.hasContent),
  );
  const lastPart = narratableParts.at(-1);

  if (lastPart === undefined) {
    return {
      phase: "waiting",
      message:
        elapsedMs >= SLOW_TURN_THRESHOLD_MS
          ? "Still thinking — this one needs a moment…"
          : "Thinking it through…",
    };
  }
  // Prose streaming in is its own narration; so is a step chip that is still
  // spinning with its own label. Neither needs a second line saying so.
  if (lastPart.kind === "text") {
    return null;
  }
  if (lastPart.kind === "step" && !lastPart.isSettled) {
    return null;
  }
  return { phase: "next-step", message: "Working out the next step…" };
}
