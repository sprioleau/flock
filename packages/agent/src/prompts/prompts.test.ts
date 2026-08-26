import {
  contentEmailActions,
  createActionRegistry,
  createSampleDocument,
  emailActionRegistry,
  SECTION_TEMPLATES,
} from "@flock/email-sdk";
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
    // email is built from catalog sections chosen by their useWhen lines —
    // scoped to the draft on screen, so "a new draft" is not read as licence
    // to rebuild this one.
    expect(SYSTEM_STATIC).toMatch(
      /build a whole NEW email IN THE DRAFT THE USER IS ON[\s\S]*chosen by its useWhen line/,
    );
  });

  it("teaches selection-scoped edits and reserves globals for explicitly document-wide requests", () => {
    expect(SYSTEM_STATIC).toContain("## How far a request reaches");
    /*
      Both halves of the owner's rule, in the layer that is cached rather than
      resent: the ambiguous case scopes down, and only the user's own widening
      words unlock updateDocumentSettings.
    */
    expect(SYSTEM_STATIC).toContain('"make the text green"');
    expect(SYSTEM_STATIC).toContain("change ONLY that block");
    expect(SYSTEM_STATIC).toContain('"make ALL the text green"');
    expect(SYSTEM_STATIC).toContain("THEN use globals (updateDocumentSettings)");
  });

  it("teaches that editing operations reach only the draft on the canvas", () => {
    expect(SYSTEM_STATIC).toContain("## The draft you are editing is not the only draft");
    // The rule that prevents the reported failure: a request for a NEW draft
    // must never be satisfied by emptying and rebuilding the current one.
    expect(SYSTEM_STATIC).toMatch(
      /asks for a NEW draft[\s\S]*do not empty the draft in front of them and rebuild it/,
    );
    expect(SYSTEM_STATIC).toContain("createDraft");
  });

  it("teaches per-section streaming for multi-section composition", () => {
    // Full-email builds must arrive as one tool call per section, top to
    // bottom, so the canvas paints progressively (perceived-latency rule).
    expect(SYSTEM_STATIC).toMatch(
      /emit ONE tool call per section, in reading order[\s\S]*never pack multiple sections into a single call/,
    );
  });

  it("requires every section call to share ONE response", () => {
    /*
      This is the binding constraint on whole-email generation, not a style
      note. The default model emits one content op per response, and the
      client caps auto-continuations at 1 — so a model that sends one section
      and waits produces a two-section "email". Parallel calls are the only
      fix that costs no extra round, which is why the wording is pinned.
    */
    expect(SYSTEM_STATIC).toMatch(/put ALL of those calls in the SAME response/);
    /*
      The clause this replaced ("never hold sections back to emit them
      together") was written against silent-compose-then-dump, but read as a
      ban on exactly the behaviour above. It must not come back.
    */
    expect(SYSTEM_STATIC).not.toContain("never hold sections back");
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

  it("routes new-draft requests to createDraft instead of rebuilding in place", () => {
    expect(guidance).toContain("## Making a new draft (createDraft)");
    // The three things that were unexpressible before the plan existed:
    // don't touch the current draft, compose a whole email, keep the theme.
    expect(guidance).toContain(
      "NEVER clear, delete, or rewrite the draft on screen to make a new idea fit",
    );
    expect(guidance).toMatch(/header, one or more body sections[\s\S]*and a footer/);
    expect(guidance).toContain("keep the theme the user already applied");
    expect(guidance).toContain("carried over from the draft the user is on");
    // Real variation for open-ended "explore ideas" asks.
    expect(guidance).toMatch(
      /make them genuinely different from each other[\s\S]*a plain hero in one, a split hero in another/,
    );
    expect(guidance).toContain("Never name the tool.");
  });

  it("omits the new-draft workflow for a registry without createDraft", () => {
    const contentOnlyGuidance = buildToolGuidance(createActionRegistry([...contentEmailActions]));
    expect(contentOnlyGuidance).not.toContain("## Making a new draft");
  });

  it("lists the compact section catalog: one id + useWhen line per template", () => {
    expect(guidance).toContain("## Section catalog (scaffoldSection templateId values)");
    for (const template of SECTION_TEMPLATES) {
      expect(guidance).toContain(`- ${template.id} — ${template.useWhen}`);
    }
    // Compact contract: exactly one line per template, nothing more. Bounded
    // at the next heading — later sections carry bullet lists of their own.
    const listingStart = guidance.indexOf("## Section catalog");
    const nextHeading = guidance.indexOf("\n## ", listingStart + 1);
    const listing = guidance.slice(
      listingStart,
      nextHeading === -1 ? undefined : nextHeading,
    );
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

  /*
    The owner's second report: with a text block selected, "make the text
    green" turned EVERY paragraph green because the agent reached for the
    document-wide globals tool. Prompt steering is probabilistic and no test
    can make a model obey — what these two pin is that the instruction the
    model needs is actually in the bytes it receives, in the section it reads
    last, naming the block it must scope to. Deleting the steering silently is
    the regression this catches.
  */
  it("tells the model an unqualified request means the selected block, not globals", () => {
    const context = buildDocumentContext({
      doc: sampleDoc,
      options: { selectedBlockId: "btn_t9u0" },
    });
    expect(context).toContain("btn_t9u0 and nothing else");
    expect(context).toContain("not globals");
    expect(context).toContain('Widen to the whole document only when the user\'s words widen it');
  });

  it("tells the model an unqualified request has no implied target when nothing is selected", () => {
    const context = buildDocumentContext({ doc: sampleDoc });
    expect(context).toContain("Nothing is selected");
    expect(context).toContain("ask which block they mean");
    expect(context).not.toContain("and nothing else");
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
