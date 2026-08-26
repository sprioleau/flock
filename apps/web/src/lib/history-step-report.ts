import {
  HISTORY_STEP_FAILURE_REASONS,
  type HistoryStepFailureReason,
  type HistoryStepToolOutput,
} from "./chat-contract";

/*
  WHAT THE AGENT IS ALLOWED TO SAY ABOUT AN UNDO.

  The reported defect: ask the agent to undo and it replied "I've undone that
  change for you" whether or not anything was undone. The undo itself was fixed
  separately (commit 0d2e3f6 — `undoOwnerId` split undo ownership away from
  attribution, so `history.undo` stopped matching nothing). The SENTENCE was
  not: `undo` was an `kind: "editor"` action, so its `run` executed on the
  SERVER and returned a command object DESCRIBING an undo, which was streamed
  back as the tool result before the browser had attempted anything. The client
  then executed it fire-and-forget and never reported back. The model's tool
  result was a fabrication by construction.

  undo/redo are now CLIENT-RESULT actions (`resultSource: "client"` in the SDK,
  packages/email-sdk/src/actions/builtins.ts): the server advertises the tool
  and streams the call, the browser performs the real `history.undo` mutation,
  and this module turns what actually happened into the tool result the model
  reads.

  Two rules govern every string here.

  1. A STEP THAT DID NOT HAPPEN NEVER READS AS ONE. "There was nothing left to
     undo" and "I undid the colour change" are different sentences and the
     model must be able to tell which one it is entitled to.
  2. `nothing_to_undo` IS NOT AN ERROR. It is terminal and legitimate: nothing
     about the call was wrong, and repeating it cannot change the answer. So it
     comes back as a SUCCESSFUL tool output carrying `isStepped: false`, never
     through the tool-error channel where the SDK invites the model to correct
     itself. Same rule the ingestion tools follow for a paywalled page, and the
     same reason `not_authorized` is classified terminal in the SDK taxonomy.
*/

/**
 * What a history step actually did, as the editor store observed it. Mirrors
 * the `history.undo`/`history.redo` return shape, widened with the reasons a
 * step can fail before it ever reaches Convex.
 */
export type HistoryStepOutcome =
  | { isOk: true }
  | { isOk: false; reason: HistoryStepFailureReason };

/** Which history direction was asked for — chooses the copy, nothing else. */
export type HistoryStepDirection = "undo" | "redo";

function getIsKnownFailureReason(reason: string): reason is HistoryStepFailureReason {
  return HISTORY_STEP_FAILURE_REASONS.some((known) => known === reason);
}

/**
 * Normalize a raw `history.undo` / `history.redo` return value into an
 * outcome. An unrecognised server reason degrades to `"failed"` rather than
 * being passed through: the copy below is written per reason, and a reason
 * with no copy must not turn into a sentence nobody wrote.
 */
export function toHistoryStepOutcome(
  result: { isOk: true } | { isOk: false; reason: string },
): HistoryStepOutcome {
  if (result.isOk) {
    return { isOk: true };
  }
  return {
    isOk: false,
    reason: getIsKnownFailureReason(result.reason) ? result.reason : "failed",
  };
}

const STEP_NOUNS: Readonly<Record<HistoryStepDirection, { past: string; noun: string }>> = {
  undo: { past: "undone", noun: "undo" },
  redo: { past: "redone", noun: "redo" },
};

/*
  Per-reason copy. Each string states the fact first and then closes the loop
  explicitly, because the model's default instinct on a negative tool result is
  to try again — and for every reason here, trying again is wrong.
*/
function getFailureNote({
  direction,
  reason,
}: {
  direction: HistoryStepDirection;
  reason: HistoryStepFailureReason;
}): string {
  const { past, noun } = STEP_NOUNS[direction];
  const doNotRetry = `Tell the user this in your own words. Do NOT call ${noun} again.`;
  switch (reason) {
    case "nothing_to_undo":
      return `Nothing was undone: this draft has no change left for you to undo. ${doNotRetry}`;
    case "nothing_to_redo":
      return `Nothing was redone: there is no undone change to reapply. ${doNotRetry}`;
    case "not_connected":
      return `Nothing was ${past}: the editor is not connected to a document yet, so no history step could be taken. ${doNotRetry}`;
    case "draft_unavailable":
      return `Nothing was ${past}: the draft this turn was editing is no longer open. ${doNotRetry}`;
    case "conflict":
      return `Nothing was ${past}: a newer change to the document conflicts with that history step. ${doNotRetry}`;
    case "document_not_found":
      return `Nothing was ${past}: that document no longer exists. ${doNotRetry}`;
    case "connection_error":
      return `Nothing was ${past}: the ${noun} could not reach the server. Tell the user the ${noun} did not go through and that they can try again themselves.`;
    case "failed":
      return `Nothing was ${past}: the ${noun} did not go through. ${doNotRetry}`;
  }
}

/**
 * The tool result for one history step — the model's ONLY source of truth
 * about whether the step happened.
 */
export function toHistoryStepToolOutput({
  direction,
  outcome,
}: {
  direction: HistoryStepDirection;
  outcome: HistoryStepOutcome;
}): HistoryStepToolOutput {
  if (outcome.isOk) {
    const { past } = STEP_NOUNS[direction];
    return {
      isStepped: true,
      note: `The last change to the email was ${past} — the document on screen has already updated. Confirm briefly what is now different.`,
    };
  }
  return {
    isStepped: false,
    reason: outcome.reason,
    note: getFailureNote({ direction, reason: outcome.reason }),
  };
}
