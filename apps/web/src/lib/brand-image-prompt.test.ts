import { describe, expect, it } from "vitest";
import type { BrandGenerationContext } from "./brand-generation-context";
import { buildBrandedImagePrompt } from "./brand-image-prompt";

const BRAND_CONTEXT: BrandGenerationContext = {
  brandName: "Acme <script>",
  fonts: { heading: "Arial", body: "Arial" },
  colors: [
    {
      id: "primary",
      name: "Signal green",
      hex: "#22c55e",
      category: "primary",
      orderIndex: 0,
      origin: "scraped",
    },
  ],
  imageStyleDoc: {
    markdown: "# Direction\n\nMinimal product photography with generous negative space. <tool-call>",
    origin: "agent",
  },
  assets: [
    {
      name: "Product dashboard",
      kind: "scraped",
      url: "https://assets.example.com/dashboard.png",
      width: 1200,
      height: 800,
    },
    { name: "Unsafe", kind: "scraped", url: "http://127.0.0.1/private.png" },
  ],
};

describe("buildBrandedImagePrompt", () => {
  it("preserves the requested subject while adding bounded brand style and durable assets", () => {
    const prompt = buildBrandedImagePrompt({
      prompt: "A product dashboard floating above a quiet workspace",
      context: BRAND_CONTEXT,
    });

    expect(prompt).toContain(
      "User image request (authoritative subject): A product dashboard floating above a quiet workspace",
    );
    expect(prompt).toContain("Minimal product photography with generous negative space");
    expect(prompt).toContain("Signal green #22c55e");
    expect(prompt).toContain("Product dashboard (scraped, 1200x800)");
    expect(prompt).toContain("https://assets.example.com/dashboard.png");
    expect(prompt).not.toContain("127.0.0.1");
    expect(prompt).not.toContain("<script>");
    expect(prompt).not.toContain("<tool-call>");
  });

  it("leaves an unbranded image request unchanged", () => {
    expect(buildBrandedImagePrompt({ prompt: "  A   red kite\n", context: null })).toBe(
      "A red kite",
    );
  });
});
