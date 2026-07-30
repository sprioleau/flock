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
import { brandKitSchema } from "../generate-brand-kit";
import { harvestBrandSignals } from "../harvest";
import { isBlockedAddress, validateUrlSyntax } from "../url-guard";

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
// 2. Color normalization
// ---------------------------------------------------------------------------

console.log("color-utils");
check("normalizes hex + rgb forms, rejects noise", () => {
  assert.equal(normalizeCssColor("#ABC"), "#aabbcc");
  assert.equal(normalizeCssColor("#0f4c81"), "#0f4c81");
  assert.equal(normalizeCssColor("rgb(31, 41, 55)"), "#1f2937");
  assert.equal(normalizeCssColor("rgba(224, 89, 42, 0.9)"), "#e0592a");
  assert.equal(normalizeCssColor("rgba(0, 0, 0, 0.2)"), null); // low alpha
  assert.equal(normalizeCssColor("hsl(20, 50%, 50%)"), null);
  assert.equal(normalizeCssColor("var(--brand)"), null);
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
  assert.ok(colors.includes("#2dd4bf")); // from stubbed external stylesheet
  assert.ok(!colors.includes("#ffffff"));
  const accentRank = colors.indexOf("#e0592a");
  const tealRank = colors.indexOf("#2dd4bf");
  assert.ok(accentRank < tealRank, "frequent accent ranks above one-off color");
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
