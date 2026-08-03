import { describe, expect, it } from "vitest";
import type { Id } from "@convex/_generated/dataModel";
import type { CommentThread } from "./comment-context";
import {
  buildFixAllCommentsPrompt,
  buildFixCommentPrompt,
  describeCommentPlacement,
} from "./comment-dispatch";

/** Minimal thread factory — only the fields the prompt builders read. */
function makeComment(overrides: {
  blockId?: string | null;
  blockType?: string;
  textSnippet?: string;
  breadcrumb?: string;
  texts: Array<{ authorKind: "user" | "agent"; text: string }>;
}): CommentThread {
  return {
    commentId: "c1" as Id<"comments">,
    canvasId: "canvas1" as Id<"canvases">,
    documentId: "doc1" as Id<"documents">,
    anchor: { blockId: overrides.blockId === undefined ? "btn_t9u0" : overrides.blockId, x: 0.5, y: 0.5 },
    context: {
      draftName: "Draft 1",
      breadcrumb: overrides.breadcrumb ?? "Section › Row › Column › Button",
      ...(overrides.blockType !== undefined ? { blockType: overrides.blockType } : {}),
      ...(overrides.textSnippet !== undefined ? { textSnippet: overrides.textSnippet } : {}),
    },
    thread: overrides.texts.map((entry, index) => ({
      authorKind: entry.authorKind,
      authorName: entry.authorKind === "agent" ? "Flock" : "brave otter",
      text: entry.text,
      createdAtMs: 1000 + index,
    })),
    status: "open",
    createdAtMs: 1000,
    updatedAtMs: 1000,
  } as CommentThread;
}

describe("describeCommentPlacement", () => {
  it("names the block, its visible text, and the breadcrumb — never ids", () => {
    const comment = makeComment({
      blockType: "Button",
      textSnippet: "Get started",
      texts: [{ authorKind: "user", text: "Make this punchier" }],
    });
    const placement = describeCommentPlacement({ comment, isOrphaned: false });
    expect(placement).toBe('the Button "Get started" (Section › Row › Column › Button)');
    expect(placement).not.toContain("btn_t9u0");
  });

  it("describes draft-level comments as the email overall", () => {
    const comment = makeComment({
      blockId: null,
      breadcrumb: "",
      texts: [{ authorKind: "user", text: "Too cramped" }],
    });
    expect(describeCommentPlacement({ comment, isOrphaned: false })).toBe("the email overall");
  });

  it("notes a removed anchor block on orphaned comments", () => {
    const comment = makeComment({
      blockType: "Button",
      textSnippet: "Get started",
      texts: [{ authorKind: "user", text: "Make this punchier" }],
    });
    expect(describeCommentPlacement({ comment, isOrphaned: true })).toContain(
      "has since been removed",
    );
  });
});

describe("buildFixCommentPrompt", () => {
  it("carries the draft name, anchor context, and the reviewer's words", () => {
    const comment = makeComment({
      blockType: "Button",
      textSnippet: "Get started",
      texts: [{ authorKind: "user", text: "Make this punchier" }],
    });
    const prompt = buildFixCommentPrompt({ comment, isOrphaned: false });
    expect(prompt).toContain("reviewer comment");
    expect(prompt).toContain('draft "Draft 1"');
    expect(prompt).toContain('the Button "Get started" (Section › Row › Column › Button)');
    expect(prompt).toContain('"Make this punchier"');
  });

  it("includes later human replies as follow-ups and skips agent entries", () => {
    const comment = makeComment({
      blockType: "Button",
      texts: [
        { authorKind: "user", text: "Make this punchier" },
        { authorKind: "agent", text: "I've made edits for this comment" },
        { authorKind: "user", text: "and make it orange" },
      ],
    });
    const prompt = buildFixCommentPrompt({ comment, isOrphaned: false });
    expect(prompt).toContain('(follow-up: "and make it orange")');
    expect(prompt).not.toContain("I've made edits");
  });
});

describe("buildFixAllCommentsPrompt", () => {
  it("packs every open comment into ONE numbered prompt with per-item context", () => {
    const buttonComment = makeComment({
      blockType: "Button",
      textSnippet: "Get started",
      texts: [{ authorKind: "user", text: "Make this punchier" }],
    });
    const draftComment = makeComment({
      blockId: null,
      breadcrumb: "",
      texts: [{ authorKind: "user", text: "Too cramped overall" }],
    });
    const prompt = buildFixAllCommentsPrompt([
      { comment: buttonComment, isOrphaned: false },
      { comment: draftComment, isOrphaned: false },
    ]);
    expect(prompt).toContain("all 2 open reviewer comments");
    expect(prompt).toContain('1. On the Button "Get started"');
    expect(prompt).toContain('2. On the email overall: "Too cramped overall"');
    expect(prompt).toContain("numbered list");
  });
});
