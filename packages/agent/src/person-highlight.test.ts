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

  it("keeps the person guidance out when the executor is not injected", () => {
    const guidanceWithout = buildToolGuidance(
      buildAgentActionRegistry({
        fetchWebArticle: async () => ({ isOk: false, reason: "test", message: "unused" }),
      }),
    );
    expect(guidanceWithout).not.toContain("fetchPersonHighlight");
    expect(guidanceWithout).not.toContain("Spotlighting a person");
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
