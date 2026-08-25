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
