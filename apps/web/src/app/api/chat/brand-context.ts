import { api } from "@convex/_generated/api";
import { formatBrandVoiceContextLine } from "@/lib/brand-voice";
import { formatBrandEmailDesignContextLine } from "@/lib/brand-email-design";
import { formatBrandImageStyleContextLine } from "@/lib/brand-image-style";
import { getLiveThemeVariations } from "@/lib/brand-kit";
import { fetchAuthQuery } from "@/lib/auth/auth-server";
import type {
  BrandGenerationAsset,
  BrandGenerationContext,
} from "@/lib/brand-generation-context";

/*
  Brand-kit context for the chat agent (item 26) — a compact, PER-REQUEST
  block describing the session's brand social links (so "update the footer
  links" turns into the brand's real profiles without the user pasting URLs)
  and its tone of voice (so generated copy sounds like the brand).

  Caching contract: this is FRESH data and must only ever ride the fresh
  per-request document-context layer (the LAST user message) — never the
  static instruction prefix Gemini's implicit caching keys on.

  Fails soft: any error (Convex down, no session, no kit) returns null and
  the turn proceeds without brand context.
*/

interface StoredSocialLink {
  platform: string;
  url: string;
}

export type { BrandGenerationContext } from "@/lib/brand-generation-context";

function safeContextText(text: string, maxLength: number): string {
  return text
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

interface BrandKitContextInput {
  name: string;
  sourceUrl?: string;
  fonts: { heading: string; body: string };
  colors?: BrandGenerationContext["colors"];
  imageStyleDoc?: BrandGenerationContext["imageStyleDoc"];
  sourceImages?: { url: string; alt?: string; width?: number; height?: number }[];
  logoUrl?: string;
  logoConfirmedAtMs?: number;
  socialImageUrl?: string;
  socialImageConfirmedAtMs?: number;
}

function toBrandGenerationContext(brandKit: BrandKitContextInput): BrandGenerationContext {
  const assets: BrandGenerationAsset[] = (brandKit.sourceImages ?? [])
    .filter((image) => image.url.startsWith("https://"))
    .slice(0, 5)
    .map((image, index) => ({
      name: safeContextText(image.alt ?? `Brand image ${index + 1}`, 80),
      kind: "scraped",
      url: image.url,
      ...(image.width === undefined ? {} : { width: image.width }),
      ...(image.height === undefined ? {} : { height: image.height }),
    }));
  if (brandKit.logoConfirmedAtMs !== undefined && typeof brandKit.logoUrl === "string") {
    assets.unshift({ name: "Brand logo", kind: "logo", url: brandKit.logoUrl });
  }
  if (
    brandKit.socialImageConfirmedAtMs !== undefined &&
    typeof brandKit.socialImageUrl === "string"
  ) {
    assets.push({ name: "Social card", kind: "social-card", url: brandKit.socialImageUrl });
  }
  return {
    brandName: safeContextText(brandKit.name, 80),
    ...(brandKit.sourceUrl === undefined ? {} : { sourceUrl: safeContextText(brandKit.sourceUrl, 300) }),
    fonts: {
      heading: safeContextText(brandKit.fonts.heading, 160),
      body: safeContextText(brandKit.fonts.body, 160),
    },
    colors: (brandKit.colors ?? []).slice(0, 8),
    ...(brandKit.imageStyleDoc === undefined ? {} : { imageStyleDoc: brandKit.imageStyleDoc }),
    assets: assets.slice(0, 8),
  };
}

function formatBrandIdentityContextLine({ context }: { context: BrandGenerationContext }): string {
  const identity = [
    `Brand identity for "${context.brandName}" (fresh data from the saved kit):`,
    context.sourceUrl === undefined ? "" : `Source: ${context.sourceUrl}`,
    `Fonts: heading=${context.fonts.heading}; body=${context.fonts.body}`,
    context.colors.length === 0
      ? ""
      : `Palette roles: ${context.colors.map((color) => `${safeContextText(color.name, 40)}=${color.hex} (${color.category})`).join(", ")}`,
  ].filter((line) => line.length > 0);
  return identity.join("\n");
}

function formatBrandAssetCatalogContextLine({
  assets,
}: {
  assets: BrandGenerationAsset[];
}): string | null {
  if (assets.length === 0) {
    return null;
  }
  return [
    "Compact durable brand-asset catalog (use exact URLs when selecting a named asset; do not invent or fetch alternatives):",
    ...assets.map((asset) => {
      const dimensions =
        asset.width !== undefined && asset.height !== undefined
          ? `${Math.round(asset.width)}x${Math.round(asset.height)}`
          : "unknown dimensions";
      return `- ${safeContextText(asset.name, 80)} | ${safeContextText(asset.kind, 40)} | ${dimensions} | ${asset.url}`;
    }),
  ].join("\n");
}

/*
  Format the one-line fresh-context entry, or null when there is nothing.
*/
export function formatBrandSocialContextLine({
  brandName,
  socialLinks,
}: {
  brandName: string;
  socialLinks: StoredSocialLink[];
}): string | null {
  if (socialLinks.length === 0) {
    return null;
  }
  const pairs = socialLinks.map(({ platform, url }) => `${platform}=${url}`).join(", ");
  return `Brand social links (from the user's saved brand kit "${brandName}" — use these exact URLs when adding or updating social/footer links): ${pairs}`;
}

/*
  Tell the agent whether a saved kit exists before it chooses a source-page
  style. Names are enough to identify saved themes; the actual globals remain
  browser-owned and are never copied into prompt text.
*/
export function formatBrandThemeContextLine({
  brandName,
  variations,
}: {
  brandName: string;
  variations: { name: string; deletedAtMs?: number }[];
}): string {
  const liveThemeNames = getLiveThemeVariations(variations).map((variation) => variation.name);
  const savedThemes =
    liveThemeNames.length === 0 ? "none" : liveThemeNames.join(", ");
  return `An active saved brand kit is bound to this canvas: "${brandName}". Its live saved email themes are: ${savedThemes}. For an ordinary new branded email, use the kit's selected/current variation by default. An explicit clean, unstyled, or "without the brand" request opts out. If a page read this turn also has a usable native theme, explicit source choices such as "use the blog post's style or design", "use the source page's style or design", "use the website's style or design", or "match the linked page" mean use the page style; explicit current-brand choices such as "use the current brand kit", "use the active brand style or design", "use our brand style/design", or "keep the current brand style" mean use this kit. A URL or "based on" alone is not a style choice.`;
}

export interface ResolvedBrandContext {
  block: string;
  generation: BrandGenerationContext;
}

/*
  Resolve the current canvas's kit first, then fall back to the caller's
  session kit only when no document identity is available.
*/
export async function resolveBrandContext({
  sessionId,
  documentId,
}: {
  sessionId: string | null;
  documentId?: string | null;
}): Promise<ResolvedBrandContext | null> {
  if (sessionId === null && (documentId === undefined || documentId === null)) {
    return null;
  }
  try {
    const document =
      documentId === undefined || documentId === null
        ? null
        : await fetchAuthQuery(api.documents.getDocumentByKey, { documentKey: documentId });
    const resolved =
      document !== null
        ? await fetchAuthQuery(api.brandKits.getBrandKitForCanvas, { canvasId: document.canvasId })
        : sessionId === null
          ? null
          : await fetchAuthQuery(api.brandKits.getActiveBrandKit, { sessionId });
    const brandKit = resolved === null ? null : "kit" in resolved ? resolved.kit : resolved;
    if (brandKit === null) {
      return null;
    }
    const generation = toBrandGenerationContext(brandKit as BrandKitContextInput);
    const lines = [
      formatBrandThemeContextLine({ brandName: generation.brandName, variations: brandKit.variations }),
      formatBrandIdentityContextLine({ context: generation }),
      formatBrandSocialContextLine({
        brandName: generation.brandName,
        socialLinks: brandKit.socialLinks ?? [],
      }),
      formatBrandVoiceContextLine({
        brandName: generation.brandName,
        toneOfVoice: brandKit.toneOfVoice,
      }),
      formatBrandEmailDesignContextLine({
        brandName: generation.brandName,
        emailDesignDoc: brandKit.emailDesignDoc,
      }),
      formatBrandImageStyleContextLine({
        brandName: generation.brandName,
        imageStyleDoc: generation.imageStyleDoc,
      }),
      formatBrandAssetCatalogContextLine({ assets: generation.assets }),
    ].filter((line): line is string => line !== null);
    return { block: lines.join("\n\n"), generation };
  } catch (error) {
    console.error(
      JSON.stringify({
        tag: "flock.chat.brandContextFailed",
        message: error instanceof Error ? error.message.slice(0, 300) : String(error),
      }),
    );
    return null;
  }
}

/*
  Compatibility wrapper for callers that only need the fresh prompt block.
*/
export async function buildBrandContextBlock({
  sessionId,
  documentId = null,
}: {
  sessionId: string | null;
  documentId?: string | null;
}): Promise<string | null> {
  return (await resolveBrandContext({ sessionId, documentId }))?.block ?? null;
}
