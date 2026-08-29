import type { NamedTheme, PageTheme } from "@flock/email-sdk";
import { getLiveThemeVariations, type BrandKit } from "@/lib/brand-kit";
import type { FlockChatMessage } from "@/lib/chat-contract";

/*
  WHAT A THEME REFERENCE IS ALLOWED TO RESOLVE TO.

  The SDK's resolver (actions/theme-target.ts) is pure: it picks one element
  out of lists a caller hands it, and refuses anything else. This module builds
  those lists, and what it LEAVES OUT is the load-bearing half.

  - A soft-deleted variation is not a candidate. `getLiveThemeVariations` is
    the one filter every theme surface goes through, for a reason worth
    restating here: a draft wearing a theme its kit no longer offers matches no
    variation, links to no parent, and reads as detached forever. Offering one
    to the agent would manufacture exactly the stranded state soft deletion
    exists to prevent — and it would do it in a draft the user is not looking
    at, which is the one place nobody would notice.
  - Only a page read in the CURRENT TURN counts. Same rule, and the same
    reasoning, as lib/ingested-source.ts: a page fetched three turns ago is not
    evidence that this request is about it, and silently theming today's draft
    with last week's site is the kind of wrong that looks deliberate.
  - A page that could not be read contributes nothing. The ingestion tool
    reports a paywalled or blocked page as a SUCCESSFUL result carrying
    `isOk: false`; nothing was read, so there is no theme, and the resolver's
    refusal ("nothing was read from a web page this turn") is the truth.

  The transcript is the only place the page theme exists — it arrives as a tool
  result and is never written to a document — which is why this reads messages
  rather than state.
*/

type MessagePart = FlockChatMessage["parts"][number];

/**
 * The page theme carried by ONE transcript part, or null when that part is not
 * a fulfilled ingestion result or the page declared nothing worth applying.
 *
 * Narrowing on the part type is what makes `output` typed here — this reads
 * the real result shape rather than casting to it, so a change to the
 * ingestion payload breaks the build instead of silently returning null.
 */
function readPartPageTheme(part: MessagePart): PageTheme | null {
  if (part.type !== "tool-readWebPage" || part.state !== "output-available") {
    return null;
  }
  const { output } = part;
  if (!output.isFound || !output.data.isOk) {
    return null;
  }
  const { page } = output.data;
  if (page.theme === undefined) {
    return null;
  }
  return {
    globals: page.theme.globals,
    source: page.theme.source,
    /*
      The canonical URL, because that is what the reply will name and what the
      user can check. The requested URL and the canonical one differ often
      enough (trailing slash, tracking params, a redirect) that quoting the
      request back would be quoting something the page does not call itself.
    */
    url: page.canonicalUrl,
  };
}

/**
 * The theme read off a page in the CURRENT turn, or null.
 *
 * The LAST one wins when a turn read several pages: the model's reference is
 * "page", and after two fetches the page it means is the one it just read.
 */
export function readTurnPageTheme({
  messages,
}: {
  messages: FlockChatMessage[];
}): PageTheme | null {
  const turnStartIndex = messages.findLastIndex((message) => message.role === "user");
  const turnMessages = turnStartIndex === -1 ? messages : messages.slice(turnStartIndex);
  let latest: PageTheme | null = null;
  for (const message of turnMessages) {
    for (const part of message.parts) {
      const pageTheme = readPartPageTheme(part);
      if (pageTheme !== null) {
        latest = pageTheme;
      }
    }
  }
  return latest;
}

/**
 * The themes a reference may name on this canvas: the bound kit's LIVE
 * variations, and nothing else. Never a generated theme — a theme invented for
 * one draft belongs to no kit, matches nothing, and appends nothing, which is
 * the same argument `pickVariationTheme` makes for the drafts menu.
 */
export function readCanvasThemeCandidates(brandKit: BrandKit): NamedTheme[] {
  return getLiveThemeVariations(brandKit.variations).map((variation) => ({
    id: variation.id,
    name: variation.name,
    globals: variation.globals,
  }));
}
