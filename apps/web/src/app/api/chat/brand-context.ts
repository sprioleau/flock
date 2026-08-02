import { ConvexHttpClient } from "convex/browser";
import { api } from "@convex/_generated/api";
import { formatBrandVoiceContextLine } from "@/lib/brand-voice";

/**
 * Brand-kit context for the chat agent (item 26) — a compact, PER-REQUEST
 * block describing the session's brand social links (so "update the footer
 * links" turns into the brand's real profiles without the user pasting URLs)
 * and its tone of voice (so generated copy sounds like the brand).
 *
 * Caching contract: this is FRESH data and must only ever ride the fresh
 * per-request document-context layer (the LAST user message) — never the
 * static instruction prefix Gemini's implicit caching keys on.
 *
 * Fails soft: any error (Convex down, no session, no kit) returns null and
 * the turn proceeds without brand context.
 */

interface StoredSocialLink {
  platform: string;
  url: string;
}

/** Format the one-line fresh-context entry, or null when there is nothing. */
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

/** Load the session's kit and build the context block (null = nothing to add). */
export async function buildBrandContextBlock({
  sessionId,
}: {
  sessionId: string | null;
}): Promise<string | null> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (sessionId === null || convexUrl === undefined || convexUrl === "") {
    return null;
  }
  try {
    const convexClient = new ConvexHttpClient(convexUrl);
    const brandKit = await convexClient.query(api.brandKits.getActiveBrandKit, { sessionId });
    if (brandKit === null) {
      return null;
    }
    // Either half can be absent; a kit with only a voice still contributes.
    const lines = [
      formatBrandSocialContextLine({
        brandName: brandKit.name,
        socialLinks: brandKit.socialLinks ?? [],
      }),
      formatBrandVoiceContextLine({
        brandName: brandKit.name,
        toneOfVoice: brandKit.toneOfVoice,
      }),
    ].filter((line): line is string => line !== null);
    return lines.length === 0 ? null : lines.join("\n\n");
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
