/**
 * Pipeline-glue tests for generateBrandKit's asset verification (Gatorade
 * bug): a suggested logo/social-card URL that doesn't actually serve an
 * image must come back as an ABSENT field while the rest of the kit ships.
 *
 * Everything nondeterministic is mocked — the Gemini call ("ai"), the page
 * fetch and the asset probes ("./fetch-page"). No network, no model quota.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetProbeMethod, AssetProbeResult } from "./fetch-page";

const generateObjectMock = vi.hoisted(() => vi.fn());
const fetchPageMock = vi.hoisted(() => vi.fn());
const probeAssetUrlMock = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({ generateObject: generateObjectMock }));
vi.mock("@ai-sdk/google", () => ({ google: () => ({ modelId: "stub" }) }));
vi.mock("./fetch-page", () => ({
  fetchPage: fetchPageMock,
  fetchTextResource: vi.fn(async () => null),
  probeAssetUrl: probeAssetUrlMock,
}));

import { generateBrandKit } from "./generate-brand-kit";

const FINAL_URL = "https://acme.test/";
const LOGO_URL = "https://acme.test/apple-touch.png";
const SOCIAL_CARD_URL = "https://cdn.datocms-assets.example/social-card.png";

const FIXTURE_HTML = `<!doctype html><html><head>
  <title>Acme — Robots</title>
  <meta property="og:site_name" content="Acme" />
  <meta property="og:image" content="${SOCIAL_CARD_URL}" />
  <link rel="apple-touch-icon" href="/apple-touch.png" />
  <meta name="theme-color" content="#0f4c81" />
  <style>.hero { color: #e0592a; background: #0f4c81; } .cta { color: #e0592a; }</style>
</head><body><h1>Acme</h1></body></html>`;

const semanticVariation = (name: string) => ({
  name,
  emailBackgroundColor: "#f4f6f8",
  contentBackgroundColor: "#ffffff",
  accentColor: "#0f4c81",
  headingTextColor: "#10151b",
  paragraphTextColor: "#2a3540",
});

const MODEL_OUTPUT = {
  brandName: "Acme",
  headingFont: "Georgia",
  bodyFont: "Helvetica",
  buttonShape: "rounded",
  logoUrl: "",
  variations: [semanticVariation("Clean"), semanticVariation("Tint"), semanticVariation("Deep")],
};

/** Map of url → canned probe result (both methods); anything else 404s. */
function stubProbes(liveImageUrls: string[]) {
  probeAssetUrlMock.mockImplementation(
    async ({ url }: { url: string; method: AssetProbeMethod }): Promise<AssetProbeResult> =>
      liveImageUrls.includes(url)
        ? { isOk: true, status: 200, contentType: "image/png" }
        : { isOk: true, status: 404, contentType: "text/html" },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
  fetchPageMock.mockResolvedValue({ isOk: true, html: FIXTURE_HTML, finalUrl: FINAL_URL });
  generateObjectMock.mockResolvedValue({ object: MODEL_OUTPUT });
});

describe("generateBrandKit asset verification", () => {
  it("keeps assets whose URLs verifiably serve images", async () => {
    stubProbes([LOGO_URL, SOCIAL_CARD_URL]);
    const result = await generateBrandKit({ url: "acme.test" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.brandKit.logoUrl).toBe(LOGO_URL);
    expect(result.brandKit.socialImageUrl).toBe(SOCIAL_CARD_URL);
  });

  it("drops a dead social card but ships the rest of the kit (the Gatorade bug)", async () => {
    stubProbes([LOGO_URL]); // social card 404s, like the datocms CDN URL did
    const result = await generateBrandKit({ url: "acme.test" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.brandKit.socialImageUrl).toBeUndefined();
    expect(result.brandKit.logoUrl).toBe(LOGO_URL);
    expect(result.brandKit.name).toBe("Acme");
    expect(result.brandKit.variations).toHaveLength(3);
  });

  it("drops BOTH assets when neither URL renders — kit still generates", async () => {
    stubProbes([]);
    const result = await generateBrandKit({ url: "acme.test" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.brandKit.logoUrl).toBeUndefined();
    expect(result.brandKit.socialImageUrl).toBeUndefined();
    expect(result.brandKit.fonts.heading).toContain("Georgia");
    expect(result.brandKit.variations).toHaveLength(3);
  });

  it("falls back to the model's harvested logo pick when the head logo is dead", async () => {
    // The head's apple-touch-icon 404s; the model picked a harvested
    // candidate (og:image is also a harvest candidate) that DOES render.
    generateObjectMock.mockResolvedValue({
      object: { ...MODEL_OUTPUT, logoUrl: SOCIAL_CARD_URL },
    });
    stubProbes([SOCIAL_CARD_URL]);
    const result = await generateBrandKit({ url: "acme.test" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.brandKit.logoUrl).toBe(SOCIAL_CARD_URL);
  });
});
