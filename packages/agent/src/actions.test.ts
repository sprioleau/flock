import {
  createSampleDocument,
  emailActionRegistry,
  SECTION_TEMPLATES,
  type ActionContext,
} from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import { buildAgentActionRegistry, getBlockDetailsAction } from "./actions";
import { buildToolGuidance } from "./prompts";

const sampleDoc = createSampleDocument();

/**
 * Any caller will do: none of these actions declares an `authorize` gate, so
 * the context is only the provenance the envelope now requires every
 * invocation to name.
 */
const agentContext: ActionContext = {
  caller: "tool",
  authorId: "agent_thread_1",
  author: "agent",
};

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
    const details = getBlockDetailsAction.run({ doc: sampleDoc, input, context: agentContext });
    expect(details).not.toBeNull();
    expect(details!.block).toEqual(sampleDoc.txt_r7s8);
    expect(details!.ancestorIds).toEqual(["root", "sec_c3d4", "row_k1l2", "col_m3n4"]);
  });

  it("returns null for an id not in the document", () => {
    const input = getBlockDetailsAction.schema.parse({ blockId: "btn_none" });
    expect(
      getBlockDetailsAction.run({ doc: sampleDoc, input, context: agentContext }),
    ).toBeNull();
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

  it("advertises the full section catalog in the guidance the chat route serves", () => {
    // The route builds THIS registry (apps/web api/chat/registry.ts), so the
    // compose-new-email flow's prompt carries every template id + useWhen.
    const guidance = buildToolGuidance(registry);
    expect(guidance).toContain("## Section catalog (scaffoldSection templateId values)");
    for (const template of SECTION_TEMPLATES) {
      expect(guidance).toContain(`- ${template.id} — ${template.useWhen}`);
    }
  });

  it("builds a fresh registry per call (no shared mutable state)", () => {
    const other = buildAgentActionRegistry();
    expect(other).not.toBe(registry);
    expect(other.actions.map((action) => action.name)).toEqual(
      registry.actions.map((action) => action.name),
    );
  });
});
