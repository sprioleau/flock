import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MOCK_BRAND_KIT, type BrandKit } from "@/lib/brand-kit";
import { BrandKitChatArtifact } from "./BrandKitChatArtifact";

describe("BrandKitChatArtifact", () => {
  it("shows identity evidence, five source images, and the brand palette after completion", () => {
    const brandKit: BrandKit = {
      ...MOCK_BRAND_KIT,
      name: "Acme",
      logoUrl: "https://acme.test/logo.svg",
      faviconUrl: "https://acme.test/favicon.png",
      socialImageUrl: "https://acme.test/social.jpg",
      sourceImages: Array.from({ length: 5 }, (_, index) => ({
        url: `https://acme.test/image-${index + 1}.jpg`,
        alt: `Acme product image ${index + 1}`,
      })),
    };

    const markup = renderToStaticMarkup(
      <BrandKitChatArtifact
        job={{
          sourceUrl: "https://acme.test/",
          status: "succeeded",
          step: "complete",
        }}
        brandKit={brandKit}
      />,
    );

    expect(markup).toContain('aria-label="Open Acme brand kit"');
    expect(markup).toContain("Favicon");
    expect(markup).toContain("Social card");
    expect(markup.match(/Acme product image/g)).toHaveLength(5);
    expect(markup).toContain('aria-label="Brand color palette"');
    expect(markup).toContain("group-hover/artifact");
    expect(markup.match(/bg-white object-cover/g)).toHaveLength(5);
    expect(markup).toContain("left-1/2 top-9");
    expect(markup).toContain("flex h-4 overflow-hidden rounded-b-lg");
    expect(markup).not.toContain("flex h-8 overflow-hidden rounded-b-lg");
    expect(markup).toContain('aria-label="Brand kit scan progress"');
    expect(markup).toContain("Opened the website");
    expect(markup).toContain("Found the visual identity");
    expect(markup).toContain("Built colors, fonts and imagery");
    expect(markup).toContain("Saved the brand kit");
    expect(markup.match(/text-success/g)).toHaveLength(4);
  });

  it("renders live progress before a kit is ready", () => {
    const markup = renderToStaticMarkup(
      <BrandKitChatArtifact
        job={{
          sourceUrl: "https://acme.test/",
          status: "running",
          step: "finding-identity",
        }}
      />,
    );

    expect(markup).toContain("Add a brand kit based on acme.test");
    expect(markup).toContain("Found the visual identity");
    expect(markup).toContain('aria-label="Brand kit scan progress"');
  });
});
