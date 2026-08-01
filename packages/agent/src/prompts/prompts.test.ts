import {
  contentEmailActions,
  createActionRegistry,
  createSampleDocument,
  emailActionRegistry,
  SECTION_TEMPLATES,
} from "@tandem/email-sdk";
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

  it("teaches the span-mark vocabulary and the styleTextSpan-vs-updateText split", () => {
    expect(SYSTEM_STATIC).toContain("textStyle");
    expect(SYSTEM_STATIC).toContain("highlight");
    expect(SYSTEM_STATIC).toContain("styleTextSpan");
    // The choice rule: styleTextSpan for styling, updateText for content changes.
    expect(SYSTEM_STATIC).toMatch(/styleTextSpan when only the styling[\s\S]*updateText only when the words themselves change/);
    // The outline's compact marks suffix is explained.
    expect(SYSTEM_STATIC).toContain("+bold+link+color(#16a34a)");
  });

  it("teaches scaffoldSection and the scaffold-vs-hand-composed choice rule", () => {
    expect(SYSTEM_STATIC).toContain("scaffoldSection");
    // The choice rule: catalog template when one fits, hand-composed otherwise,
    // and scaffolded sections stay theme-native (no colors/fonts/padding).
    expect(SYSTEM_STATIC).toMatch(
      /use scaffoldSection whenever a catalog template fits[\s\S]*hand-compose addSection\/addBlock only for layouts no template covers/,
    );
    expect(SYSTEM_STATIC).toContain("never set colors, fonts, or padding on scaffolded sections");
    // Compose-new-email flows are steered to catalog composition too: a whole
    // email is built from catalog sections chosen by their useWhen lines.
    expect(SYSTEM_STATIC).toMatch(
      /build a whole NEW email, compose it from catalog sections[\s\S]*chosen by its useWhen line/,
    );
  });

  it("teaches per-section streaming for multi-section composition", () => {
    // Full-email builds must arrive as one tool call per section, top to
    // bottom, so the canvas paints progressively (perceived-latency rule).
    expect(SYSTEM_STATIC).toMatch(
      /emit ONE tool call per section, in reading order[\s\S]*never pack multiple sections into a single call/,
    );
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

  it("summarizes capability categories when the agent-parity UI actions are registered", () => {
    expect(guidance).toContain("## What you can do (capability summary)");
    // Every capability CATEGORY is named in plain language (the "what can you
    // do?" answer): document edits, images, test sends, preview, UI surfaces,
    // history, drafts, personas.
    expect(guidance).toContain("generate AI images");
    expect(guidance).toContain("send a test email (with the user's approval)");
    expect(guidance).toContain("open the editor's panels");
    expect(guidance).toContain("undo and redo changes");
    expect(guidance).toContain("restore an earlier version");
    expect(guidance).toContain("create new drafts");
    expect(guidance).toContain("create advisory reviewer personas");
    expect(guidance).toContain("never list internal tool names");
  });

  it("omits the capability summary for a registry without the parity actions", () => {
    const contentOnlyGuidance = buildToolGuidance(createActionRegistry([...contentEmailActions]));
    expect(contentOnlyGuidance).not.toContain("## What you can do");
  });

  it("lists the compact section catalog: one id + useWhen line per template", () => {
    expect(guidance).toContain("## Section catalog (scaffoldSection templateId values)");
    for (const template of SECTION_TEMPLATES) {
      expect(guidance).toContain(`- ${template.id} — ${template.useWhen}`);
    }
    // Compact contract: exactly one line per template, nothing more.
    const listing = guidance.slice(guidance.indexOf("## Section catalog"));
    const listingLines = listing.split("\n").filter((line) => line.startsWith("- "));
    expect(listingLines).toHaveLength(SECTION_TEMPLATES.length);
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
