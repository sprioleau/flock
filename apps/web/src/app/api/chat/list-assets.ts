import type { AssetSummary, ListAssetsResult } from "@flock/agent";
import { api } from "@convex/_generated/api";
import { fetchAuthQuery } from "@/lib/auth/auth-server";

/*
  listAssets host executor — the session-scoped Convex query the agent
  package cannot perform itself (see packages/agent/src/widget-actions.ts).
  Newest-first, capped: the model gets enough to answer "what images do I
  have?" and to reuse an asset URL as an image src; the chat table widget
  renders an even smaller slice (CHAT_TABLE_MAX_ROWS).

  Goes through fetchAuthQuery, NOT a bare ConvexHttpClient: `assets` is keyed
  by resolveOwnerId (convex/authIdentity.ts), so once identity exists this
  route must present the caller's token or it would read a different library
  than the browser writes to. With auth off there is no token and Convex falls
  back to the `sessionId` argument — today's behaviour, unchanged.
*/

/*
  Cap on assets returned to the MODEL (the table part caps separately).
*/
export const MAX_ASSETS_FOR_MODEL = 30;

export type ListSessionAssetsOutcome =
  | { isOk: true; result: ListAssetsResult }
  | { isOk: false; message: string };

export async function listSessionAssets({
  sessionId,
}: {
  sessionId: string | null;
}): Promise<ListSessionAssetsOutcome> {
  if (sessionId === null) {
    /*
      No session yet — an empty library, not an error.
    */
    return { isOk: true, result: { assets: [], totalCount: 0 } };
  }
  try {
    const rows = await fetchAuthQuery(api.assets.listForSession, { sessionId });
    const assets: AssetSummary[] = rows.slice(0, MAX_ASSETS_FOR_MODEL).map((row) => ({
      name: row.name,
      kind: row.kind,
      url: row.url,
      createdAtMs: row.createdAtMs,
      ...(row.sizeBytes === undefined ? {} : { sizeBytes: row.sizeBytes }),
    }));
    return { isOk: true, result: { assets, totalCount: rows.length } };
  } catch (error) {
    console.error(
      JSON.stringify({
        tag: "flock.chat.listAssetsFailed",
        message: error instanceof Error ? error.message.slice(0, 300) : String(error),
      }),
    );
    return { isOk: false, message: "The asset library couldn't be read right now." };
  }
}

/*
  "generated" → "AI generated" etc. — user-facing kind words for the table.
*/
export const ASSET_KIND_LABELS: Readonly<Record<AssetSummary["kind"], string>> = {
  uploaded: "Uploaded",
  generated: "AI generated",
  logo: "Logo",
  "social-card": "Social card",
};
