import {
  createSampleDocument,
  emailActionRegistry,
  type ActionContext,
} from "@flock/email-sdk";
import { describe, expect, it, vi } from "vitest";
import { buildAgentActionRegistry } from "./actions";
import {
  definePersonHighlightAction,
  personHighlightInputSchema,
  type PersonHighlightResult,
} from "./person-highlight";
import { buildToolGuidance } from "./prompts";

const sampleDoc = createSampleDocument();

/**
 * Any caller will do: this action declares no `authorize` gate, so the context
 * is only the provenance the envelope now requires every invocation to name.
 */
const agentContext: ActionContext = {
  caller: "tool",
  authorId: "agent_thread_1",
  author: "agent",
};

const stubPersonResult: PersonHighlightResult = {
  isOk: true,
  person: {
    name: "Amara Osei",
    role: "Professor of Environmental Engineering",
    sourceName: "Riverside University",
    profileUrl: "https://riverside.example.edu/people/amara-osei",
    facts: [
      {
        text: "She directs the Riverside Urban Climate Lab.",
        sourceUrl: "https://riverside.example.edu/people/amara-osei",
      },
    ],
    sources: [
      { title: "Riverside University", url: "https://riverside.example.edu/people/amara-osei" },
    ],
    searchStatus: "unavailable",
  },
};

describe("definePersonHighlightAction", () => {
  const fetchPersonHighlight = vi.fn(async () => stubPersonResult);
  const action = definePersonHighlightAction({ fetchPersonHighlight });

  it("is a read-only, parallel-safe, unapproved analysis action", () => {
    expect(action.name).toBe("fetchPersonHighlight");
    expect(action.kind).toBe("analysis");
    expect(action.readOnly).toBe(true);
    expect(action.parallelSafe).toBe(true);
    expect(action.needsApproval).toBe(false);
  });

  it("tells the model the refusal rule in its own description", () => {
    expect(action.description).toContain("isOk: false");
    expect(action.description).toContain("never guess");
  });

  /*
    The description is the only thing a model sees when it decides between the
    two page readers, so these pin the two edits Slice 1 made to it. Steering
    is probabilistic and no test can make a model obey — what this catches is
    the text being silently dropped, which is exactly how the tool went unused.
  */
  it("claims every kind of page that is about one person, not just 'profile'", () => {
    expect(action.description).toContain("ABOUT ONE PERSON");
    for (const pageKind of ["personal site or portfolio", "about page", "profile", "bio", "staff"]) {
      expect(action.description).toContain(pageKind);
    }
    /* The owner's own phrasings, which previously matched the article tool. */
    expect(action.description).toContain("my portfolio");
    expect(action.description).toContain("bare personal domain");
  });

  it("promises only what the payload actually carries", () => {
    /* What it does return. */
    expect(action.description).toContain("ONE portrait image");
    /* What it does NOT — Slices 2-4, and overselling them is its own defect. */
    expect(action.description).toMatch(
      /never a parsed list of skills, projects, or company logos/,
    );
    expect(action.description).toContain("one portrait, never a gallery");
  });

  /*
    Descriptions are advertised per-registry. This one must stand alone: a
    registry can register fetchPersonHighlight without fetchWebContent, and
    pointing a model at an unregistered tool is a failure of its own. The
    cross-reference lives in the routing section, which is gated on both.
  */
  it("does not name the sibling tool, which may not be registered", () => {
    expect(action.description).not.toContain("fetchWebContent");
  });

  it("delegates run to the injected executor", async () => {
    const input = action.schema.parse({ url: "https://riverside.example.edu/people/amara-osei" });
    await expect(
      action.run({ doc: sampleDoc, input, context: agentContext }),
    ).resolves.toEqual(stubPersonResult);
    expect(fetchPersonHighlight).toHaveBeenCalledWith({
      url: "https://riverside.example.edu/people/amara-osei",
    });
  });

  it("passes the person's name through only when the user gave one", async () => {
    const input = action.schema.parse({
      url: "https://riverside.example.edu/people/amara-osei",
      personName: "Amara Osei",
    });
    await action.run({ doc: sampleDoc, input, context: agentContext });
    expect(fetchPersonHighlight).toHaveBeenLastCalledWith({
      url: "https://riverside.example.edu/people/amara-osei",
      personName: "Amara Osei",
    });
  });

  it("validates input at the schema gate: url required, no extras, capped lengths", () => {
    expect(personHighlightInputSchema.safeParse({ url: "https://a.com/x" }).success).toBe(true);
    expect(personHighlightInputSchema.safeParse({}).success).toBe(false);
    expect(personHighlightInputSchema.safeParse({ url: "" }).success).toBe(false);
    expect(personHighlightInputSchema.safeParse({ url: "https://a.com", extra: 1 }).success).toBe(
      false,
    );
    expect(
      personHighlightInputSchema.safeParse({ url: `https://a.com/${"x".repeat(2048)}` }).success,
    ).toBe(false);
    expect(
      personHighlightInputSchema.safeParse({ url: "https://a.com", personName: "x".repeat(121) })
        .success,
    ).toBe(false);
  });
});

