import { createSampleDocument } from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import { describeBlock } from "./describe-block";

const sampleDoc = createSampleDocument();

describe("describeBlock", () => {
  it("returns the full block JSON, untouched", () => {
    const details = describeBlock({ doc: sampleDoc, blockId: "btn_t9u0" });
    expect(details).not.toBeNull();
    expect(details!.block).toEqual(sampleDoc.btn_t9u0);
  });

  it("resolves the ancestor chain root-first for a deeply nested block", () => {
    const details = describeBlock({ doc: sampleDoc, blockId: "btn_t9u0" });
    expect(details!.ancestorIds).toEqual(["root", "sec_c3d4", "row_k1l2", "col_p5q6"]);
  });

  it("resolves a section's ancestors as just the root", () => {
    const details = describeBlock({ doc: sampleDoc, blockId: "sec_a1b2" });
    expect(details!.ancestorIds).toEqual(["root"]);
  });

  it("returns an empty ancestor chain for the root", () => {
    const details = describeBlock({ doc: sampleDoc, blockId: "root" });
    expect(details!.block.type).toBe("root");
    expect(details!.ancestorIds).toEqual([]);
  });

  it("returns null for an unknown block id", () => {
    expect(describeBlock({ doc: sampleDoc, blockId: "btn_none" })).toBeNull();
  });

  it("terminates on a corrupt parent cycle instead of hanging", () => {
    const doc = structuredClone(sampleDoc);
    // Corrupt: make the section's parent point back down at the column.
    (doc.sec_c3d4 as { parentId: string }).parentId = "col_p5q6";
    const details = describeBlock({ doc, blockId: "btn_t9u0" });
    expect(details).not.toBeNull();
    // Walk: col_p5q6 → row_k1l2 → sec_c3d4 → (col_p5q6 again: stop).
    expect(details!.ancestorIds).toEqual(["sec_c3d4", "row_k1l2", "col_p5q6"]);
  });
});
