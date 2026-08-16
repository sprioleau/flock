import { describe, expect, it } from "vitest";
import {
  getAvailableSocialPlatforms,
  isKnownSocialPlatform,
  planSocialLinksUpdate,
} from "./brand-social-links";

/*
  Human-edited social links (brand-kit-user-control §7.2). The reason this is
  validated at all rather than stored verbatim: `classifySocialUrl` is the one
  definition of "a brand profile link", and the scraper leans on it to keep
  share/intent chrome out. A typed link has to clear the same bar or the two
  paths disagree about what the field means.
*/

describe("planSocialLinksUpdate", () => {
  it("canonicalizes what the user typed the same way the scrape does", () => {
    const plan = planSocialLinksUpdate([
      { platform: "x", url: "  HTTP://WWW.X.com/acme/?utm_source=site#top " },
    ]);
    expect(plan).toEqual({ isValid: true, links: [{ platform: "x", url: "https://x.com/acme" }] });
  });

  it("drops a row the user cleared instead of demanding a separate remove", () => {
    const plan = planSocialLinksUpdate([
      { platform: "x", url: "https://x.com/acme" },
      { platform: "instagram", url: "   " },
    ]);
    expect(plan).toEqual({
      isValid: true,
      links: [{ platform: "x", url: "https://x.com/acme" }],
    });
  });

  it("refuses share chrome, which is exactly what the classifier exists to catch", () => {
    const plan = planSocialLinksUpdate([
      { platform: "x", url: "https://x.com/intent/tweet?text=hi" },
    ]);
    expect(plan.isValid).toBe(false);
    expect(plan.isValid === false && plan.message).toMatch(/X profile link/);
  });

  it("refuses a LinkedIn feed URL, which is not a profile", () => {
    const plan = planSocialLinksUpdate([
      { platform: "linkedin", url: "https://linkedin.com/feed/update/123" },
    ]);
    expect(plan.isValid).toBe(false);
  });

  it("refuses a link filed under the wrong platform rather than silently re-filing it", () => {
    const plan = planSocialLinksUpdate([
      { platform: "facebook", url: "https://www.instagram.com/acme" },
    ]);
    expect(plan.isValid).toBe(false);
    expect(plan.isValid === false && plan.message).toMatch(/Instagram link, not a Facebook one/);
  });

  it("keeps one link per platform, in display order", () => {
    const plan = planSocialLinksUpdate([
      { platform: "github", url: "https://github.com/acme" },
      { platform: "x", url: "https://x.com/acme" },
    ]);
    expect(plan.isValid === true && plan.links.map((link) => link.platform)).toEqual(["x", "github"]);
  });

  it("accepts an empty list — clearing every link is a legitimate edit", () => {
    expect(planSocialLinksUpdate([])).toEqual({ isValid: true, links: [] });
  });
});

describe("getAvailableSocialPlatforms", () => {
  it("never offers a platform a row already claims", () => {
    expect(getAvailableSocialPlatforms(["x", "github"])).toEqual([
      "facebook",
      "instagram",
      "linkedin",
      "youtube",
      "tiktok",
    ]);
  });
});

describe("isKnownSocialPlatform", () => {
  it("separates renderable platform keys from legacy or unknown ones", () => {
    expect(isKnownSocialPlatform("linkedin")).toBe(true);
    expect(isKnownSocialPlatform("myspace")).toBe(false);
  });
});
