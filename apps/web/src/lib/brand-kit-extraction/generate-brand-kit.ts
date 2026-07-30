/**
 * Brand-kit generation pipeline (Phase 7.4, brand/theme mode):
 *
 *   fetchPage (guarded, reusable primitive)
 *     → harvestBrandSignals (deterministic, no LLM)
 *       → ONE Gemini structured call (semantic assignments only)
 *         → deterministic expand + contrast repair (expand-variations.ts)
 *           → Zod validation of the final BrandKit
 *
 * Faithfulness: the model only ever sees — and is told to only use — colors,
 * fonts and logo URLs that were literally harvested from the page. The logo
 * URL is re-checked against the candidate list after the call (never
 * invented), and unreadable pages fail honestly upstream of any model call.
 */

import { google } from "@ai-sdk/google";
import { globalStylesSchema } from "@tandem/email-sdk";
import { generateObject } from "ai";
import { z } from "zod";
import type { BrandKit, BrandKitFonts } from "@/lib/brand-kit";
import { EMAIL_SAFE_FONT_OPTIONS } from "@/components/studio/text-editor/email-safe-fonts";
import { expandSemanticVariation, BUTTON_SHAPE_RADII, type ButtonShape } from "./expand-variations";
import { fetchPage, fetchTextResource } from "./fetch-page";
import { harvestBrandSignals, type BrandSignals } from "./harvest";

export type BrandKitGenerationResult =
  | { isOk: true; brandKit: BrandKit }
  | { isOk: false; message: string; statusCode: number };

const MIN_VARIATIONS = 3;
const GENERATION_TIMEOUT_MS = 60_000; // flash-lite has been observed near 45s on color-heavy sites

/**
 * Model for the one structured brand-kit call. Deliberately NOT the chat
 * pipeline's DEFAULT_GEMINI_MODEL_ID ("gemini-3.6-flash"): Gemini free-tier
 * daily quotas are per-model, and sharing the chat model's tiny bucket means
 * a busy chat session starves brand-kit generation (observed live —
 * 20 req/day per model). Chosen empirically on 2026-07-30: 3.5-flash was
 * 503-ing ("high demand") and 2.5-flash is retired for new API users;
 * 3.5-flash-lite is available and plenty for a one-shot structured
 * palette-assignment task.
 */
const BRAND_KIT_MODEL_ID = "gemini-3.5-flash-lite";

// ---------------------------------------------------------------------------
// LLM output schema — intent-level, semantic. The deterministic post-pass
// (expand-variations.ts) translates it into the full globals contract.
// ---------------------------------------------------------------------------

const FONT_LABELS = EMAIL_SAFE_FONT_OPTIONS.map((option) => option.label) as [
  string,
  ...string[],
];

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "6-digit hex color like #1a2b3c");

const semanticVariationSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(24)
    .describe('Short evocative theme name, e.g. "Midnight" or "Warm Sand".'),
  emailBackgroundColor: hexColor.describe(
    "Canvas color behind the email content — usually a tinted neutral distinct from the content background.",
  ),
  contentBackgroundColor: hexColor.describe(
    "Background of the content area text sits on — light for light themes, dark for dark themes.",
  ),
  accentColor: hexColor.describe(
    "The brand accent — used for buttons and links. Pick from the harvested palette.",
  ),
  headingTextColor: hexColor.describe("Heading text color; must read clearly on the content background."),
  paragraphTextColor: hexColor.describe("Body text color; must read clearly on the content background."),
});

const brandKitModelOutputSchema = z.object({
  brandName: z.string().min(1).max(60).describe("The brand/site name, cleaned (no taglines)."),
  headingFont: z
    .enum(FONT_LABELS)
    .describe("Email-safe font closest in feel to the site's heading font."),
  bodyFont: z.enum(FONT_LABELS).describe("Email-safe font closest in feel to the site's body font."),
  buttonShape: z
    .enum(Object.keys(BUTTON_SHAPE_RADII) as [ButtonShape, ...ButtonShape[]])
    .describe("Button corner style matching the site's UI."),
  logoUrl: z
    .string()
    .describe(
      'EXACTLY one of the provided logo candidate URLs (copied verbatim), or "" if none is clearly the brand logo.',
    ),
  variations: z
    .array(semanticVariationSchema)
    .min(3)
    .max(4)
    .describe("3-4 distinct theme variations. Include at least one light theme; a dark one if the palette supports it."),
});

