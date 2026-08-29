import { describe, expect, it } from "vitest";
import { resolveGlobalStyles } from "@flock/email-sdk";
import type { BrandKit } from "@/lib/brand-kit";
import type { FlockChatMessage } from "@/lib/chat-contract";
import { readCanvasThemeCandidates, readTurnPageTheme } from "./theme-candidates";

/*
  WHAT A THEME REFERENCE MAY RESOLVE TO — the two lists, and what is kept OUT
  of them.

  The SDK resolver can only ever answer with something in the list it was
  handed, so these two functions ARE the offer. Every test here is about an
  exclusion, because an over-generous list is the failure mode: a soft-deleted
  theme that can still be named strands a draft, and a page read three turns
  ago silently restyles today's work in last week's colours.
*/

/*
  A COMPLETE payload, because that is what the ingestion pipeline emits and
  what `applyTheme` needs — it replaces the document's globals wholesale, so a
  partial one would silently revert every key it left out.
*/
const PAGE_GLOBALS = resolveGlobalStyles({
  emailBackgroundColor: "#ffffff",
  buttonBackgroundColor: "#ffc600",
});

function userMessage(text: string): FlockChatMessage {
  return { id: `user_${text.length}`, role: "user", parts: [{ type: "text", text }] };
}

/** One assistant turn carrying a readWebPage result, with or without a theme. */
function assistantWithPage({
  id,
  url,
  isOk = true,
  theme,
}: {
  id: string;
  url: string;
  isOk?: boolean;
  theme?: { globals: typeof PAGE_GLOBALS; source: string };
}): FlockChatMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-readWebPage",
        toolCallId: `call_${id}`,
        state: "output-available",
        input: { url },
        output: isOk
          ? {
              isFound: true,
              data: {
                isOk: true,
                page: {
                  title: "About",
                  sourceName: "wesbos.com",
                  canonicalUrl: url,
                  blocks: [],
                  lists: [],
                  structuredData: [],
                  images: [],
                  sections: [],
                  isTruncated: false,
                  pageType: "portfolio" as const,
                  confidence: "high" as const,
                  sourceSummary: "A personal site.",
                  isPlanUsable: true,
                  ...(theme === undefined ? {} : { theme }),
                },
              },
            }
          : {
              isFound: true,
              data: { isOk: false, reason: "paywalled", message: "That page is paywalled." },
            },
      },
    ],
  };
}

describe("readTurnPageTheme", () => {
  it("carries the page's globals, its source sentence, and its CANONICAL url", () => {
    const messages = [
      userMessage("make a draft from wesbos.com/about"),
      assistantWithPage({
        id: "a1",
        url: "https://wesbos.com/about",
        theme: { globals: PAGE_GLOBALS, source: "accent #ffc600 (--ui-accent-1)" },
      }),
    ];
    expect(readTurnPageTheme({ messages })).toEqual({
      globals: PAGE_GLOBALS,
      source: "accent #ffc600 (--ui-accent-1)",
      url: "https://wesbos.com/about",
    });
  });

  /*
    An unstyled page is the NORMAL outcome, and it means the draft keeps the
    theme it has. Returning something here — the defaults, an empty object —
    would make `theme: "page"` silently strip a draft.
  */
  it("is null when the page declared nothing worth applying", () => {
    const messages = [
      userMessage("read it"),
      assistantWithPage({ id: "a1", url: "https://example.com" }),
    ];
    expect(readTurnPageTheme({ messages })).toBeNull();
  });

  it("is null when the page could not be read at all", () => {
    const messages = [
      userMessage("read it"),
      assistantWithPage({
        id: "a1",
        url: "https://paywalled.example",
        isOk: false,
        theme: { globals: PAGE_GLOBALS, source: "accent #ffc600" },
      }),
    ];
    expect(readTurnPageTheme({ messages })).toBeNull();
  });

  /*
    THE TURN SCOPE, the same rule lib/ingested-source.ts holds. A page read
    before the user's latest message is not what "the page" means now, and
    theming today's draft in last week's colours is the kind of wrong that
    looks deliberate.
  */
  it("ignores a page read in an EARLIER turn", () => {
    const messages = [
      userMessage("read wesbos.com"),
      assistantWithPage({
        id: "a1",
        url: "https://wesbos.com/about",
        theme: { globals: PAGE_GLOBALS, source: "accent #ffc600" },
      }),
      userMessage("now make me another version of this draft"),
    ];
    expect(readTurnPageTheme({ messages })).toBeNull();
  });

  /* Two fetches in one turn: "page" means the one it just read. */
  it("takes the LAST page when a turn read several", () => {
    const messages = [
      userMessage("compare these two sites"),
      assistantWithPage({
        id: "a1",
        url: "https://first.example",
        theme: {
          globals: resolveGlobalStyles({ emailBackgroundColor: "#111111" }),
          source: "first",
        },
      }),
      assistantWithPage({
        id: "a2",
        url: "https://second.example",
        theme: { globals: PAGE_GLOBALS, source: "second" },
      }),
    ];
    expect(readTurnPageTheme({ messages })?.url).toBe("https://second.example");
  });
});

describe("readCanvasThemeCandidates", () => {
  const kit = (variations: BrandKit["variations"]): BrandKit =>
    ({ name: "Acme", variations }) as BrandKit;

  const MIDNIGHT = {
    id: "midnight",
    name: "Midnight",
    globals: { emailBackgroundColor: "#101014" },
  };
  const SAND = { id: "warm-sand", name: "Warm Sand", globals: { emailBackgroundColor: "#f5efe6" } };

  it("offers each live variation under its id, its name, and its own globals", () => {
    expect(readCanvasThemeCandidates(kit([MIDNIGHT, SAND] as BrandKit["variations"]))).toEqual([
      { id: "midnight", name: "Midnight", globals: { emailBackgroundColor: "#101014" } },
      { id: "warm-sand", name: "Warm Sand", globals: { emailBackgroundColor: "#f5efe6" } },
    ]);
  });

  /*
    THE SOFT-DELETION FILTER, and the reason it belongs here rather than at the
    resolver: a deleted theme that can still be NAMED is a draft that ends up
    wearing a theme its kit no longer has — matching no variation, linking to
    no parent, permanently detached. That is precisely the stranded state
    §14.5b's soft deletion exists to prevent, and it would happen in a draft
    the user is not looking at.
  */
  it("never offers a soft-deleted theme", () => {
    const candidates = readCanvasThemeCandidates(
      kit([{ ...MIDNIGHT, deletedAtMs: 1_700_000_000_000 }, SAND] as BrandKit["variations"]),
    );
    expect(candidates.map((theme) => theme.id)).toEqual(["warm-sand"]);
  });

  it("offers nothing at all when every theme has been deleted", () => {
    expect(
      readCanvasThemeCandidates(
        kit([{ ...MIDNIGHT, deletedAtMs: 1 }, { ...SAND, deletedAtMs: 2 }] as BrandKit["variations"]),
      ),
    ).toEqual([]);
  });
});
