import { describe, expect, it } from "vitest";
import { FLOCK_USER_AGENT_TOKEN, isPathAllowedByRules, parseRobotsTxt } from "../robots";

/*
  robots.txt is one of the three named reasons a §7.4 fetch may not happen
  (alongside paywalls and outright blocks), so its parsing and precedence get
  the same scrutiny as the extractor: a wrong "allowed" reads a page we were
  asked not to read, and a wrong "disallowed" refuses a page we could have
  used honestly.
*/

function isAllowed({ body, path }: { body: string; path: string }): boolean {
  return isPathAllowedByRules({ groups: parseRobotsTxt(body), path });
}

describe("parseRobotsTxt / isPathAllowedByRules — the wildcard group", () => {
  const body = `
# The site's crawl rules
User-agent: *
Disallow: /private/
Disallow: /admin
Allow: /private/press-releases/
`;

  it("allows an unlisted path", () => {
    expect(isAllowed({ body, path: "/news/solar-canopy" })).toBe(true);
  });

  it("disallows a path under a Disallow prefix", () => {
    expect(isAllowed({ body, path: "/private/board-minutes" })).toBe(false);
    expect(isAllowed({ body, path: "/admin/settings" })).toBe(false);
  });

  it("lets a longer Allow override a shorter Disallow", () => {
    expect(isAllowed({ body, path: "/private/press-releases/q3" })).toBe(true);
  });
});

describe("parseRobotsTxt — group specificity", () => {
  const body = `
User-agent: *
Disallow: /

User-agent: ${FLOCK_USER_AGENT_TOKEN}
Disallow: /checkout
`;

  it("uses our own group in preference to the catch-all group", () => {
    expect(isAllowed({ body, path: "/news/story" })).toBe(true);
    expect(isAllowed({ body, path: "/checkout/cart" })).toBe(false);
  });
});

describe("parseRobotsTxt — syntax handling", () => {
  it("treats an empty Disallow as no restriction at all", () => {
    expect(isAllowed({ body: "User-agent: *\nDisallow:", path: "/anything" })).toBe(true);
  });

  it("blocks the whole site on `Disallow: /`", () => {
    expect(isAllowed({ body: "User-agent: *\nDisallow: /", path: "/" })).toBe(false);
    expect(isAllowed({ body: "User-agent: *\nDisallow: /", path: "/news" })).toBe(false);
  });

  it("honors * wildcards and $ end-anchors in paths", () => {
    const body = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp/*/drafts";
    expect(isAllowed({ body, path: "/reports/annual.pdf" })).toBe(false);
    expect(isAllowed({ body, path: "/reports/annual.pdf.html" })).toBe(true);
    expect(isAllowed({ body, path: "/tmp/2026/drafts/one" })).toBe(false);
  });

  it("shares one rule block across consecutive User-agent lines", () => {
    const body = `User-agent: somebot\nUser-agent: ${FLOCK_USER_AGENT_TOKEN}\nDisallow: /vault`;
    expect(isAllowed({ body, path: "/vault/keys" })).toBe(false);
    expect(isAllowed({ body, path: "/open" })).toBe(true);
  });

  it("ignores comments, blank lines, and fields it doesn't implement", () => {
    const body = `
# comment
Sitemap: https://example.com/sitemap.xml
Crawl-delay: 10

User-agent: *   # trailing comment
Disallow: /secret
`;
    expect(isAllowed({ body, path: "/secret/x" })).toBe(false);
    expect(isAllowed({ body, path: "/public" })).toBe(true);
  });

  it("ignores rules stated before any User-agent line", () => {
    expect(isAllowed({ body: "Disallow: /\nUser-agent: *\nAllow: /", path: "/news" })).toBe(true);
  });

  it("allows everything when the file has no rules for anyone we are", () => {
    expect(isAllowed({ body: "User-agent: othercrawler\nDisallow: /", path: "/news" })).toBe(true);
    expect(isAllowed({ body: "", path: "/news" })).toBe(true);
  });
});