// ---------------------------------------------------------------------------
// Final BrandKit validation — the wire contract, checked before returning.
// ---------------------------------------------------------------------------

/** `Required<GlobalStyles>` as a runtime schema (complete-payload invariant). */
const requiredGlobalsSchema = globalStylesSchema.required();

export const brandKitSchema = z.object({
  sourceUrl: z.string().optional(),
  name: z.string().min(1),
  fonts: z.object({ heading: z.string().min(1), body: z.string().min(1) }),
  logoUrl: z.string().optional(),
  variations: z
    .array(z.object({ id: z.string().min(1), name: z.string().min(1), globals: requiredGlobalsSchema }))
    .min(MIN_VARIATIONS)
    .max(4),
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function describeRankedColor({ color, count, variableName }: BrandSignals["rankedColors"][number]): string {
  const declaration = variableName === null ? "" : `, declared as "${variableName}"`;
  return `  - ${color} (used ${count}×${declaration})`;
}

function buildPrompt({ signals, sourceUrl }: { signals: BrandSignals; sourceUrl: string }): string {
  const paletteLines = signals.rankedColors.map(describeRankedColor).join("\n");
  const accentLines = signals.accentCandidates.map(describeRankedColor).join("\n");
  const logoLines = signals.logoCandidates
    .map(({ url, hint }) => `  - ${url} (${hint})`)
    .join("\n");
  return [
    `You are creating an email brand kit for the website ${sourceUrl}.`,
    `These signals were extracted directly from the site's HTML and CSS — they are the ONLY source of truth:`,
    ``,
    `Site name: ${signals.siteName ?? "(none found)"}`,
    `Page title: ${signals.pageTitle ?? "(none found)"}`,
    `Theme color meta tag: ${signals.themeColor ?? "(none found)"}`,
    `Font families seen on the site: ${signals.fontFamilies.length > 0 ? signals.fontFamilies.join(", ") : "(none found)"}`,
    `Color palette harvested from the site (ordered by usage, var() references included):`,
    paletteLines.length > 0 ? paletteLines : "  (only neutrals found)",
    `Signature accent candidates (the vibrant, high-saturation subset — brand accents are often used`,
    `sparingly, so low counts here do NOT mean unimportant; one declared as an "accent"/"brand"/"primary"`,
    `variable is almost certainly the brand's signature color):`,
    accentLines.length > 0 ? accentLines : "  (none found)",
    `Logo candidates (absolute URLs found on the page):`,
    logoLines.length > 0 ? logoLines : "  (none found)",
    ``,
    `Rules:`,
    `- Accent colors MUST come from the harvested palette above. Prefer the signature accent candidates; a generic library color (variables like "--toastify-…") is NOT the brand.`,
    `- Feature the leading signature accent prominently in at least one variation (as accentColor). Vivid accents like yellows and oranges read best against dark or deep-toned content backgrounds — pair them that way rather than washing them onto white.`,
    `- Backgrounds and text colors should be the harvested colors or plain neutrals (white, near-black, or a light/dark tint of a harvested color).`,
    `- Never invent a logo URL: copy one candidate verbatim, or return "".`,
    `- Aim for strong text contrast: dark text on light backgrounds, light text on dark backgrounds. Contrast is verified and repaired downstream, so favor faithful brand colors over timid ones.`,
    `- Each variation should feel distinct (e.g. a clean light theme, a tinted theme, a dark theme).`,
    `- Map the site's fonts to the CLOSEST email-safe option (web fonts don't ship in email): geometric/grotesque sans → Helvetica or Arial; humanist sans → Verdana, Tahoma or Trebuchet MS; serif → Georgia or Times New Roman; monospace → Courier New.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

const FRIENDLY_GENERATION_FAILURE =
  "We read the site but couldn't put a brand kit together from it. Please try again, or try a different page.";

function findFontStack(label: string): string {
  const option = EMAIL_SAFE_FONT_OPTIONS.find((candidate) => candidate.label === label);
  return option?.value ?? EMAIL_SAFE_FONT_OPTIONS[0].value;
}

/** Dedupe variation ids by suffixing ("-2", "-3") — ids must be kit-unique. */
function dedupeVariationIds(variations: BrandKit["variations"]): BrandKit["variations"] {
  const seen = new Map<string, number>();
  return variations.map((variation) => {
    const count = (seen.get(variation.id) ?? 0) + 1;
    seen.set(variation.id, count);
    return count === 1 ? variation : { ...variation, id: `${variation.id}-${count}` };
  });
}

/** Generate a brand kit from a website URL — the whole pipeline. */
export async function generateBrandKit({ url }: { url: string }): Promise<BrandKitGenerationResult> {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return {
      isOk: false,
      statusCode: 503,
      message: "Brand kit generation isn't configured on this server yet.",
    };
  }

  // 1. Fetch (guarded, honest failures).
  const page = await fetchPage(url);
  if (!page.isOk) {
    return { isOk: false, statusCode: 422, message: page.message };
  }

  // 2. Deterministic signal harvest (bounded stylesheet fetches, same guard).
  const signals = await harvestBrandSignals({
    html: page.html,
    finalUrl: page.finalUrl,
    fetchCss: (cssUrl) => fetchTextResource({ url: cssUrl }),
  });
  const hasAnySignal =
    signals.rankedColors.length > 0 || signals.themeColor !== null || signals.fontFamilies.length > 0;
  if (!hasAnySignal) {
    // Faithfulness: a page with no readable styling signals gets an honest
    // "couldn't do it", not an invented palette.
    return {
      isOk: false,
      statusCode: 422,
      message:
        "We could open that page but couldn't find enough brand colors or fonts on it to build a kit. Try the site's homepage.",
    };
  }

  // 3. ONE structured Gemini call — semantic assignments only.
  let modelOutput: z.infer<typeof brandKitModelOutputSchema>;
  try {
    const { object } = await generateObject({
      model: google(BRAND_KIT_MODEL_ID),
      schema: brandKitModelOutputSchema,
      prompt: buildPrompt({ signals, sourceUrl: page.finalUrl }),
      abortSignal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      // One retry only — the free-tier quota is small and a quota failure
      // would otherwise be retried into the ground.
      maxRetries: 1,
      providerOptions: {
        google: {
          // Minimal thinking: palette assignment doesn't need deliberation,
          // and default thinking pushed flash-lite past the latency budget.
          // (thinkingBudget: 0 is rejected by the 3.x models — use levels.)
          thinkingConfig: { thinkingLevel: "minimal" },
        },
      },
    });
    modelOutput = object;
  } catch (error) {
    console.error("[brand-kit] generation call failed:", error);
    return { isOk: false, statusCode: 502, message: FRIENDLY_GENERATION_FAILURE };
  }

  // 4. Deterministic expansion + contrast enforcement.
  const fonts: BrandKitFonts = {
    heading: findFontStack(modelOutput.headingFont),
    body: findFontStack(modelOutput.bodyFont),
  };
  const expandedVariations = modelOutput.variations
    .map((semantic) =>
      expandSemanticVariation({ semantic, fonts, buttonShape: modelOutput.buttonShape }),
    )
    .filter((variation) => variation !== null);
  if (expandedVariations.length < MIN_VARIATIONS) {
    return { isOk: false, statusCode: 502, message: FRIENDLY_GENERATION_FAILURE };
  }

  // Logo: only a verbatim harvested candidate survives (never invented).
  const candidateUrls = new Set(signals.logoCandidates.map((candidate) => candidate.url));
  const logoUrl = candidateUrls.has(modelOutput.logoUrl) ? modelOutput.logoUrl : undefined;

  const brandKit: BrandKit = {
    sourceUrl: page.finalUrl,
    name: modelOutput.brandName,
    fonts,
    ...(logoUrl === undefined ? {} : { logoUrl }),
    variations: dedupeVariationIds(expandedVariations),
  };

  // 5. Contract check — the exact shape the theme panel codes against.
  const parsed = brandKitSchema.safeParse(brandKit);
  if (!parsed.success) {
    console.error("[brand-kit] final kit failed contract validation:", parsed.error);
    return { isOk: false, statusCode: 502, message: FRIENDLY_GENERATION_FAILURE };
  }

  return { isOk: true, brandKit };
}
