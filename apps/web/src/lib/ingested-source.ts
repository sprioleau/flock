import type { FlockChatMessage } from "./chat-contract";

/*
  DID THIS TURN READ SOMETHING OUTSIDE THE EMAIL?

  One fact, asked of the transcript, because nothing else in the system knows
  it. The composer (packages/email-sdk compose-draft.ts) sees a document and a
  plan; the createDraft command carries the model's intent; neither can tell
  "make another version of this draft" apart from "make a draft about the page
  I just read". Those two want OPPOSITE defaults for the copy the plan leaves
  out — the first wants the user's own draft continued, the second must not
  quietly reuse it — and the transcript is where the difference is visible.

  SCOPED TO THE CURRENT TURN, meaning the last user message onwards. An
  ingestion three turns ago is not evidence that THIS request is about that
  page, and treating it as such would disable the carry-over for the rest of
  the thread — including the drafts menu's "another version of this" flow,
  which is the case the carry-over exists for. The limit that buys: a user who
  says "read my site" in one turn and "now make a draft" in the next gets
  sample copy in the gaps rather than their old paragraphs. That is the honest
  failure of the two, and the model can always close it by passing the copy.

  A REFUSAL DOES NOT COUNT. The ingestion tool reports a paywalled or blocked
  page as a SUCCESSFUL tool call carrying `isOk: false` (api/chat/tools.ts) —
  nothing was read, so nothing external is competing with the source draft.
*/

type MessagePart = FlockChatMessage["parts"][number];

/**
 * True when this part is an ingestion tool call that actually returned
 * content. Narrowing on the part type is what makes `output` typed here — the
 * check reads the real result shape rather than casting to it.
 */
function getIsFulfilledIngestionPart(part: MessagePart): boolean {
  if (part.type === "tool-readWebPage") {
    return part.state === "output-available" && part.output.isFound && part.output.data.isOk;
  }
  return false;
}

/**
 * True when the CURRENT turn has successfully ingested an external source —
 * a page fetched in this turn.
 *
 * Read at the moment a draft is composed, not at send time: the ingestion tool
 * result and the createDraft call arrive in the same assistant message, so the
 * answer only becomes true partway through the turn.
 */
export function getHasIngestedSourceInTurn({
  messages,
}: {
  messages: FlockChatMessage[];
}): boolean {
  const turnStartIndex = messages.findLastIndex((message) => message.role === "user");
  const turnMessages = turnStartIndex === -1 ? messages : messages.slice(turnStartIndex);
  return turnMessages.some((message) => message.parts.some(getIsFulfilledIngestionPart));
}
