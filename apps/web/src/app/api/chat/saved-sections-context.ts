import { ConvexHttpClient } from "convex/browser";
import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";

/**
 * Saved-sections context for the chat agent (owner V2 item 3): the user's
 * own saved sections join the model's selection space alongside the built-in
 * section catalog — "generate an email" pulls from BOTH. One compact line
 * per row: the `saved:<rowId>` templateId (scaffoldSection's saved branch),
 * the user's name for it, the LLM-authored useWhen/description when the
 * async enrichment has landed, and the usage stat.
 *
 * Caching contract (same as brand-context.ts): saved sections are user data
 * that changes between requests, so this block rides ONLY the fresh
 * per-request document-context layer — never the static prefix Gemini's
 * implicit caching keys on. The usage-stat wording makes the count a
 * TIEBREAKER only: content fit always dominates.
 *
 * Fails soft: any error (Convex down, no session, no rows) returns null and
 * the turn proceeds with the catalog only.
 */

type SavedSectionRow = Pick<
  Doc<"savedSections">,
  "_id" | "name" | "blockCount" | "useWhen" | "description" | "useCount"
>;

/** Format the fresh-context block, or null when the session has no rows. */
export function formatSavedSectionsContext(rows: SavedSectionRow[]): string | null {
  if (rows.length === 0) {
    return null;
  }
  const lines = rows.map((row) => {
    const guidance =
      row.useWhen ?? row.description ?? `${row.blockCount} blocks, saved by the user.`;
    const usageSuffix =
      row.useCount !== undefined && row.useCount > 0 ? ` (used ${row.useCount}×)` : "";
    return `- saved:${row._id} — "${row.name}": ${guidance}${usageSuffix}`;
  });
  return [
    "## Saved sections (the user's own reusable sections)",
    "Insert one with scaffoldSection using its EXACT id below as the templateId (omit params — a saved section carries its own content). These are the user's real, already-personalized sections: when one fits the request (matching purpose, placement, or the user naming it), prefer it over composing an equivalent from the catalog. Prefer frequently-used saved sections only when options are otherwise equivalent — usage counts are a tiebreaker, never a substitute for content fit.",
    ...lines,
  ].join("\n");
}

/** Load the session's saved sections and build the context block (null = none). */
export async function buildSavedSectionsContext({
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
    const rows = await convexClient.query(api.savedSections.listForSession, { sessionId });
    return formatSavedSectionsContext(rows);
  } catch (error) {
    console.error(
      JSON.stringify({
        tag: "tandem.chat.savedSectionsContextFailed",
        message: error instanceof Error ? error.message.slice(0, 300) : String(error),
      }),
    );
    return null;
  }
}