describe("buildAgentActionRegistry with an injected fetchPersonHighlight", () => {
  const registry = buildAgentActionRegistry({
    fetchWebArticle: async () => ({ isOk: false, reason: "test", message: "unused" }),
    fetchPersonHighlight: async () => stubPersonResult,
  });

  it("appends fetchPersonHighlight after fetchWebContent", () => {
    const names = registry.actions.map((action) => action.name);
    const builtinNames = emailActionRegistry.actions.map((action) => action.name);
    expect(names).toEqual([
      ...builtinNames,
      "getBlockDetails",
      "fetchWebContent",
      "fetchPersonHighlight",
    ]);
  });

  it("switches on the person-spotlight guidance (attribution + evidence + stop)", () => {
    const guidance = buildToolGuidance(registry);
    expect(guidance).toContain("## Spotlighting a person (fetchPersonHighlight)");
    expect(guidance).toContain("ALWAYS links back to profileUrl");
    expect(guidance).toContain("searchStatus");
    expect(guidance).toContain("make NO edits, and STOP");
    expect(guidance).toMatch(/- fetchPersonHighlight \(analysis, read-only, parallel-safe\)/);
  });

  /*
    Slice 1's routing rule. Same limit as every other prompt assertion here:
    it pins that the instruction is in the bytes the model receives, in the
    right place, with the tie-break the ambiguous case needs. It proves
    nothing about which tool a real model then picks.
  */
  it("states the page-reader routing rule when both readers are registered", () => {
    const guidance = buildToolGuidance(registry);
    expect(guidance).toContain("## Which page reader to call");
    expect(guidance).toContain("Choose by WHAT THE PAGE IS ABOUT");
    /* The tie-break, without which a portfolio (bio AND work) stays ambiguous. */
    expect(guidance).toContain("THE PERSON WINS");
    /* The phrasings the owner actually typed. */
    expect(guidance).toContain('"from my portfolio"');
    expect(guidance).toContain("bare personal domain with no path");
    /* And the honest ceiling on what the person payload can deliver. */
    expect(guidance).toContain("It does not return a skills list, project cards, or company logos");
  });

  it("puts the routing rule before both page-reader workflows", () => {
    const guidance = buildToolGuidance(registry);
    const routingIndex = guidance.indexOf("## Which page reader to call");
    const webWorkflowIndex = guidance.indexOf("## Building from a web page");
    const personWorkflowIndex = guidance.indexOf("## Spotlighting a person");
    expect(routingIndex).toBeGreaterThanOrEqual(0);
    expect(webWorkflowIndex).toBeGreaterThan(routingIndex);
    expect(personWorkflowIndex).toBeGreaterThan(routingIndex);
  });

  it("keeps the person guidance out when the executor is not injected", () => {
    const guidanceWithout = buildToolGuidance(
      buildAgentActionRegistry({
        fetchWebArticle: async () => ({ isOk: false, reason: "test", message: "unused" }),
      }),
    );
    expect(guidanceWithout).not.toContain("fetchPersonHighlight");
    expect(guidanceWithout).not.toContain("Spotlighting a person");
    /* No routing rule either: there is nothing to route between. */
    expect(guidanceWithout).not.toContain("## Which page reader to call");
  });
});

describe("the web-content workflow lets the USER choose the shape (§7.4)", () => {
  const registryWithWidgets = buildAgentActionRegistry({
    fetchWebArticle: async () => ({ isOk: false, reason: "test", message: "unused" }),
    shouldIncludeWidgetActions: true,
  });

  it("routes the choice through the clarification widget when it is registered", () => {
    const guidance = buildToolGuidance(registryWithWidgets);
    expect(guidance).toContain("THE USER CHOOSES the shape");
    expect(guidance).toContain("call askForClarification with the question");
    expect(guidance).toContain("Never guess between the two");
  });

  it("falls back to a plain question when there is no clarification widget", () => {
    const guidance = buildToolGuidance(
      buildAgentActionRegistry({
        fetchWebArticle: async () => ({ isOk: false, reason: "test", message: "unused" }),
      }),
    );
    expect(guidance).toContain("THE USER CHOOSES the shape");
    expect(guidance).toContain("ask them in one short question");
    expect(guidance).not.toContain("call askForClarification");
  });

  it("names robots.txt among the reasons a page may be unreadable", () => {
    expect(buildToolGuidance(registryWithWidgets)).toContain("blocked by the site's robots rules");
  });
});
