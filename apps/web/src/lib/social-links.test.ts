import { describe, expect, it } from "vitest";
import { classifySocialUrl, dedupeSocialLinks } from "./social-links";

describe("classifySocialUrl", () => {
  it("classifies profile URLs across the platform list", () => {
    expect(classifySocialUrl("https://x.com/acme")).toEqual({ platform: "x", url: "https://x.com/acme" });
    expect(classifySocialUrl("https://twitter.com/acme")).toEqual({ platform: "x", url: "https://twitter.com/acme" });
    expect(classifySocialUrl("https://www.facebook.com/acmeinc")).toEqual({ platform: "facebook", url: "https://facebook.com/acmeinc" });
    expect(classifySocialUrl("https://instagram.com/acme/")).toEqual({ platform: "instagram", url: "https://instagram.com/acme" });
    expect(classifySocialUrl("https://www.linkedin.com/company/acme")).toEqual({ platform: "linkedin", url: "https://linkedin.com/company/acme" });
    expect(classifySocialUrl("https://youtube.com/@acme")).toEqual({ platform: "youtube", url: "https://youtube.com/@acme" });
    expect(classifySocialUrl("https://github.com/acme")).toEqual({ platform: "github", url: "https://github.com/acme" });
    expect(classifySocialUrl("https://www.tiktok.com/@acme")).toEqual({ platform: "tiktok", url: "https://tiktok.com/@acme" });
  });

  it("canonicalizes: https, www stripped, query/hash/trailing slash dropped", () => {
    expect(classifySocialUrl("http://www.x.com/acme/?utm_source=footer#top")).toEqual({
      platform: "x",
      url: "https://x.com/acme",
    });
  });

  it("rejects share/intent chrome and content pages", () => {
    expect(classifySocialUrl("https://x.com/intent/tweet?text=hi")).toBeNull();
    expect(classifySocialUrl("https://twitter.com/share")).toBeNull();
    expect(classifySocialUrl("https://www.facebook.com/sharer.php?u=https://a.com")).toBeNull();
    expect(classifySocialUrl("https://www.linkedin.com/shareArticle?mini=true")).toBeNull();
    expect(classifySocialUrl("https://www.youtube.com/watch?v=abc123")).toBeNull();
    expect(classifySocialUrl("https://instagram.com/p/Cxyz/")).toBeNull();
  });

  it("rejects bare homepages, non-social hosts, and junk", () => {
    expect(classifySocialUrl("https://x.com/")).toBeNull();
    expect(classifySocialUrl("https://example.com/acme")).toBeNull();
    expect(classifySocialUrl("mailto:hi@acme.com")).toBeNull();
    expect(classifySocialUrl("not a url")).toBeNull();
    /*
      linkedin needs a profile-ish first segment
    */
    expect(classifySocialUrl("https://www.linkedin.com/jobs/view/123")).toBeNull();
  });

  it("does not classify lookalike hosts (suffix-anchored matching)", () => {
    expect(classifySocialUrl("https://notx.com/acme")).toBeNull();
    expect(classifySocialUrl("https://myfacebook.company.com/acme")).toBeNull();
  });
});

describe("dedupeSocialLinks", () => {
  it("keeps one link per platform (first wins) in display order", () => {
    const deduped = dedupeSocialLinks([
      { platform: "instagram", url: "https://instagram.com/acme" },
      { platform: "x", url: "https://x.com/acme" },
      { platform: "x", url: "https://twitter.com/acme-old" },
      { platform: "github", url: "https://github.com/acme" },
    ]);
    expect(deduped).toEqual([
      { platform: "x", url: "https://x.com/acme" }, /* first x won; ordered first */
      { platform: "instagram", url: "https://instagram.com/acme" },
      { platform: "github", url: "https://github.com/acme" },
    ]);
  });
});
