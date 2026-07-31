/**
 * Unit tests for the brand-kit extraction pipeline (no network, no LLM).
 *
 * Run from apps/web:
 *   ../../packages/email-sdk/node_modules/.bin/tsx src/lib/brand-kit-extraction/__tests__/run-tests.ts
 *
 * Plain node:assert — the web app has no test runner; this mirrors how other
 * tsx verification scripts are run in this repo.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  getVariationContrastPairs,
  MIN_THEME_CONTRAST_RATIO,
  MOCK_BRAND_KIT,
} from "@/lib/brand-kit";
import { normalizeCssColor } from "../color-utils";
import { expandSemanticVariation, repairForegroundContrast } from "../expand-variations";
import { cleanTitleToBrandName, extractSiteIdentity } from "../extract-site-identity";
import { brandKitSchema } from "../generate-brand-kit";
import { harvestBrandSignals } from "../harvest";
import { isBlockedAddress, normalizeWebsiteUrl, validateUrlSyntax } from "../url-guard";

let testCount = 0;
function check(label: string, assertion: () => void) {
  testCount += 1;
  try {
    assertion();
    console.log(`  ok  ${label}`);
  } catch (error) {
    console.error(`FAIL  ${label}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 1. URL guard / SSRF
// ---------------------------------------------------------------------------

console.log("url-guard");
const rejectedUrls = [
  "ftp://example.com",
  "javascript:alert(1)",
  "http://localhost:3000",
  "http://foo.localhost",
  "http://intranet", // no dot — internal name
  "http://127.0.0.1/admin",
  "http://10.0.0.5",
  "http://172.16.9.1",
  "http://192.168.1.1",
  "http://169.254.169.254/latest/meta-data", // cloud metadata
  "http://0.0.0.0",
  "http://[::1]/",
  "http://[fd00::1]/",
  "http://service.internal",
  `https://example.com/${"a".repeat(3000)}`, // over length cap
  "not a url",
];
for (const url of rejectedUrls) {
  check(`rejects ${url.slice(0, 60)}`, () => {
    assert.equal(validateUrlSyntax(url).isAllowed, false);
  });
}
for (const url of ["https://stripe.com", "http://example.com/page?q=1", "https://sprioleau.dev"]) {
  check(`allows ${url}`, () => {
    assert.equal(validateUrlSyntax(url).isAllowed, true);
  });
}
check("blocks private resolved addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.31.0.1", "192.168.0.9", "169.254.169.254", "::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "100.64.0.1"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
});
check("allows public resolved addresses", () => {
  for (const ip of ["8.8.8.8", "151.101.1.140", "2606:4700::6810:84e5"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

// ---------------------------------------------------------------------------
// 1b. Scheme-less URL normalization (https only — NEVER http)
// ---------------------------------------------------------------------------

console.log("normalizeWebsiteUrl");
check("scheme-less input gets https:// (never http)", () => {
  assert.equal(normalizeWebsiteUrl("cnn.com"), "https://cnn.com");
  assert.equal(normalizeWebsiteUrl("  cnn.com/travel  "), "https://cnn.com/travel");
  assert.equal(normalizeWebsiteUrl("//cdn.example.com"), "https://cdn.example.com");
  assert.ok(!normalizeWebsiteUrl("cnn.com").startsWith("http://"), "must never force http://");
});
check("input with a scheme is left untouched", () => {
  assert.equal(normalizeWebsiteUrl("https://cnn.com"), "https://cnn.com");
  assert.equal(normalizeWebsiteUrl("http://example.com"), "http://example.com");
  assert.equal(normalizeWebsiteUrl("ftp://example.com"), "ftp://example.com"); // guard rejects downstream
});
check("normalized scheme-less internal hosts are still SSRF-rejected", () => {
  for (const raw of ["localhost", "intranet", "127.0.0.1", "192.168.1.1", "service.internal"]) {
    assert.equal(validateUrlSyntax(normalizeWebsiteUrl(raw)).isAllowed, false, raw);
  }
  assert.equal(validateUrlSyntax(normalizeWebsiteUrl("cnn.com")).isAllowed, true);
});

// ---------------------------------------------------------------------------
// 1c. Deterministic site identity (logo / name / social card ladder)
// ---------------------------------------------------------------------------

console.log("extract-site-identity");
const BASE_URL = "https://acme.test/";

check("og:logo wins the logo ladder; og:site_name wins the name ladder", () => {
  const identity = extractSiteIdentity({
    html: `<head>
      <meta property="og:logo" content="/brand/og-logo.png" />
      <meta property="og:site_name" content="Acme" />
      <meta property="og:image" content="https://cdn.acme.test/card.png" />
      <link rel="icon" type="image/svg+xml" href="/icon.svg" />
      <title>Acme — Robots</title>
    </head><header><img src="/nav-logo.png" class="logo" /></header>`,
    baseUrl: BASE_URL,
  });
  assert.equal(identity.logoUrl, "https://acme.test/brand/og-logo.png");
  assert.equal(identity.siteName, "Acme");
  assert.equal(identity.socialImageUrl, "https://cdn.acme.test/card.png");
});

check("JSON-LD Organization supplies logo + name when og tags are absent", () => {
  const identity = extractSiteIdentity({
    html: `<script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"WebSite","name":"ignored"},
        {"@type":"NewsMediaOrganization","name":"Acme News","logo":{"@type":"ImageObject","url":"https://acme.test/jsonld-logo.png"}}
      ]}
    </script><link rel="icon" href="/favicon.ico" /><title>Acme News | Home</title>`,
    baseUrl: BASE_URL,
  });
  assert.equal(identity.logoUrl, "https://acme.test/jsonld-logo.png");
  assert.equal(identity.siteName, "Acme News");
});

check("icon ladder prefers SVG over apple-touch-icon over sized favicons", () => {
  const svgFirst = extractSiteIdentity({
    html: `<link rel="icon" sizes="48x48" href="/favicon-48.png" />
      <link rel="apple-touch-icon" href="/apple-touch.png" />
      <link rel="icon" type="image/svg+xml" href="/icon.svg" />`,
    baseUrl: BASE_URL,
  });
  assert.equal(svgFirst.logoUrl, "https://acme.test/icon.svg");
  const appleTouchNext = extractSiteIdentity({
    html: `<link rel="icon" sizes="48x48" href="/favicon-48.png" />
      <link rel="apple-touch-icon" href="/apple-touch.png" />`,
    baseUrl: BASE_URL,
  });
  assert.equal(appleTouchNext.logoUrl, "https://acme.test/apple-touch.png");
});

check("masthead fallback: logo-hinted <img> when the head has no logo signals", () => {
  const identity = extractSiteIdentity({
    html: `<title>Acme</title>
      <header><img src="/img/hero.jpg" alt="A friendly robot" /><img src="/img/acme-mark.png" class="site-logo" /></header>`,
    baseUrl: BASE_URL,
  });
  assert.equal(identity.logoUrl, "https://acme.test/img/acme-mark.png");
});

check("masthead fallback: inline <svg> is serialized to a data: URI (xmlns injected)", () => {
  const identity = extractSiteIdentity({
    html: `<title>Acme</title>
      <nav><a href="/"><svg class="acme-logo" viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg></a></nav>`,
    baseUrl: BASE_URL,
  });
  assert.ok(identity.logoUrl?.startsWith("data:image/svg+xml;base64,"), identity.logoUrl ?? "(null)");
  const decoded = Buffer.from(
    (identity.logoUrl ?? "").replace("data:image/svg+xml;base64,", ""),
    "base64",
  ).toString("utf-8");
  assert.ok(decoded.includes('xmlns="http://www.w3.org/2000/svg"'), "xmlns injected");
  assert.ok(decoded.includes('class="acme-logo"'), "original markup preserved");
});

check("private-network logo URLs are dropped and the ladder falls through", () => {
  const identity = extractSiteIdentity({
    html: `<meta property="og:logo" content="http://192.168.1.10/logo.png" />
      <link rel="apple-touch-icon" href="/apple-touch.png" />`,
    baseUrl: BASE_URL,
  });
  assert.equal(identity.logoUrl, "https://acme.test/apple-touch.png");
});

check("title cleaning: brand segment before the first separator", () => {
  assert.equal(cleanTitleToBrandName("CNN — Breaking News, Latest News and Videos"), "CNN");
  assert.equal(cleanTitleToBrandName("Acme | Robots for everyone"), "Acme");
  assert.equal(cleanTitleToBrandName("Acme · Home"), "Acme");
  assert.equal(cleanTitleToBrandName("Stripe - Payments infrastructure"), "Stripe");
  assert.equal(cleanTitleToBrandName("Just Acme"), "Just Acme");
  assert.equal(cleanTitleToBrandName("   "), null);
});

check("social links: JSON-LD sameAs is canonical; share URLs and dupes filtered", () => {
  const identity = extractSiteIdentity({
    html: `<script type="application/ld+json">
      {"@type":"Organization","name":"Acme","sameAs":[
        "https://x.com/acme-canonical",
        "https://www.instagram.com/acme/?hl=en",
        "https://en.wikipedia.org/wiki/Acme",
        "https://twitter.com/intent/tweet?text=hi"
      ]}
    </script>
    <footer>
      <a href="https://x.com/acme-footer">X</a>
      <a href="https://www.facebook.com/sharer.php?u=x">Share</a>
      <a href="https://facebook.com/acmeinc">Facebook</a>
      <a href="https://github.com/acme">GitHub</a>
    </footer>`,
    baseUrl: BASE_URL,
  });
  assert.deepEqual(identity.socialLinks, [
    { platform: "x", url: "https://x.com/acme-canonical" }, // sameAs beats the footer anchor
    { platform: "facebook", url: "https://facebook.com/acmeinc" }, // share link skipped
    { platform: "instagram", url: "https://instagram.com/acme" }, // query stripped
    { platform: "github", url: "https://github.com/acme" },
  ]);
});

check("social links: Organization nested inside a WebPage node (CNN shape)", () => {
  const identity = extractSiteIdentity({
    html: `<script type="application/ld+json">
      {"@type":"WebPage","name":"Home","publisher":{"@type":"NewsMediaOrganization","name":"CNN",
        "sameAs":["https://www.facebook.com/cnn/","https://x.com/CNN","https://www.tiktok.com/@cnn"]}}
    </script>`,
    baseUrl: BASE_URL,
  });
  assert.equal(identity.siteName, "CNN"); // nested Organization name found too
  assert.deepEqual(identity.socialLinks, [
    { platform: "x", url: "https://x.com/CNN" },
    { platform: "facebook", url: "https://facebook.com/cnn" },
    { platform: "tiktok", url: "https://tiktok.com/@cnn" },
  ]);
});

check("social links: footer/nav anchor fallback works without JSON-LD", () => {
  const identity = extractSiteIdentity({
    html: `<nav><a href="https://www.linkedin.com/company/acme">LinkedIn</a></nav>
      <footer><a href="https://youtube.com/@acme">YouTube</a><a href="/contact">Contact</a></footer>`,
    baseUrl: BASE_URL,
  });
  assert.deepEqual(identity.socialLinks, [
    { platform: "linkedin", url: "https://linkedin.com/company/acme" },
    { platform: "youtube", url: "https://youtube.com/@acme" },
  ]);
});

check("social links: empty when the page has none", () => {
  const identity = extractSiteIdentity({
    html: `<title>Acme</title><footer><a href="/privacy">Privacy</a></footer>`,
    baseUrl: BASE_URL,
  });
  assert.deepEqual(identity.socialLinks, []);
});

check("identity on the saved fixture: head icons beat the masthead, name from og:site_name", () => {
  const fixtureForIdentity = readFileSync(
    path.join(process.cwd(), "src/lib/brand-kit-extraction/__tests__/fixtures/sample-site.html"),
    "utf-8",
  );
  const identity = extractSiteIdentity({ html: fixtureForIdentity, baseUrl: BASE_URL });
  assert.equal(identity.siteName, "Acme Robotics");
  assert.equal(identity.logoUrl, "https://acme.test/icons/apple-touch-icon.png");
  assert.equal(identity.socialImageUrl, "https://cdn.acme.test/social/og-card.png");
});

// ---------------------------------------------------------------------------
// 2. Color normalization
// ---------------------------------------------------------------------------

console.log("color-utils");
check("normalizes hex + rgb + hsl forms, rejects noise", () => {
  assert.equal(normalizeCssColor("#ABC"), "#aabbcc");
  assert.equal(normalizeCssColor("#0f4c81"), "#0f4c81");
  assert.equal(normalizeCssColor("rgb(31, 41, 55)"), "#1f2937");
  assert.equal(normalizeCssColor("rgba(224, 89, 42, 0.9)"), "#e0592a");
  assert.equal(normalizeCssColor("rgba(0, 0, 0, 0.2)"), null); // low alpha
  assert.equal(normalizeCssColor("hsl(210, 70%, 40%)"), "#1f66ad");
  assert.equal(normalizeCssColor("hsl(210 70% 40%)"), "#1f66ad"); // space syntax
  assert.equal(normalizeCssColor("hsl(0, 100%, 50%)"), "#ff0000");
  assert.equal(normalizeCssColor("hsla(210, 70%, 40%, 0.2)"), null); // low alpha
  assert.equal(normalizeCssColor("var(--brand)"), null);
  assert.equal(normalizeCssColor("oklch(0.7 0.1 200)"), null);
});

// ---------------------------------------------------------------------------
// 3. Harvest on a saved fixture (stubbed stylesheet fetcher)
// ---------------------------------------------------------------------------

console.log("harvest");
const fixtureHtml = readFileSync(
  path.join(process.cwd(), "src/lib/brand-kit-extraction/__tests__/fixtures/sample-site.html"),
  "utf-8",
);
const fetchedCssUrls: string[] = [];
// No top-level await (this script compiles as CJS): resolve synchronously
// via then() — the stubbed fetcher makes the promise settle immediately, and
// the trailing summary runs inside the chain.
void harvestBrandSignals({
  html: fixtureHtml,
  finalUrl: "https://acme.test/",
  fetchCss: async (url) => {
    fetchedCssUrls.push(url);
    // Cross-origin stylesheet fails soft (null); same-origin returns CSS.
    if (!url.startsWith("https://acme.test/")) {
      return null;
    }
    return ".external { color: #2dd4bf; background: #2dd4bf; }";
  },
}).then(runRemainingChecks);

function runRemainingChecks(signals: Awaited<ReturnType<typeof harvestBrandSignals>>) {
check("site identity + theme color", () => {
  assert.equal(signals.siteName, "Acme Robotics");
  assert.equal(signals.pageTitle, "Acme Robotics — Build the future & beyond");
  assert.equal(signals.themeColor, "#0f4c81");
});
check("stylesheets fetched same-origin first, cross-origin allowed, fonts CDN excluded", () => {
  assert.deepEqual(fetchedCssUrls, [
    "https://acme.test/assets/main.css",
    "https://cdn.other-origin.test/vendor.css",
  ]);
});
check("fonts: google fonts + css families, icon fonts filtered", () => {
  assert.ok(signals.fontFamilies.includes("Playfair Display"));
  assert.ok(signals.fontFamilies.includes("Inter"));
  assert.ok(!signals.fontFamilies.some((family) => family.includes("Awesome")));
});
check("colors ranked, low-alpha + near-white/black filtered, external css included", () => {
  const colors = signals.rankedColors.map(({ color }) => color);
  assert.ok(colors.includes("#0f4c81"));
  assert.ok(colors.includes("#e0592a"));
  assert.ok(colors.includes("#1f2937"));
  assert.ok(colors.includes("#1f66ad")); // from hsl(210, 70%, 40%)
  assert.ok(colors.includes("#2dd4bf")); // from stubbed external stylesheet
  assert.ok(!colors.includes("#ffffff"));
  const accentRank = colors.indexOf("#e0592a");
  const tealRank = colors.indexOf("#2dd4bf");
  assert.ok(accentRank < tealRank, "frequent accent ranks above one-off color");
});
check("custom-property accent: var() references weight it to the top", () => {
  const top = signals.rankedColors[0];
  assert.equal(top.color, "#ffd23f");
  assert.equal(top.variableName, "--acme-accent");
  assert.equal(top.count, 4, "1 definition + 3 var() references"); // effective usage
});
check("accent candidates: vibrant subset, signature accent first, no grays/navies", () => {
  assert.ok(signals.accentCandidates.length > 0);
  assert.equal(signals.accentCandidates[0].color, "#ffd23f");
  const accentColors = signals.accentCandidates.map(({ color }) => color);
  assert.ok(accentColors.includes("#e0592a"));
  assert.ok(!accentColors.includes("#1f2937"), "muted body-text color is not an accent");
});
check("logo candidates: logo img first, absolute urls, no photo", () => {
  assert.equal(signals.logoCandidates[0].url, "https://acme.test/img/acme-logo.svg");
  const urls = signals.logoCandidates.map(({ url }) => url);
  assert.ok(urls.includes("https://acme.test/favicon.ico"));
  assert.ok(urls.includes("https://cdn.acme.test/social/og-card.png"));
  assert.ok(!urls.some((url) => url.includes("hero-photo")));
});

// ---------------------------------------------------------------------------
// 4. Contrast repair
// ---------------------------------------------------------------------------

console.log("contrast repair");
check("repairs a failing light-on-light foreground", () => {
  const repaired = repairForegroundContrast({ foreground: "#aaaaaa", background: "#ffffff" });
  const ratio = getVariationContrastPairs({
    id: "x",
    name: "x",
    globals: { ...MOCK_BRAND_KIT.variations[0].globals, paragraphTextColor: repaired, contentBackgroundColor: "#ffffff" },
  }).find((pair) => pair.label === "paragraph on content")?.ratio;
  assert.ok(ratio !== null && ratio !== undefined && ratio >= MIN_THEME_CONTRAST_RATIO, `got ${ratio}`);
});
check("keeps an already-passing foreground unchanged", () => {
  assert.equal(repairForegroundContrast({ foreground: "#111827", background: "#ffffff" }), "#111827");
});
check("worst-case mid-gray background still repairable", () => {
  const repaired = repairForegroundContrast({ foreground: "#808080", background: "#757575" });
  assert.ok(["#000000", "#ffffff"].includes(repaired) || true); // value free; ratio must pass:
  const pairs = getVariationContrastPairs({
    id: "x",
    name: "x",
    globals: { ...MOCK_BRAND_KIT.variations[0].globals, paragraphTextColor: repaired, contentBackgroundColor: "#757575" },
  });
  const ratio = pairs.find((pair) => pair.label === "paragraph on content")?.ratio;
  assert.ok(ratio !== null && ratio !== undefined && ratio >= MIN_THEME_CONTRAST_RATIO, `got ${ratio}`);
});

// A deliberately failing semantic palette: light gray text on white, a
// pale accent — every guarded pairing must come back repaired to >= 4.5.
const expanded = expandSemanticVariation({
  semantic: {
    name: "Deliberately Bad",
    emailBackgroundColor: "#f7f3ec",
    contentBackgroundColor: "#ffffff",
    accentColor: "#ffd9c4", // pale — link + button label both need repair
    headingTextColor: "#cccccc",
    paragraphTextColor: "#bbbbbb",
  },
  fonts: { heading: "Georgia, 'Times New Roman', serif", body: "Helvetica, Arial, sans-serif" },
  buttonShape: "rounded",
});
check("failing palette is repaired, not rejected", () => {
  assert.ok(expanded !== null);
  for (const pair of getVariationContrastPairs(expanded)) {
    assert.ok(
      pair.ratio !== null && pair.ratio >= MIN_THEME_CONTRAST_RATIO,
      `${pair.label}: ${pair.ratio} (${pair.foreground} on ${pair.background})`,
    );
  }
});
check("unparseable color drops the variation (returns null)", () => {
  const dropped = expandSemanticVariation({
    semantic: {
      name: "Broken",
      emailBackgroundColor: "not-a-color",
      contentBackgroundColor: "#ffffff",
      accentColor: "#123456",
      headingTextColor: "#111111",
      paragraphTextColor: "#333333",
    },
    fonts: { heading: "Georgia, 'Times New Roman', serif", body: "Helvetica, Arial, sans-serif" },
    buttonShape: "pill",
  });
  assert.equal(dropped, null);
});
check("layout keys stay at renderer defaults (recolor, never reflow)", () => {
  assert.ok(expanded !== null);
  assert.equal(expanded.globals.contentWidth, 600);
  assert.equal(expanded.globals.baseSpacing, 24);
  assert.equal(expanded.globals.buttonBorderSize, 0);
  assert.equal(expanded.globals.paragraphTextAlign, "left");
});

// ---------------------------------------------------------------------------
// 5. Final BrandKit Zod contract
// ---------------------------------------------------------------------------

console.log("brand-kit schema");
check("MOCK_BRAND_KIT passes the contract schema", () => {
  assert.equal(brandKitSchema.safeParse(MOCK_BRAND_KIT).success, true);
});
check("incomplete globals payload fails the contract schema", () => {
  const incompleteGlobals: Partial<typeof MOCK_BRAND_KIT.variations[0]["globals"]> = {
    ...MOCK_BRAND_KIT.variations[0].globals,
  };
  delete incompleteGlobals.dividerColor;
  const badKit = {
    ...MOCK_BRAND_KIT,
    variations: [
      { ...MOCK_BRAND_KIT.variations[0], globals: incompleteGlobals },
      ...MOCK_BRAND_KIT.variations.slice(1),
    ],
  };
  assert.equal(brandKitSchema.safeParse(badKit).success, false);
});
check("fewer than 3 variations fails the contract schema", () => {
  const badKit = { ...MOCK_BRAND_KIT, variations: MOCK_BRAND_KIT.variations.slice(0, 2) };
  assert.equal(brandKitSchema.safeParse(badKit).success, false);
});

console.log(`\nAll ${testCount} checks passed.`);
}
