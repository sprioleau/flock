"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { getLocalCommentAuthorName } from "@/components/studio/comments/comment-author";
import {
  buildCommentAnchorContext,
  type CommentThread,
} from "@/components/studio/comments/comment-context";
import { useCommentsModeStore } from "@/components/studio/comments/comments-mode-store";
import { useCommentFixDispatch } from "@/components/studio/comments/use-comment-fix-dispatch";
import { useEditorStore } from "@/lib/editor-store";
import {
  DEMO_COMMENT_TARGET_BLOCK_ID,
  findDemoCommentChoice,
  selectDemoCommentPhase,
  type DemoCommentPhase,
} from "./demo-steps";

/*
  Step 3's driver: the impure half of the comment beat, with every decision it
  makes living next door in demo-steps.ts.

  NOTHING HERE IS SIMULATED. The visitor's choice is written to the `comments`
  table by the SAME mutation the canvas composer calls, it grows a pin on the
  canvas through the same reactive pins feed every collaborator sees, it is
  dispatched by the SAME useCommentFixDispatch every "Fix this" button uses,
  the prompt is built by the same comment-dispatch builder, the turn runs
  through the real chat pipeline and applies a real op with a real revertable
  batch, and the agent's reply is appended to the thread by that dispatch
  hook's own settlement callback. The only scripted thing in the whole beat is
  the sentence the visitor picked — which is the one part a stranger cannot
  supply for themselves (demo-steps.ts, DEMO_COMMENT_CHOICES).

  ONE THING IS MOCKED AND IT IS THE MODEL, exactly as it is everywhere else on
  this route: `/api/chat` reads `isDemo` off the document row and forces the
  deterministic mock, so this turn spends no quota. The mock answers the
  reviewer's words rather than answering everything identically (mock-model.ts
  §planCommentFixEdit), which is what makes three choices worth offering.

  WHY THE BLOCK IS SELECTED FIRST. The chat transport reads `selectedBlockId`
  from the editor store at send time, and a comment-fix turn resolves its edit
  against that selection. Without the selection the turn would target a block
  id from another fixture entirely and degrade to a failure chip in front of
  the visitor. Selecting the block the comment is about is also just what a
  person does before commenting on it.
*/

export interface DemoCommentFlowController {
  phase: DemoCommentPhase;
  chosenChoiceId: string | null;
  /** Pick a scripted comment, place it, and dispatch it for a fix. */
  chooseComment: (choiceId: string) => void;
}

export function useDemoCommentFlow({
  documentId,
  isStepActive,
}: {
  documentId: Id<"documents"> | null;
  /** True while step 3 is the step on screen. */
  isStepActive: boolean;
}): DemoCommentFlowController {
  const createComment = useMutation(api.comments.createComment);
  const { dispatchFix } = useCommentFixDispatch();
  const [chosenChoiceId, setChosenChoiceId] = useState<string | null>(null);
  const [commentId, setCommentId] = useState<Id<"comments"> | null>(null);

  /*
    ARM THE REAL COMMENTS MODE while this step is on screen, rather than
    describing it. The toolbar's comments control lights up, the canvas takes
    the crosshair, and a visitor who wants to place their OWN comment instead
    of picking one of ours simply can — it is the same armed mode either way.
    Disarmed on the way out (including on exit, via the unmount) so the mode
    never outlives the step that turned it on.
  */
  useEffect(() => {
    if (!isStepActive) {
      return;
    }
    useCommentsModeStore.getState().setIsCommentsModeActive(true);
    return () => {
      useCommentsModeStore.getState().setIsCommentsModeActive(false);
    };
  }, [isStepActive]);

  /* The pins feed, subscribed only once there is a comment of ours in it. */
  const openComments = useQuery(
    api.comments.listOpenCommentsForDocument,
    documentId !== null && commentId !== null ? { documentId } : "skip",
  );
  const comment: CommentThread | null =
    openComments?.find((row) => row.commentId === commentId) ?? null;

  /*
    Dispatch off the REAL ROW rather than off what we just sent: the dispatch
    prompt quotes the thread's own entries and names the draft, and only the
    server knows the draft's name. Waiting one reactive tick for the row costs
    nothing and means the demo dispatches exactly what any other "Fix this"
    button would.

    Guarded by comment id, not by a boolean: `dispatchFix` is a fresh closure
    every render, so this effect re-runs constantly and the id is what makes it
    idempotent (the same reason use-demo-run.ts holds its dispatched turn by
    identity).
  */
  const dispatchedCommentIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (comment === null || dispatchedCommentIdRef.current === comment.commentId) {
      return;
    }
    dispatchedCommentIdRef.current = comment.commentId;
    dispatchFix([{ comment, isOrphaned: false }]);
  }, [comment, dispatchFix]);

  const chooseComment = (choiceId: string): void => {
    const choice = findDemoCommentChoice(choiceId);
    const editorState = useEditorStore.getState();
    const sessionId = editorState.authorId;
    if (
      choice === undefined ||
      documentId === null ||
      sessionId === null ||
      chosenChoiceId !== null
    ) {
      return;
    }
    const context = buildCommentAnchorContext({
      doc: editorState.doc,
      blockId: DEMO_COMMENT_TARGET_BLOCK_ID,
    });
    if (context === null) {
      /* The hero CTA is gone (the visitor deleted it). Better to offer
         nothing than to anchor the beat to a block that is not there. */
      return;
    }
    editorState.selectBlock(DEMO_COMMENT_TARGET_BLOCK_ID);
    setChosenChoiceId(choiceId);
    createComment({
      documentId,
      sessionId,
      authorName: getLocalCommentAuthorName(sessionId),
      /* Centre of the block's own rect — the same 0..1 fraction model a
         hit-tested click produces (comment-context.ts §toAnchorFraction). */
      anchor: { blockId: DEMO_COMMENT_TARGET_BLOCK_ID, x: 0.5, y: 0.5 },
      context,
      text: choice.commentText,
    })
      .then((createdCommentId) => {
        setCommentId(createdCommentId);
        /* Open the thread the visitor just started, so they watch the agent's
           reply land in it rather than being told it did. */
        useCommentsModeStore.getState().setOpenThreadCommentId(createdCommentId);
      })
      .catch((error: unknown) => {
        console.error("[demo] could not place the scripted comment", error);
        /* Back to the choices — a beat that failed must be retryable. */
        setChosenChoiceId(null);
      });
  };

  return {
    phase: selectDemoCommentPhase({
      chosenChoiceId,
      threadAuthorKinds: comment?.thread.map((entry) => entry.authorKind) ?? null,
    }),
    chosenChoiceId,
    chooseComment,
  };
}
