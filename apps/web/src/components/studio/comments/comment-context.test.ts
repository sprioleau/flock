import { describe, expect, it } from "vitest";
import { createSampleDocument, type BlockId } from "@tandem/email-sdk";
import {
  buildCommentAnchorContext,
  extractBlockTextSnippet,
  getIsCommentOrphaned,
  toAnchorFraction,
} from "./comment-context";

describe("buildCommentAnchorContext", () => {
  const doc = createSampleDocument();

  it("builds the full ancestor breadcrumb and snippet for a nested leaf block", () => {
    const context = buildCommentAnchorContext({ doc, blockId: "btn_t9u0" as BlockId });
    expect(context).not.toBeNull();
    expect(context?.breadcrumb).toBe("Section › Row › Column › Button");
    expect(context?.blockType).toBe("Button");
    expect(context?.textSnippet).toBe("Get started");
  });

  it("labels a section with a single-chip breadcrumb", () => {
    const context = buildCommentAnchorContext({ doc, blockId: "sec_c3d4" as BlockId });
    expect(context?.breadcrumb).toBe("Section");
    expect(context?.blockType).toBe("Section");
  });

  it("returns null for a block missing from the doc", () => {
    expect(buildCommentAnchorContext({ doc, blockId: "btn_gone" as BlockId })).toBeNull();
  });
});

describe("extractBlockTextSnippet", () => {
  const doc = createSampleDocument();

  it("uses the first non-empty rich-text node for text blocks", () => {
    const textBlock = doc["txt_r7s8" as BlockId];
    expect(textBlock).toBeDefined();
    const snippet = extractBlockTextSnippet(textBlock!);
    expect(snippet).toBeDefined();
    expect(snippet!.length).toBeGreaterThan(0);
    expect(snippet!.length).toBeLessThanOrEqual(80);
  });

  it("has no snippet for structural blocks", () => {
    const spacerBlock = doc["spc_z5a6" as BlockId];
    expect(spacerBlock).toBeDefined();
    expect(extractBlockTextSnippet(spacerBlock!)).toBeUndefined();
  });
});

describe("getIsCommentOrphaned", () => {
  const doc = createSampleDocument();

  it("is orphaned when the anchor block left the doc", () => {
    const comment = { anchor: { blockId: "btn_gone", x: 0.5, y: 0.5 } };
    expect(getIsCommentOrphaned({ comment, doc })).toBe(true);
  });

  it("is not orphaned for a live anchor block or a draft-level anchor", () => {
    expect(
      getIsCommentOrphaned({ comment: { anchor: { blockId: "btn_t9u0", x: 0, y: 0 } }, doc }),
    ).toBe(false);
    expect(
      getIsCommentOrphaned({ comment: { anchor: { blockId: null, x: 0.2, y: 0.9 } }, doc }),
    ).toBe(false);
  });
});

describe("toAnchorFraction", () => {
  it("computes and clamps rect fractions", () => {
    expect(toAnchorFraction({ pointerCoordinate: 150, rectStart: 100, rectSize: 200 })).toBe(0.25);
    expect(toAnchorFraction({ pointerCoordinate: 50, rectStart: 100, rectSize: 200 })).toBe(0);
    expect(toAnchorFraction({ pointerCoordinate: 400, rectStart: 100, rectSize: 200 })).toBe(1);
  });
});
