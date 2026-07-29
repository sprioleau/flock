import { createSampleDocument, emailActionRegistry } from "@tandem/email-sdk";
import { describe, expect, it } from "vitest";
import { buildAgentActionRegistry, getBlockDetailsAction } from "./actions";
import { buildToolGuidance } from "./prompts";

const sampleDoc = createSampleDocument();

describe("getBlockDetailsAction", () => {
  it("is a read-only, parallel-safe, unapproved analysis action", () => {
    expect(getBlockDetailsAction.name).toBe("getBlockDetails");
    expect(getBlockDetailsAction.kind).toBe("analysis");
    expect(getBlockDetailsAction.readOnly).toBe(true);
    expect(getBlockDetailsAction.parallelSafe).toBe(true);
    expect(getBlockDetailsAction.needsApproval).toBe(false);
    expect(getBlockDetailsAction.description.length).toBeGreaterThan(0);
  });

  it("runs describeBlock: full block JSON plus root-first ancestors", () => {
    const input = getBlockDetailsAction.schema.parse({ blockId: "txt_r7s8" });
    const details = getBlockDetailsAction.run(sampleDoc, input);
    expect(details).not.toBeNull();
    expect(details!.block).toEqual(sampleDoc.txt_r7s8);
    expect(details!.ancestorIds).toEqual(["root", "sec_c3d4", "row_k1l2", "col_m3n4"]);
  });

  it("returns null for an id not in the document", () => {
    const input = getBlockDetailsAction.schema.parse({ blockId: "btn_none" });
    expect(getBlockDetailsAction.run(sampleDoc, input)).toBeNull();
  });

  it("rejects malformed block ids at the schema gate", () => {
    expect(getBlockDetailsAction.schema.safeParse({ blockId: "not-a-block-id" }).success).toBe(
      false,
    );
    expect(getBlockDetailsAction.schema.safeParse({}).success).toBe(false);
  });
});

describe("buildAgentActionRegistry", () => {
  const registry = buildAgentActionRegistry();

  it("keeps every sdk built-in, in registration order, then appends getBlockDetails", () => {
    const names = registry.actions.map((action) => action.name);
    const builtinNames = emailActionRegistry.actions.map((action) => action.name);
    expect(names).toEqual([...builtinNames, "getBlockDetails"]);
    expect(registry.actionsByName.get("getBlockDetails")).toBe(getBlockDetailsAction);
  });

  it("activates the §9.4 catalog-lookup hint in the tool guidance", () => {
    const guidance = buildToolGuidance(registry);
    expect(guidance).toContain(
      "call getBlockDetails for a block's full shape before complex edits",
    );
    expect(guidance).toMatch(/- getBlockDetails \(analysis, read-only, parallel-safe\)/);
  });

  it("builds a fresh registry per call (no shared mutable state)", () => {
    const other = buildAgentActionRegistry();
    expect(other).not.toBe(registry);
    expect(other.actions.map((action) => action.name)).toEqual(
      registry.actions.map((action) => action.name),
    );
  });
});
