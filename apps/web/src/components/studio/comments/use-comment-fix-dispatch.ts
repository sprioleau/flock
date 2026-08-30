"use client";

import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { sendPromptForSettledTurn } from "../chat/composer-handoff";
import {
  AGENT_RESPONDED_THREAD_TEXT,
  AGENT_THREAD_AUTHOR_NAME,
  buildFixAllCommentsPrompt,
  buildFixCommentPrompt,
  type DispatchableComment,
} from "./comment-dispatch";

/*
  The one dispatch path for comment fixes ("Fix this" AND "Fix all"): build
  the prompt (single, or one numbered multi-comment prompt — ONE model
  trip), send it through the chat pipeline via the composer-handoff
  settlement seam, and when the turn settles append the "agent responded"
  entry to EVERY dispatched thread. Status stays open on purpose — the
  human accepts by resolving (review-workflow invariant); an errored turn
  never settles, so no response note is recorded for it.
*/
export function useCommentFixDispatch(): {
  /*
    Returns false when no chat composer was mounted to receive the prompt.
  */
  dispatchFix: (dispatchables: readonly DispatchableComment[]) => boolean;
} {
  const addThreadEntry = useMutation(api.comments.addThreadEntry);

  const dispatchFix = (dispatchables: readonly DispatchableComment[]): boolean => {
    const [firstDispatchable] = dispatchables;
    if (firstDispatchable === undefined) {
      return false;
    }
    const prompt =
      dispatchables.length === 1
        ? buildFixCommentPrompt(firstDispatchable)
        : buildFixAllCommentsPrompt(dispatchables);
    return sendPromptForSettledTurn({
      prompt,
      onTurnSettled: () => {
        for (const { comment } of dispatchables) {
          /*
            Fails soft per thread: a deleted thread quietly misses its note.
          */
          void addThreadEntry({
            commentId: comment.commentId,
            authorKind: "agent",
            authorName: AGENT_THREAD_AUTHOR_NAME,
            text: AGENT_RESPONDED_THREAD_TEXT,
          }).catch(() => {});
        }
      },
    });
  };

  return { dispatchFix };
}
