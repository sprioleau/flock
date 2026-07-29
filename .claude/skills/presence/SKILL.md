---
name: convex-dev-presence
description: Add real-time presence (who's online, avatars/facepiles, typing and activity indicators, custom per-user room data such as cursor/selection state) to a Convex app. Use this skill whenever working with the Convex Presence component or Tandem Phase 6.2 presence features.
version: 0.4.0
---

> Agents: read this skill fully before writing code that uses the Presence component. Follow the installation and configuration steps exactly, and read the Tandem-specific notes at the end before designing anything for Phase 6.2.

# Presence

## Instructions

This component tracks which users are currently active in a "room" (any string-keyed unit of presence — for Tandem, a document). It manages heartbeats, session lifecycles, graceful and timed-out disconnects, and stale-state cleanup for you. Each `(roomId, userId)` presence entry can also carry an arbitrary `data` payload (`v.any()`), which is how you attach custom state like display names, typing flags, "agent is editing…" status, or serialized cursor/selection positions.

What it does NOT do: it does not render cursors, map editor positions, or provide any editor integration. It is a membership-plus-data transport; cursor/selection UI is built on top of it (see the Tandem notes below).

### Installation

```bash
npm install @convex-dev/presence
```

Current npm version: `@convex-dev/presence@0.4.0`

Register the component in `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import presence from "@convex-dev/presence/convex.config.js";

const app = defineApp();
app.use(presence); // alongside app.use(prosemirrorSync) etc.
export default app;
```

Then expose the API from your own `convex/presence.ts` (the hook expects functions named `heartbeat`, `list`, and `disconnect` on the API object you pass it):

```ts
import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";
import { Presence } from "@convex-dev/presence";

export const presence = new Presence(components.presence);

export const heartbeat = mutation({
  args: {
    roomId: v.string(),
    userId: v.string(),
    sessionId: v.string(),
    interval: v.number(),
  },
  handler: async (ctx, { roomId, userId, sessionId, interval }) => {
    // Add authorization checks here (Tandem: capability check on the doc).
    return await presence.heartbeat(ctx, roomId, userId, sessionId, interval);
  },
});

export const list = query({
  args: { roomToken: v.string() },
  handler: async (ctx, { roomToken }) => {
    // Avoid adding per-user reads so all subscribers share the same cache.
    return await presence.list(ctx, roomToken);
  },
});

export const disconnect = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    // Can't check auth here: it's called over HTTP from navigator.sendBeacon.
    return await presence.disconnect(ctx, sessionToken);
  },
});

// Optional: expose custom per-user room data (typing, cursor, agent status).
export const updateRoomUser = mutation({
  args: { roomId: v.string(), userId: v.string(), data: v.any() },
  handler: async (ctx, { roomId, userId, data }) => {
    // Add authorization checks here.
    return await presence.updateRoomUser(ctx, roomId, userId, data);
  },
});
```

On the frontend:

```tsx
import usePresence from "@convex-dev/presence/react";
import FacePile from "@convex-dev/presence/facepile"; // optional prebuilt avatar row

const presenceState = usePresence(api.presence, roomId, userId);
// PresenceState[]: { userId, online, lastDisconnected, data?, name?, image? }
// Sorted with the current user first. `undefined` while loading.

<FacePile presenceState={presenceState ?? []} />;
```

`usePresence(presenceApi, roomId, userId, interval = 10000, convexUrl?)` handles the whole session lifecycle: periodic heartbeats (single-flighted), graceful disconnect via `navigator.sendBeacon` on `beforeunload`, disconnect/reconnect on tab `visibilitychange`, and React Strict Mode remount races. React Native has a dedicated entrypoint: `@convex-dev/presence/react-native` (requires `expo-crypto`).

## API surface (server `Presence` class)

Core (safe to expose behind auth checks):

- `heartbeat(ctx, roomId, userId, sessionId, interval)` → `{ roomToken, sessionToken }` — registers/keeps a session alive. A session disconnects if no heartbeat arrives within 2.5× `interval`, or immediately on graceful disconnect.
- `list(ctx, roomToken, limit = 104)` → `Array<{ userId, online, lastDisconnected, data? }>` — presence for a room, keyed by an opaque room token so every member subscribes to one shared cached query.
- `updateRoomUser(ctx, roomId, userId, data?)` — sets the arbitrary `data` payload on a `(roomId, userId)` presence entry. This is the extension point for typing indicators, cursors, and agent status.
- `disconnect(ctx, sessionToken)` — graceful disconnect of one session.

Maintenance helpers (no built-in auth — do not expose directly to end users):

- `listRoom(ctx, roomId, onlineOnly?, limit?)` — all users in a room by raw room id.
- `listUser(ctx, userId, onlineOnly?, limit?)` — all rooms a user is in (online-status lookup).
- `removeRoomUser(ctx, roomId, userId)` / `removeRoom(ctx, roomId)` — cleanup.

Component tables (inside the component, for reference): `presence` (`roomId`, `userId`, `online`, `lastDisconnected`, `data?: v.any()`), `sessions` (per browser tab, with a disconnect `deadline`), plus `roomTokens`/`sessionTokens`.

## Use cases

- **Showing who's viewing/editing a document** — avatar facepiles, online/offline dots, "last seen" from `lastDisconnected`
- **Typing and activity indicators** — write `{ isTyping: true }` (or `{ status: "agent-editing" }`) into the `data` payload via `updateRoomUser`
- **Carrying custom collaborative state per user per room** — the `data` payload is schemaless (`v.any()`), so it can hold cursor coordinates, serialized editor selections, or focused-element ids; you own the rendering
- **Server-side/agent presence** — `heartbeat` is just a mutation, so a backend agent can appear in the room too (call it from the agent loop or a scheduled keepalive)
- **Multi-room presence** — one user can hold presence in many rooms; `listUser` answers "is this user online anywhere"

## How it works

Each `usePresence` hook instance creates a unique session (one per tab/component) and sends heartbeat mutations every `interval` ms (default 10s). The server tracks sessions with deadlines; as of 0.4.0 a single deployment-wide batch worker (not one scheduled function per session) sleeps until the earliest deadline and marks timed-out sessions offline — the system is idle when users are idle, and it scales without scheduler spam. A user is `online` while any of their sessions is live.

`heartbeat` returns opaque tokens: a `roomToken` shared by all members (so the reactive `list(roomToken)` query is computed once per room and cache-shared across every subscriber — cost grows linearly, not quadratically, with room size) and a `sessionToken` used for graceful disconnects, including the `sendBeacon` call on tab close (which is why the `disconnect` mutation cannot require auth).

Membership changes (join/leave/online-flip) invalidate the shared `list` query and push to all subscribers; steady-state heartbeats do not. Calling `updateRoomUser` writes the `data` field on the presence row, which also invalidates the room's `list` query — every `data` update fans out the room's full presence list to all subscribers. That is exactly what you want for typing/cursor broadcast, but it means you should throttle/single-flight high-frequency `data` writes client-side (~100–500 ms; Convex's own multiplayer-cursors example targets roughly 1 mutation/sec per active client) rather than writing on every mousemove or keystroke.

`data` is per `(roomId, userId)`, not per session: two tabs of the same user share one payload (last write wins). Auth is your responsibility — the component takes `userId` as a plain string, so wrap `heartbeat`/`updateRoomUser` with your own checks.

## When NOT to use

- When you need rendered live cursors "for free" — this component transports presence state; cursor/selection rendering (e.g. ProseMirror decorations) is app code you write on top
- For high-frequency ephemeral state where even throttled database writes are too costly (massive rooms, 60fps cursor trails) — consider a dedicated in-memory/sub-database channel; at Tandem's collaboration scale (a few humans + one agent per document) the `data` payload is fine
- When room membership is derivable from data you already store (e.g. "participants who ever edited") — presence is for *live* state only
- If you are not using Convex as your backend

## Resources

- [npm package](https://www.npmjs.com/package/@convex-dev/presence)
- [GitHub repository](https://github.com/get-convex/presence) — see `example/` (anonymous users, `updateRoomUser` typing indicator) and `example-with-auth/` (enriching `list` results with `name`/`image`; live at https://presence.previews.convex.dev)
- [Convex Components Directory](https://www.convex.dev/components/presence)
- [Stack: Implementing Presence with Convex](https://stack.convex.dev/presence-with-convex) — design rationale (rooms, single-flighting, shared-cache costs)
- [get-convex/multiplayer-cursors](https://github.com/get-convex/multiplayer-cursors) — official example app for smooth cursor sharing (hand-rolled tables, position batching); a pattern reference, not a reusable component

---

## Tandem-specific notes (Phase 6.2)

### Identity: no auth, session ids

Tandem is no-auth: identity is an anonymous per-browser id from `getOrCreateSessionId()` in `apps/web/src/lib/session.ts` (localStorage key `tandem_session_id`), and document access is a capability `?doc=` URL. Therefore:

- `userId` for presence = the Tandem session id (the same id already used as `authorId` for ops and for document listing). Do not confuse it with the component's `sessionId` parameter — that one is per-tab and generated internally by `usePresence`.
- Auth checks in the `heartbeat`/`updateRoomUser` wrappers = the same capability check the other document mutations use (holding the doc id is the capability). `disconnect` stays unauthenticated by design (sendBeacon).
- Display names/avatars: there are no accounts, so derive a stable display name + color from the session id (or a user-chosen name stored in localStorage) and put them in the `data` payload — the pattern `example-with-auth` uses server-side enrichment for, we do client-side.
- The AI agent participates as a first-class presence user: `userId` = the agent's identity (documents already carry an `agentName` field), with `data.isAgent: true`. The agent's server loop calls `heartbeat` and `updateRoomUser` directly (they're plain mutations) — e.g. `data: { isAgent: true, editingBlockId: "..." }` while a tool call is mutating a block, cleared when done. That single mechanism covers the "agent is editing…" indicator.

### Rooms: one room per document, NOT per block

The editor (Phase 5, in progress) syncs one ProseMirror doc per text block via `@convex-dev/prosemirror-sync` (`convex/prosemirror.ts`, spike at `apps/web/src/app/spike/sync/page.tsx`). Do **not** mirror that granularity in presence: one `usePresence` room per block would mean one heartbeat loop and one session per block per tab. Use `roomId = documentId` (one room per studio document) and put per-block detail inside the `data` payload.

### Live cursors/selections: the verified answer (2026-07)

- `@convex-dev/prosemirror-sync@0.2.5` (current) still explicitly lists "Syncing presence (e.g. showing other users' names and cursor in the UI)" under *missing features that aren't currently planned* in its README. The spike-doc conclusion ("needs Convex presence component + ProseMirror decorations, hand-rolled") remains accurate.
- `@convex-dev/presence` does **not** render cursors, but its `data` payload is the officially suggested transport for cursor/selection state. There is no other official Convex component that provides live cursors; `get-convex/multiplayer-cursors` is an example app, not a component.

### Recommended Phase 6.2 architecture

Broadcast selection state through the presence `data` payload, render with ProseMirror decorations:

```ts
// data payload shape per user (one presence room per document)
{
  name: string,            // display name derived from/chosen for session
  color: string,           // stable hue hashed from session id
  isAgent?: boolean,
  editingBlockId?: string, // block currently focused/being mutated
  selection?: {
    blockId: string,       // which text block's PM doc the positions refer to
    anchor: number,        // PM positions in that block's synced doc
    head: number,
    version?: number,      // optional: prosemirror-sync version for mapping
  },
}
```

- **Write path:** on editor `selectionUpdate` / focus change, call `updateRoomUser` throttled + single-flighted (~150–300 ms trailing). Skip writes when the selection is unchanged. Clear `selection` on blur.
- **Read path:** one `usePresence(api.presence, documentId, sessionId)` at the StudioShell level; distribute `presenceState` via context. Each block editor filters for entries whose `selection.blockId` matches its block and feeds them to a ProseMirror plugin that builds `Decoration.widget` (caret + name flag) and `Decoration.inline` (selection highlight) decorations. Clamp remote positions to the current doc size (positions may be momentarily stale relative to the synced doc); optionally map them through steps using the recorded sync `version` for exactness. Avatars come from the same `presenceState` (FacePile or a custom MCDS-styled row); "agent is editing block X" renders from `isAgent + editingBlockId` (e.g. a shimmer/border on that block's CanvasNode).
- **Costs:** every selection write re-runs the room's shared `list` query and pushes the whole room payload to all subscribers. At Tandem scale (couple of humans + one agent per doc) this is well within budget; the throttle is the only tuning knob you should need.

**Trade-off vs a dedicated `cursors` table:** a hand-rolled table (like multiplayer-cursors) gives schema validation, per-block subscription granularity, and history/interpolation options — but you'd rebuild heartbeats, disconnect detection, and stale-row pruning that this component already provides, and per-block subscriptions save little when a document has a handful of collaborators. Start with presence `data`; graduate to a dedicated table only if payload fan-out measurably hurts.
