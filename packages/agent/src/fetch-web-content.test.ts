import {
  createSampleDocument,
  emailActionRegistry,
  type ActionContext,
} from "@flock/email-sdk";
import { describe, expect, it, vi } from "vitest";
import { buildAgentActionRegistry } from "./actions";
import {
  defineFetchWebContentAction,
  fetchWebContentInputSchema,
  type FetchWebContentResult,
} from "./fetch-web-content";
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

const stubArticleResult: FetchWebContentResult = {
  isOk: true,
  article: {
    title: "A real headline",
    sourceName: "Example News",
    canonicalUrl: "https://example.com/story",
    mainText: "The actual story text.",
    isTruncated: false,
    confidence: "high",
  },
};

describe("defineFetchWebContentAction", () => {
  const fetchWebArticle = vi.fn(async () => stubArticleResult);
  const action = defineFetchWebContentAction({ fetchWebArticle });

  it("is a read-only, parallel-safe, unapproved analysis action", () => {
    expect(action.name).toBe("fetchWebContent");
    expect(action.kind).toBe("analysis");
    expect(action.readOnly).toBe(true);
    expect(action.parallelSafe).toBe(true);
    expect(action.needsApproval).toBe(false);
    expect(action.description).toContain("isOk: false");
    expect(action.description).toContain("never guess");
  });

  /*
    Slice 1 re-split the two page readers by SUBJECT. This tool's half of that
    split has to say both what it is for and what it is not for: "a URL the
    user shared" was the old trigger, and it swallowed personal sites whole.
    A text assertion, not a routing one — no test can make a model obey.
  */
  it("claims topic pages and disclaims pages about one person", () => {
    expect(action.description).toContain("ABOUT A TOPIC OR AN EVENT");
    expect(action.description).toContain("Do NOT use it for a page that is about ONE PERSON");
    expect(action.description).toContain("portfolio");
    /*
      The sibling tool is NOT named: a registry may register fetchWebContent
      alone, and naming a tool that is not registered invites a call to
      nothing. The cross-reference lives in the routing section instead.
    */
    expect(action.description).not.toContain("fetchPersonHighlight");
  });

  it("delegates run to the injected executor with just the url", async () => {
    const input = action.schema.parse({ url: "https://example.com/story" });
    await expect(
      action.run({ doc: sampleDoc, input, context: agentContext }),
    ).resolves.toEqual(stubArticleResult);
    expect(fetchWebArticle).toHaveBeenCalledWith({ url: "https://example.com/story" });
  });

  it("validates input at the schema gate: url required, no extras, capped length", () => {
    expect(fetchWebContentInputSchema.safeParse({ url: "https://a.com/x" }).success).toBe(true);
    expect(fetchWebContentInputSchema.safeParse({}).success).toBe(false);
    expect(fetchWebContentInputSchema.safeParse({ url: "" }).success).toBe(false);
    expect(
      fetchWebContentInputSchema.safeParse({ url: "https://a.com", extra: 1 }).success,
    ).toBe(false);
    expect(
      fetchWebContentInputSchema.safeParse({ url: `https://a.com/${"x".repeat(2048)}` }).success,
    ).toBe(false);
  });
});

describe("buildAgentActionRegistry with an injected fetchWebArticle", () => {
  const registry = buildAgentActionRegistry({ fetchWebArticle: async () => stubArticleResult });

  it("appends fetchWebContent after the built-ins and getBlockDetails", () => {
    const names = registry.actions.map((action) => action.name);
    const builtinNames = emailActionRegistry.actions.map((action) => action.name);
    expect(names).toEqual([...builtinNames, "getBlockDetails", "fetchWebContent"]);
  });

  it("switches on the web-content workflow guidance (faithfulness + attribution + stop)", () => {
    const guidance = buildToolGuidance(registry);
    expect(guidance).toContain("## Building from a web page (fetchWebContent)");
    expect(guidance).toContain("Compose ONLY from the returned payload");
    expect(guidance).toContain("canonicalUrl");
    expect(guidance).toContain("make NO edits, and STOP");
    expect(guidance).toMatch(/- fetchWebContent \(analysis, read-only, parallel-safe\)/);
  });

  it("keeps the workflow guidance out when the executor is not injected", () => {
    const guidanceWithout = buildToolGuidance(buildAgentActionRegistry());
    expect(guidanceWithout).not.toContain("fetchWebContent");
    expect(guidanceWithout).not.toContain("Building from a web page");
  });
});
