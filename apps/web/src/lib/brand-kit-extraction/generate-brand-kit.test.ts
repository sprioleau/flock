/*
  Pipeline-glue tests for generateBrandKit's asset verification (Gatorade
  bug): a suggested logo/social-card URL that doesn't actually serve an
  image must come back as an ABSENT field while the rest of the kit ships.

  Everything nondeterministic is mocked — the Gemini call ("ai"), the page
  fetch and the asset probes ("./fetch-page"). No network, no model quota.
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

import { brandKitModelOutputSchema, brandKitSchema, generateBrandKit } from "./generate-brand-kit";
import { MAX_EMAIL_DESIGN_DOC_LENGTH } from "@/lib/brand-kit";

const FINAL_URL = "https://acme.test/";
const LOGO_URL = "https://acme.test/apple-touch.png";
const SOCIAL_CARD_URL = "https://cdn.datocms-assets.example/social-card.png";

const FIXTURE_HTML = `<!doctype html><html><head>
  <title>Acme — Robots</title>
  <meta property="og:site_name" content="Acme" />
  <meta property="og:image" content="${SOCIAL_CARD_URL}" />
  <link rel="apple-touch-icon" href="/apple-touch.png" />
  <meta name="theme-color" content="#0f4c81" />
  <meta property="og:description" content="We build robots that get out of your way." />
  <style>:root { --banana: #e0592a; } .hero { color: var(--banana); background: #0f4c81; } .cta { color: #e0592a; }</style>
</head><body><h1>Acme</h1><p>We ship one robot at a time and tell you what it costs.</p></body></html>`;

const semanticVariation = (name: string) => ({
  name,
  emailBackgroundColor: "#f4f6f8",
  contentBackgroundColor: "#ffffff",
  accentColor: "#0f4c81",
  headingTextColor: "#10151b",
  paragraphTextColor: "#2a3540",
});

const SAMPLE_EMAIL_DESIGN_SECTIONS = {
  brandEssence: "Acme reads as plain-spoken and utilitarian: one robot at a time, told plainly.",
  signatureMoves: "A single warm accent used sparingly against a deep ink surface.",
  colorSystem: "Use the accent for buttons and links; the ink surface for headings.",
  typography: "Headings in the mapped Georgia stack; body in the mapped Helvetica stack.",
  layoutStructure: "Single-column, 600px max width.",
  components: {
    header: "Logo left-aligned.",
    hero: "Headline, then CTA.",
    cta: "Solid accent button.",
    card: "Ink-surface panel.",
    divider: "Hairline rule.",
    footer: "Muted text, unsubscribe.",
  },
  voiceAndTone: "Plain-spoken, first-person-plural, short sentences.",
};

/*
  Every canonical header the assembler must always emit — a page can be
  summarised but never allowed to drop one.
*/
const CANONICAL_HEADERS = [
  "## Brand Essence",
  "## Signature Moves",
  "## Color System",
  "## Typography",
  "## Layout & Structure",
  "## Components",
  "### Header",
  "### Hero",
  "### CTA",
  "### Card",
  "### Divider",
  "### Footer",
  "## Voice & Tone",
];

const EMPTY_EMAIL_DESIGN_SECTIONS = {
  brandEssence: "",
  signatureMoves: "",
  colorSystem: "",
  typography: "",
  layoutStructure: "",
  components: { header: "", hero: "", cta: "", card: "", divider: "", footer: "" },
  voiceAndTone: "",
};

const MODEL_OUTPUT = {
  brandName: "Acme",
  headingFont: "Georgia",
  bodyFont: "Helvetica",
  buttonShape: "rounded",
  logoUrl: "",
  colors: [
    { hex: "#e0592a", name: "Banana", category: "accent" as const },
    { hex: "#0f4c81", name: "Ink", category: "primary" as const },
  ],
  toneOfVoice: {
    descriptors: ["warm", "plain-spoken"],
    formality: "casual" as const,
    person: "first-person-plural" as const,
    guidance: "Short sentences.",
  },
  emailDesign: SAMPLE_EMAIL_DESIGN_SECTIONS,
  variations: [semanticVariation("Clean"), semanticVariation("Tint"), semanticVariation("Deep")],
};

