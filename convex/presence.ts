import { Presence } from "@convex-dev/presence";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";

/**
 * Phase 6.2a — presence foundation (who is in the document).
 *
 * One presence ROOM per document: `roomId` is the Convex document id string
 * (NOT per block — see .claude/skills/presence/SKILL.md, "Rooms" note).
 * `userId` is the Flock anonymous session id (the same id used as authorId
 * for ops), or the fixed {@link AGENT_PRESENCE_USER_ID} for the AI agent.
 *
 * Authorization mirrors the rest of the no-auth capability model
 * (prosemirror.ts checkWrite): holding a live document id IS the capability,
 * so heartbeat/updateRoomUser are existence-gated on the document row.
 * `disconnect` stays unauthenticated by design — it is fired from
 * `navigator.sendBeacon` on tab close, where no context is available; the
 * opaque sessionToken it takes is itself the proof of ownership.
 *
 * Per-user room `data` carries the PresenceData payload defined by the client
 * contract in apps/web/src/lib/presence.tsx (name, color, isAgent,
 * editingBlockId, selection). MERGE-NOTIFY conflict model: presence only ever
 * SHOWS who is where; nothing here locks or blocks edits.
 */

export const presence = new Presence(components.presence);

/*
  Resolve a roomId string to a live document id; throw otherwise.
*/
async function assertRoomIsLiveDocument(
  ctx: MutationCtx,
  roomId: string,
): Promise<Id<"documents">> {
  const documentId = ctx.db.normalizeId("documents", roomId);
  if (documentId === null) {
    throw new Error(`Presence access denied: malformed room id ${roomId}.`);
  }
  const document = await ctx.db.get(documentId);
  if (document === null) {
    throw new Error(`Presence access denied: document ${roomId} does not exist.`);
  }
  return documentId;
}

export const heartbeat = mutation({
  args: {
    roomId: v.string(),
    userId: v.string(),
    sessionId: v.string(),
    interval: v.number(),
  },
  returns: v.object({ roomToken: v.string(), sessionToken: v.string() }),
  handler: async (ctx, { roomId, userId, sessionId, interval }) => {
    await assertRoomIsLiveDocument(ctx, roomId);
    return await presence.heartbeat(ctx, roomId, userId, sessionId, interval);
  },
});

export const list = query({
  args: { roomToken: v.string() },
  returns: v.array(
    v.object({
      userId: v.string(),
      online: v.boolean(),
      lastDisconnected: v.number(),
      /*
        PresenceData payload (client contract in apps/web/src/lib/presence.tsx).
      */
      data: v.optional(v.any()),
    }),
  ),
  handler: async (ctx, { roomToken }) => {
    /*
      No per-user reads here, so every room member shares one cached query.
    */
    return await presence.list(ctx, roomToken);
  },
});

export const disconnect = mutation({
  args: { sessionToken: v.string() },
  returns: v.null(),
  handler: async (ctx, { sessionToken }) => {
    /*
      Unauthenticated on purpose: called via navigator.sendBeacon (see above).
    */
    return await presence.disconnect(ctx, sessionToken);
  },
});

export const updateRoomUser = mutation({
  args: { roomId: v.string(), userId: v.string(), data: v.any() },
  returns: v.null(),
  handler: async (ctx, { roomId, userId, data }) => {
    await assertRoomIsLiveDocument(ctx, roomId);
    return await presence.updateRoomUser(ctx, roomId, userId, data);
  },
});

/*
  ---------------------------------------------------------------------------
  Agent presence (the "agent is editing…" indicator)
  ---------------------------------------------------------------------------
*/

/*
  The agent's fixed presence userId — a first-class roster member.
*/
export const AGENT_PRESENCE_USER_ID = "agent";
/*
  The agent's avatar/border color (violet — distinct from the human hue wheel).
*/
const AGENT_PRESENCE_COLOR = "#8b5cf6";
/*
  Agent heartbeat interval: the component marks a user offline 2.5× the
  interval after its last heartbeat, so the agent avatar lingers ~12s after
  its last edit and then drops off the facepile naturally — no explicit
  disconnect needed.
*/
const AGENT_HEARTBEAT_INTERVAL_MS = 5000;
/*
  How long the block-level "agent is editing…" pulse stays lit.
*/
const AGENT_EDIT_INDICATOR_MS = 2000;

/**
 * Mark the agent present and editing `blockId`, called from the agent's
 * text-edit mutation (convex/agentText.ts). Two component facts drive the
 * shape of this helper (verified against @convex-dev/presence@0.4.0 source):
 *
 *  1. `updateRoomUser` does NOT create a presence row — it warns and drops
 *     the data when the user has never heartbeat — so the agent heartbeats
 *     first (sessionId `agent:<documentId>`, stable per document, so repeat
 *     edits bump one session's deadline instead of piling up sessions).
 *  2. A set-then-clear inside one mutation would never render (subscribers
 *     only see committed state), so the clear runs as a SCHEDULED follow-up
 *     mutation {@link clearAgentEditing} ~2s later, making the indicator
 *     pulse visibly.
 */
export async function markAgentEditing({
  ctx,
  documentId,
  blockId,
}: {
  ctx: MutationCtx;
  documentId: Id<"documents">;
  blockId: string;
}): Promise<void> {
  const document = await ctx.db.get(documentId);
  if (document === null) {
    return;
  }
  const roomId = documentId as string;
  const { roomToken } = await presence.heartbeat(
    ctx,
    roomId,
    AGENT_PRESENCE_USER_ID,
    `agent:${roomId}`,
    AGENT_HEARTBEAT_INTERVAL_MS,
  );
  const data = {
    name: document.agentName ?? "Agent",
    color: AGENT_PRESENCE_COLOR,
    isAgent: true,
    editingBlockId: blockId,
  };
  await presence.updateRoomUser(ctx, roomId, AGENT_PRESENCE_USER_ID, data);
  await ctx.scheduler.runAfter(AGENT_EDIT_INDICATOR_MS, internal.presence.clearAgentEditing, {
    roomId,
    roomToken,
    blockId,
  });
}

/**
 * Scheduled follow-up to {@link markAgentEditing}: drop `editingBlockId` from
 * the agent's payload — but only if it still points at the block this clear
 * was scheduled for, so a newer agent edit's indicator on another block is
 * never wiped early by an older edit's timer.
 */
export const clearAgentEditing = internalMutation({
  args: { roomId: v.string(), roomToken: v.string(), blockId: v.string() },
  returns: v.null(),
  handler: async (ctx, { roomId, roomToken, blockId }) => {
    const roster = await presence.list(ctx, roomToken);
    const agentEntry = roster.find((entry) => entry.userId === AGENT_PRESENCE_USER_ID);
    if (agentEntry === undefined) {
      return null;
    }
    const data = agentEntry.data as { editingBlockId?: string } | undefined;
    if (data === undefined || data.editingBlockId !== blockId) {
      return null;
    }
    const { editingBlockId: _cleared, ...rest } = data;
    await presence.updateRoomUser(ctx, roomId, AGENT_PRESENCE_USER_ID, rest);
    return null;
  },
});
