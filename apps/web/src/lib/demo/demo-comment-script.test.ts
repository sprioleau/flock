import { describe, expect, it } from "vitest";
import type { Id } from "@convex/_generated/dataModel";
import { planCommentFixEdit } from "@/app/api/chat/mock-model";
import type { CommentThread } from "@/components/studio/comments/comment-context";
import { buildFixCommentPrompt } from "@/components/studio/comments/comment-dispatch";
import { DEMO_COMMENT_CHOICES, DEMO_COMMENT_TARGET_BLOCK_ID } from "./demo-steps";

/**
 * Step 3's one claim, checked end to end without a browser: THE CHOICE THE
 * VISITOR PICKS IS WHAT THE AGENT ANSWERS.
 *
 * The chain is short and every link in it is the real one — the choice's text
 * becomes a real comment row, comment-dispatch.ts turns that row into the same
 * prompt every "Fix this" button sends, and the model this route is forced to
 * (mock-model.ts, off the document's `isDemo` row) plans the edit from that
 * prompt. So this suite walks the same two functions the running product walks
 * and asserts the thing that would make the whole beat a lie if it broke:
 * three different asks must not produce one identical edit.
 */

/** The demo's comment as the pins feed serves it back, per choice. */
function commentForChoice(commentText: string): CommentThread {
  return {
    commentId: "comment_demo" as Id<"comments">,
    canvasId: "canvas_demo" as Id<"canvases">,
    documentId: "document_demo" as Id<"documents">,
    anchor: { blockId: DEMO_COMMENT_TARGET_BLOCK_ID, x: 0.5, y: 0.5 },
    context: {
      draftName: "Demo draft",
      breadcrumb: "Section › Button",
      blockType: "Button",
      textSnippet: "Reserve your bag",
    },
    thread: [
      { authorKind: "user", authorName: "brave otter", text: commentText, createdAtMs: 1 },
    ],
    status: "open",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function promptForChoice(commentText: string): string {
  return buildFixCommentPrompt({ comment: commentForChoice(commentText), isOrphaned: false });
}

describe("the demo's comment choices", () => {
  it("reach the agent as the visitor's own words, through the ordinary fix prompt", () => {
    const prompts = DEMO_COMMENT_CHOICES.map((choice) => promptForChoice(choice.commentText));
    for (const [index, choice] of DEMO_COMMENT_CHOICES.entries()) {
      expect(prompts[index]).toContain(choice.commentText);
      // The phrase both dispatch shapes carry by construction — it is what
      // marks this as a comment-fix turn all the way down the pipeline.
      expect(prompts[index]).toContain("reviewer comment");
      // And it names the block in words, never by id (comment-dispatch.ts).
      expect(prompts[index]).not.toContain(DEMO_COMMENT_TARGET_BLOCK_ID);
    }
    expect(new Set(prompts).size).toBe(DEMO_COMMENT_CHOICES.length);
  });

  it("each drive a DIFFERENT edit — the agent answers the ask, not the category", () => {
    const edits = DEMO_COMMENT_CHOICES.map((choice) =>
      planCommentFixEdit(promptForChoice(choice.commentText)),
    );
    expect(new Set(edits.map((edit) => edit.label)).size).toBe(DEMO_COMMENT_CHOICES.length);
    // None of them falls through to the generic acknowledgement: a choice the
    // model has no specific answer for is a choice not worth offering.
    const genericEdit = planCommentFixEdit("Please address this reviewer comment.");
    for (const edit of edits) {
      expect(edit.label).not.toBe(genericEdit.label);
    }
  });
});
