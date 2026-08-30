/*
  The one real gap in social-link extraction (brand-kit-user-control §7.1).

  The owner's instinct was "Open Graph should be the primary source". Open
  Graph has no property for profile links, so the shipped ladder is JSON-LD
  `Organization.sameAs` then footer/nav anchors — which honors the real
  intent. But `twitter:site` / `twitter:creator` ARE OG-family meta tags that
  do encode a social identity, and nothing mined them.

  They carry a HANDLE, not a URL, so using them means synthesizing a URL the
  page never printed. That is why the rung sits LAST: it only ever fills a
  gap, and anything the brand actually published wins.
*/
import { describe, expect, it } from "vitest";
import { buildXProfileUrlFromHandle, extractSiteIdentity } from "./extract-site-identity";

const BASE_URL = "https://acme.test/";

function identityFor(bodyAndHead: string) {
  return extractSiteIdentity({
    html: `<!doctype html><html><head><title>Acme</title>${bodyAndHead}</html>`,
    baseUrl: BASE_URL,
  });
}

describe("buildXProfileUrlFromHandle", () => {
  it("accepts a handle with or without the @", () => {
    expect(buildXProfileUrlFromHandle("@acme")).toBe("https://x.com/acme");
    expect(buildXProfileUrlFromHandle("acme")).toBe("https://x.com/acme");
    expect(buildXProfileUrlFromHandle("  @acme_hq ")).toBe("https://x.com/acme_hq");
  });

  it("rejects anything that isn't a real handle", () => {
    expect(buildXProfileUrlFromHandle("")).toBeNull();
    expect(buildXProfileUrlFromHandle("@")).toBeNull();
    expect(buildXProfileUrlFromHandle("not a handle")).toBeNull();
    expect(buildXProfileUrlFromHandle("https://x.com/acme")).toBeNull();
    expect(buildXProfileUrlFromHandle("a".repeat(16))).toBeNull(); /* 15 max */
  });
});

describe("twitter:site / twitter:creator as the last social rung", () => {
  it("mines twitter:site when the page publishes no X link anywhere", () => {
    const identity = identityFor('<meta name="twitter:site" content="@acme" /></head><body></body>');
    expect(identity.socialLinks).toEqual([{ platform: "x", url: "https://x.com/acme" }]);
  });

  it("falls back to twitter:creator", () => {
    const identity = identityFor(
      '<meta name="twitter:creator" content="@acme_founder" /></head><body></body>',
    );
    expect(identity.socialLinks).toEqual([{ platform: "x", url: "https://x.com/acme_founder" }]);
  });

  it("NEVER overrides a URL the brand actually published (sameAs wins)", () => {
    const identity = identityFor(
      `<meta name="twitter:site" content="@marketing_handle" />
       <script type="application/ld+json">
         {"@type":"Organization","name":"Acme","sameAs":["https://twitter.com/acme"]}
       </script></head><body></body>`,
    );
    /*
      The published host is preserved verbatim — we never rewrite twitter.com
      to x.com — and the synthesized handle URL is discarded.
    */
    expect(identity.socialLinks).toEqual([{ platform: "x", url: "https://twitter.com/acme" }]);
  });

  it("NEVER overrides a footer anchor either", () => {
    const identity = identityFor(
      `<meta name="twitter:site" content="@marketing_handle" /></head>
       <body><footer><a href="https://x.com/acme">Follow us</a></footer></body>`,
    );
    expect(identity.socialLinks).toEqual([{ platform: "x", url: "https://x.com/acme" }]);
  });

  it("leaves other platforms alone and ignores a junk handle", () => {
    const identity = identityFor(
      `<meta name="twitter:site" content="summary_large_image" /></head>
       <body><footer><a href="https://linkedin.com/company/acme">LinkedIn</a></footer></body>`,
    );
    expect(identity.socialLinks).toEqual([
      { platform: "linkedin", url: "https://linkedin.com/company/acme" },
    ]);
  });
});