/*
  Map of url → canned probe result (both methods); anything else 404s.
*/
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
    stubProbes([LOGO_URL]); /* social card 404s, like the datocms CDN URL did */
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
    /*
      The head's apple-touch-icon 404s; the model picked a harvested
      candidate (og:image is also a harvest candidate) that DOES render.
    */
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

/*
  The authored palette and tone of voice reaching the kit
  (brand-kit-user-control §3 and §5) — the pipeline wiring, as opposed to
  buildBrandColors/extractCopySignals in isolation.
*/
describe("generateBrandKit authored palette + tone of voice", () => {
  it("ships a named, categorized palette carrying the --banana provenance", async () => {
    stubProbes([LOGO_URL, SOCIAL_CARD_URL]);
    const result = await generateBrandKit({ url: "acme.test" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const banana = result.brandKit.colors?.find((color) => color.hex === "#e0592a");
    expect(banana?.name).toBe("Banana");
    expect(banana?.category).toBe("accent");
    expect(banana?.origin).toBe("agent");
    expect(banana?.sourceVariableName).toBe("--banana");
  });

  it("ships tone of voice when the page carried copy", async () => {
    stubProbes([]);
    const result = await generateBrandKit({ url: "acme.test" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.brandKit.toneOfVoice).toEqual({
      descriptors: ["warm", "plain-spoken"],
      formality: "casual",
      person: "first-person-plural",
      guidance: "Short sentences.",
      origin: "agent",
    });
  });

  it("omits tone of voice for a page with NO copy — no invented voice", async () => {
    fetchPageMock.mockResolvedValue({
      isOk: true,
      finalUrl: FINAL_URL,
      html: '<!doctype html><html><head><style>.a{color:#e0592a}</style></head><body><div></div></body></html>',
    });
    stubProbes([]);
    const result = await generateBrandKit({ url: "acme.test" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.brandKit.toneOfVoice).toBeUndefined();
    /*
      The palette still ships: the two features fail independently.
    */
    expect(result.brandKit.colors?.length).toBeGreaterThan(0);
  });

  it("still ships a deterministic palette when the model proposes no colors", async () => {
    generateObjectMock.mockResolvedValue({
      object: { ...MODEL_OUTPUT, colors: [] },
    });
    stubProbes([]);
    const result = await generateBrandKit({ url: "acme.test" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const banana = result.brandKit.colors?.find((color) => color.hex === "#e0592a");
    /*
      Named from the CSS custom property, with no model help at all.
    */
    expect(banana?.name).toBe("Banana");
    expect(banana?.origin).toBe("scraped");
  });
});

/*
  email-design.md authoring (brand-kit-user-control §3): the scrape's ONE
  model call also drafts the standing guidance doc. Honest degrade mirrors
  toneOfVoice — empty markdown means an ABSENT field, never a padded doc.
*/
/*
  The dominant prod 502: a palette-rich brand (a real Shopify store harvested
  ~11 colors) made the model return 7+ colors, and a `.max(6)` ceiling on the
  MODEL output schema rejected the WHOLE object — a ~60% failure rate measured
  live. The pipeline's own tests mock generateObject and so never apply this
  schema, which is how it slipped through; the regression is pinned against
  the schema directly, the way the AI SDK applies it.
*/
describe("brandKitModelOutputSchema colors ceiling", () => {
  const paletteColor = (i: number) => ({
    hex: `#${i.toString(16).padStart(2, "0")}44aa`,
    name: `Color ${i}`,
    category: "primary" as const,
  });
  /*
    A schema-valid model output, varied only in its color count — built fresh
    rather than from MODEL_OUTPUT so an unrelated field can't mask the ceiling
    being exercised.
  */
  const outputWithColors = (n: number) => ({
    brandName: "Acme",
    headingFont: "Georgia",
    bodyFont: "Helvetica",
    buttonShape: "rounded",
    logoUrl: "",
    toneOfVoice: {
      descriptors: ["warm"],
      formality: "casual",
      person: "first-person-plural",
      guidance: "Short.",
    },
    emailDesign: SAMPLE_EMAIL_DESIGN_SECTIONS,
    variations: [semanticVariation("Clean"), semanticVariation("Tint"), semanticVariation("Deep")],
    colors: Array.from({ length: n }, (_, i) => paletteColor(i + 1)),
  });

  it("accepts an 11-color palette (this exact shape 502'd under the old max of 6)", () => {
    expect(brandKitModelOutputSchema.safeParse(outputWithColors(11)).success).toBe(true);
  });

  it("still rejects a runaway palette beyond the ceiling, so padding stays bounded", () => {
    const result = brandKitModelOutputSchema.safeParse(outputWithColors(17));
    expect(result.success).toBe(false);
  });
});

describe("generateBrandKit email-design.md authoring", () => {
  it("assembles an agent-authored email-design.md from the structured sections", async () => {
    stubProbes([]);
    const result = await generateBrandKit({ url: "acme.test" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const doc = result.brandKit.emailDesignDoc;
    expect(doc?.origin).toBe("agent");
    /*
      Every canonical header is laid out, in order, and the section prose is
      carried through verbatim (these bodies are well under budget).
    */
    for (const header of CANONICAL_HEADERS) {
      expect(doc?.markdown).toContain(header);
    }
    expect(doc?.markdown).toContain("Acme reads as plain-spoken and utilitarian");
    expect(doc?.markdown).toContain("Solid accent button.");
    expect(brandKitSchema.safeParse(result.brandKit).success).toBe(true);
  });

  it("omits email-design.md when every section is empty (honest no-signal degrade)", async () => {
    generateObjectMock.mockResolvedValue({
      object: { ...MODEL_OUTPUT, emailDesign: EMPTY_EMAIL_DESIGN_SECTIONS },
    });
    stubProbes([]);
    const result = await generateBrandKit({ url: "acme.test" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.brandKit.emailDesignDoc).toBeUndefined();
    expect(brandKitSchema.safeParse(result.brandKit).success).toBe(true);
  });

  it("still ships a doc — with every header and within the length limit — when a content-heavy page overruns every section", async () => {
    /*
      The regression the owner hit: a long page used to sink the whole call.
      Here the model floods every section far past its budget; the doc must
      still be produced, keep all headers, and never exceed the ceiling.
    */
    const flood = "This is a sentence about the brand and how it presents itself. ".repeat(400);
    generateObjectMock.mockResolvedValue({
      object: {
        ...MODEL_OUTPUT,
        emailDesign: {
          brandEssence: flood,
          signatureMoves: flood,
          colorSystem: flood,
          typography: flood,
          layoutStructure: flood,
          components: {
            header: flood,
            hero: flood,
            cta: flood,
            card: flood,
            divider: flood,
            footer: flood,
          },
          voiceAndTone: flood,
        },
      },
    });
    stubProbes([]);
    const result = await generateBrandKit({ url: "acme.test" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const doc = result.brandKit.emailDesignDoc;
    expect(doc).toBeDefined();
    for (const header of CANONICAL_HEADERS) {
      expect(doc?.markdown).toContain(header);
    }
    expect(doc?.markdown.length).toBeLessThanOrEqual(MAX_EMAIL_DESIGN_DOC_LENGTH);
    /*
      And the assembled doc still passes the wire contract's own length check.
    */
    expect(brandKitSchema.safeParse(result.brandKit).success).toBe(true);
  });
});
