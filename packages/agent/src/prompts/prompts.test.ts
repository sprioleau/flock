import { createSampleDocument, emailActionRegistry } from "@tandem/email-sdk";
import { describe, expect, it } from "vitest";
import { generateDocumentOutline } from "../outline";
import {
  SYSTEM_STATIC,
  buildAgentSystemPrompt,
  buildDocumentContext,
  buildToolGuidance,
} from "./index";

const sampleDoc = createSampleDocument();

describe("SYSTEM_STATIC (layer a — cacheable)", () => {
  it("is a stable constant covering role, model, ops, and best practices", () => {
    expect(SYSTEM_STATIC).toContain("email editing copilot");
    expect(SYSTEM_STATIC).toContain("FLAT MAP");
    expect(SYSTEM_STATIC).toContain("btn_x9k3");
    expect(SYSTEM_STATIC).toContain("Nesting rules");
    expect(SYSTEM_STATIC).toContain("Operation semantics");
    expect(SYSTEM_STATIC).toContain("best practices");
  });

  it("contains no per-request placeholders", () => {
    expect(SYSTEM_STATIC).not.toContain("${");
    expect(SYSTEM_STATIC).not.toContain("{{");
  });
});

describe("buildToolGuidance (layer b — cacheable per registry)", () => {
  const guidance = buildToolGuidance(emailActionRegistry);

  it("lists every registered action, in registration order", () => {
    const positions = emailActionRegistry.actions.map((action) =>
      guidance.indexOf(`- ${action.name} (`),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("carries each action's registry description verbatim", () => {
    for (const action of emailActionRegistry.actions) {
      expect(guidance).toContain(action.description);
    }
  });

  it("flags approval-gated and parallel-safe actions", () => {
    expect(guidance).toMatch(/- sendTestEmail \([^)]*needs approval\)/);
    expect(guidance).toMatch(/- updateBlockProperties \([^)]*parallel-safe\)/);
    expect(guidance).toMatch(/- moveBlock \([^)]*sequential\)/);
  });

  it("is deterministic for a given registry", () => {
    expect(buildToolGuidance(emailActionRegistry)).toBe(guidance);
  });

  it("omits the getBlockDetails hint until that tool is registered", () => {
    expect(guidance).not.toContain("getBlockDetails");
  });
});

describe("buildDocumentContext (layer c — per-request)", () => {
  it("embeds the outline and a selection placeholder", () => {
    const context = buildDocumentContext({ doc: sampleDoc });
    expect(context).toContain("## Current document");
    expect(context).toContain(generateDocumentOutline({ doc: sampleDoc }));
    expect(context).toContain("## Selection");
    expect(context).toContain("selected: none");
  });

  it("names the selected block with its type", () => {
    const context = buildDocumentContext({
      doc: sampleDoc,
      options: { selectedBlockId: "btn_t9u0" },
    });
    expect(context).toContain("selected: btn_t9u0 (button)");
  });

  it("falls back to none for a selection id not in the document", () => {
    const context = buildDocumentContext({
      doc: sampleDoc,
      options: { selectedBlockId: "btn_gone" },
    });
    expect(context).toContain("selected: none");
  });

  it("passes outline options through", () => {
    const context = buildDocumentContext({ doc: sampleDoc, options: { depth: "sections" } });
    expect(context).toContain("sec_a1b2 section (3 children)");
    expect(context).not.toContain("btn_t9u0");
  });
});

describe("buildAgentSystemPrompt (layer composition)", () => {
  it("orders layers static-first for Gemini implicit caching: a, then b, then c", () => {
    const prompt = buildAgentSystemPrompt({ doc: sampleDoc, registry: emailActionRegistry });
    const staticIndex = prompt.indexOf("email editing copilot");
    const toolsIndex = prompt.indexOf("## Available tools");
    const documentIndex = prompt.indexOf("## Current document");
    expect(staticIndex).toBeGreaterThanOrEqual(0);
    expect(toolsIndex).toBeGreaterThan(staticIndex);
    expect(documentIndex).toBeGreaterThan(toolsIndex);
  });

  it("keeps the static prefix byte-identical across different documents", () => {
    const promptA = buildAgentSystemPrompt({ doc: sampleDoc, registry: emailActionRegistry });
    const promptB = buildAgentSystemPrompt({
      doc: sampleDoc,
      registry: emailActionRegistry,
      options: { selectedBlockId: "btn_t9u0", depth: "sections" },
    });
    const prefixLength = promptA.indexOf("## Current document");
    expect(promptB.slice(0, prefixLength)).toBe(promptA.slice(0, prefixLength));
  });

  it("is exactly the three layers joined with blank lines", () => {
    const prompt = buildAgentSystemPrompt({ doc: sampleDoc, registry: emailActionRegistry });
    expect(prompt).toBe(
      [
        SYSTEM_STATIC,
        buildToolGuidance(emailActionRegistry),
        buildDocumentContext({ doc: sampleDoc }),
      ].join("\n\n"),
    );
  });
});
