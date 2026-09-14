import { describe, expect, it } from "vitest";
import { readBrandKitGenerationIntent } from "./brand-kit-chat-intent";

describe("readBrandKitGenerationIntent", () => {
  it("recognizes explicit create and update requests and normalizes a bare domain", () => {
    expect(readBrandKitGenerationIntent("Create a brand kit for resend.com")).toEqual({
      sourceUrl: "https://resend.com",
    });
    expect(
      readBrandKitGenerationIntent(
        "Update my brand kit to be based on this other website: https://posthog.com/docs.",
      ),
    ).toEqual({ sourceUrl: "https://posthog.com/docs" });
  });

  it("does not hijack ordinary brand-kit viewing, theme, or inspiration requests", () => {
    expect(readBrandKitGenerationIntent("Show me the brand kit for resend.com")).toBeNull();
    expect(readBrandKitGenerationIntent("Apply the brand theme from resend.com")).toBeNull();
    expect(readBrandKitGenerationIntent("Take inspiration from resend.com")).toBeNull();
  });

  it("requires an actionable brand-kit request and a real website URL", () => {
    expect(readBrandKitGenerationIntent("Update my brand kit based on a new website")).toBeNull();
    expect(readBrandKitGenerationIntent("Create a brand kit based on resend")).toBeNull();
    expect(readBrandKitGenerationIntent("Create a brand kit based on example.test/path?q=1")).toEqual(
      { sourceUrl: "https://example.test/path?q=1" },
    );
  });
});
