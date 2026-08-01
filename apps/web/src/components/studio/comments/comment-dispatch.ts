import type { CommentThread } from "./comment-context";

/**
 * Comments mode — the pure dispatch-prompt half: how open comment threads
 * become chat prompts. Two shapes, both sent through the EXISTING chat
 * pipeline (composer-handoff's send seam — the turn runs visibly in chat,
 * ops flow through the one history spine):
 *
 * - "Fix this": ONE comment → one prompt.
 * - "Fix all": every open comment on the active draft → ONE prompt (one
 *   model trip), numbered, each item carrying its own anchor context, with
 *   an explicit per-item reply instruction.
 *
 * Language rules: block ids never appear (user-facing prompts, visible in
 * the thread) — the anchor context is the breadcrumb + the block's visible
 * text, which the model resolves against the document it receives in the
 * same request. Both shapes contain the phrase "reviewer comment", which is
 * also the mock model's comment-fix trigger.
 */

/** A comment plus what only the dispatch site knows about it right now. */
export interface DispatchableComment {
  comment: CommentThread;
  /** True when the anchor block no longer exists in the rendered doc. */
  isOrphaned: boolean;
}

/**
 * 'the Button "Shop now" (Section › Row › Column › Button)' — or "the email
 * overall" for draft-level comments; orphaned anchors keep their frozen
 * context plus a removal note so the model doesn't hunt for a gone block.
 */
export function describeCommentPlacement({ comment, isOrphaned }: DispatchableComment): string {
  const { blockType, textSnippet, breadcrumb } = comment.context;
  if (comment.anchor.blockId === null || blockType === undefined) {
    return "the email overall";
  }
  const snippet = textSnippet !== undefined ? ` "${textSnippet}"` : "";
  const trail = breadcrumb.length > 0 ? ` (${breadcrumb})` : "";
  const removalNote = isOrphaned
    ? " — note: that block has since been removed, so address the feedback in its surrounding context"
    : "";
  return `the ${blockType}${snippet}${trail}${removalNote}`;
}

/**
 * The comment's ask, in the reviewer's own words: the opening entry plus any
 * later HUMAN replies (they refine the ask); agent entries are progress
 * notes and never part of the instruction.
 */
function describeCommentAsk(comment: CommentThread): string {
  const userTexts = comment.thread
    .filter((entry) => entry.authorKind === "user")
    .map((entry) => entry.text);
  const [openingText, ...followUpTexts] = userTexts;
  if (openingText === undefined) {
    return '""';
  }
  const followUps = followUpTexts.map((text) => ` (follow-up: "${text}")`).join("");
  return `"${openingText}"${followUps}`;
}

/** The single-comment "Fix this" prompt. */
export function buildFixCommentPrompt(dispatchable: DispatchableComment): string {
  const { comment } = dispatchable;
  return [
    `Please address this reviewer comment on the draft "${comment.context.draftName}".`,
    "",
    `Comment on ${describeCommentPlacement(dispatchable)}:`,
    describeCommentAsk(comment),
    "",
    "Make the appropriate edits with your tools, then briefly confirm what you changed.",
  ].join("\n");
}

/**
 * The one-trip "Fix all" prompt: every open comment as a numbered item with
 * its own anchor context. The model is told to address each item with tool
 * calls and reply per item.
 */
export function buildFixAllCommentsPrompt(dispatchables: readonly DispatchableComment[]): string {
  const draftName = dispatchables[0]?.comment.context.draftName ?? "this draft";
  const items = dispatchables.map(
    (dispatchable, index) =>
      `${index + 1}. On ${describeCommentPlacement(dispatchable)}: ${describeCommentAsk(dispatchable.comment)}`,
  );
  return [
    `Please address all ${dispatchables.length} open reviewer comments on the draft "${draftName}" in one pass:`,
    "",
    ...items,
    "",
    "Address each comment with the appropriate tool edits, then reply with a numbered list summarizing how you handled each one.",
  ].join("\n");
}

/** Display name on agent-authored thread entries (matches the chat panel's product name). */
export const AGENT_THREAD_AUTHOR_NAME = "Flock";

/**
 * The post-fix thread note. Deliberately an "I responded" marker, not an "it
 * is fixed" claim: the human reviews the turn's changes and ACCEPTS by
 * resolving the thread — the status never flips automatically.
 */
export const AGENT_RESPONDED_THREAD_TEXT =
  "I've made edits for this comment — review the changes on the canvas and in chat, then resolve this thread if it looks good.";
