import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { presence } from "./presence";

/**
 * Multi-agent canvas v0 — the persona registry + persona presence plumbing
 * (docs/proposals/multi-agent-canvas.md §3.1/§3.2).
 *
 * Personas are ADVISORY-ONLY in v0: this module exposes no dispatch path —
 * a persona can never mutate a document. Its findings surface as
 * source:"analysis" suggestions in the client, and only a HUMAN clicking
 * Apply dispatches ops (with `persona:<slug>` provenance). The
 * `capabilityMode: v.literal("advisory")` schema field is the server-side
 * enforcement; see the schema doc comment for the v1 editing-persona seam.
 *
 * Presence identity (the ghost's proven pattern — heartbeat first, then
 * updateRoomUser, because the component drops data for users who never
 * heartbeat): each enabled persona is a roster member with userId
 * `persona:<slug>:<documentId>` and a live `status` field the runner flips
 * around its lifecycle (idle → reading → thinking → idle). When the client
 * stops heartbeating (persona disabled, tab closed) the avatar drops off the
 * facepile naturally ~2.5× the interval later — no disconnect bookkeeping.
 */

/** Persona presence heartbeat interval (offline 2.5× after the last beat). */
const PERSONA_HEARTBEAT_INTERVAL_MS = 5000;

/** Sanity cap on how many personas one heartbeat call may keep alive. */
const MAX_PERSONAS_PER_HEARTBEAT = 8;

export const personaStatusValidator = v.union(
  v.literal("idle"),
  v.literal("reading"),
  v.literal("thinking"),
);

export function buildPersonaPresenceUserId({
  slug,
  documentId,
}: {
  slug: string;
  documentId: Id<"documents">;
}): string {
  return `persona:${slug}:${documentId}`;
}

// ---------------------------------------------------------------------------
// Built-in personas (seeded idempotently; the markdown IS the format example)
// ---------------------------------------------------------------------------

/**
 * Persona markdown format: a frontmatter-ish header carrying display/config
 * metadata (kept in sync with the row's typed fields — the row is the runtime
 * source of truth; the frontmatter is the human-readable/interchange face),
 * then freeform behavior text that becomes the persona's prompt layer.
 * v1: user-editable in-app (edit built-ins as copies); v0 renders read-only.
 */
const BUILT_IN_PERSONAS: ReadonlyArray<{
  slug: string;
  name: string;
  color: string;
  cooldownSeconds: number;
  personaMarkdown: string;
}> = [
  {
    slug: "builtin/tone-police",
    name: "Tone Police",
    // Rose — distinct from the agent violet, ghost sky, and the human hue wheel.
    color: "#e11d48",
    cooldownSeconds: 45,
    personaMarkdown: `---
name: Tone Police
color: "#e11d48"
capabilities: advisory
cooldownSeconds: 45
description: Guards the email's tone of voice — flags copy that clashes with the rest and suggests concrete rewrites.
---

You are the Tone Police. Your single job is the email's tone of voice: one
consistent, intentional register from subject line to sign-off.

What you watch for:
- Copy whose register clashes with the rest of the email (a pushy hard-sell
  line inside a warm friendly note; sudden ALL-CAPS urgency; slang in an
  otherwise formal announcement; stiff legalese in a playful promo).
- Mixed person or voice ("we" vs "I"), inconsistent formality, or greetings/
  closings that don't match the body.
- Button labels and headings whose tone contradicts the body copy.

How you respond:
- Quote the exact phrase that clashes (briefly) and say WHY it clashes with
  the surrounding voice.
- Always offer a concrete rewrite the user could paste in — never just
  "consider changing the tone".
- Judge tone against the email's own dominant voice, not a house style you
  invented. If the whole email is consistently brash, that IS its voice —
  stay quiet.
- At most two findings per pass; only the ones a careful editor would
  actually flag.`,
  },
  {
    slug: "builtin/styling-recommender",
    name: "Styling Recommender",
    // Teal — distinct from the agent violet, ghost sky, and the human hue wheel.
    color: "#0d9488",
    cooldownSeconds: 45,
    personaMarkdown: `---
name: Styling Recommender
color: "#0d9488"
capabilities: advisory
cooldownSeconds: 45
description: Spots styling inconsistencies and opportunities across blocks — and proposes the exact style change to fix them.
---

You are the Styling Recommender. Your single job is visual consistency and
polish across the email's blocks.

What you watch for:
- Same-purpose blocks that drifted apart: two CTA buttons with different
  background colors, corner radii, or alignment; sibling columns with
  mismatched padding; headings that switch color mid-email for no reason.
- Styling that fights the document's global theme (a one-off color that is
  almost-but-not-quite the accent color).
- Readability problems: low-contrast text on its background, tiny font sizes
  on important lines.

How you respond:
- Name the affected blocks by their VISIBLE content (the button labeled
  "Buy now", the heading "Spring sale"), never by internal ids.
- Whenever the fix is a block property change, propose the exact edit
  (block, property, value) so it can be applied with one click. Prefer
  matching the email's existing dominant style over inventing a new one.
- Do not relitigate deliberate variety: a hero section MAY differ from the
  footer. Flag drift between things that clearly want to match.
- At most two findings per pass; skip nitpicks a designer wouldn't stop for.`,
  },
];

/**
 * Idempotent seed: insert any missing built-in persona rows (matched by
 * slug). Existing rows are NEVER overwritten — a future in-app markdown
 * editor (v1) must not have its edits clobbered by a reload. Called by the
 * persona picker on open; safe to call any number of times.
 */
export const seedBuiltInPersonas = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for (const builtIn of BUILT_IN_PERSONAS) {
      const existing = await ctx.db
        .query("agents")
        .withIndex("by_slug", (q) => q.eq("slug", builtIn.slug))
        .unique();
      if (existing !== null) {
        continue;
      }
      const nowMs = Date.now();
      await ctx.db.insert("agents", {
        ...builtIn,
        capabilityMode: "advisory",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    }
    return null;
  },
});

const personaPayloadValidator = v.object({
  slug: v.string(),
  name: v.string(),
  color: v.string(),
  capabilityMode: v.literal("advisory"),
  personaMarkdown: v.string(),
  cooldownSeconds: v.number(),
});

function toPersonaPayload(row: Doc<"agents">) {
  return {
    slug: row.slug,
    name: row.name,
    color: row.color,
    capabilityMode: row.capabilityMode,
    personaMarkdown: row.personaMarkdown,
    cooldownSeconds: row.cooldownSeconds,
  };
}

/** Upper bound on picker rows (v0: two built-ins; marketplace pages later). */
const MAX_LISTED_PERSONAS = 64;

/** All registered personas, ordered by slug (deterministic picker order). */
export const listPersonas = query({
  args: {},
  returns: v.array(personaPayloadValidator),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("agents")
      .withIndex("by_slug")
      .take(MAX_LISTED_PERSONAS);
    return rows.sort((a, b) => (a.slug < b.slug ? -1 : 1)).map(toPersonaPayload);
  },
});

/** Registry rows for the runner (unknown slugs are silently absent). */
export const getPersonasBySlugs = query({
  args: { slugs: v.array(v.string()) },
  returns: v.array(personaPayloadValidator),
  handler: async (ctx, args) => {
    const rows: Doc<"agents">[] = [];
    for (const slug of args.slugs.slice(0, MAX_PERSONAS_PER_HEARTBEAT)) {
      const row = await ctx.db
        .query("agents")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique();
      if (row !== null) {
        rows.push(row);
      }
    }
    return rows.sort((a, b) => (a.slug < b.slug ? -1 : 1)).map(toPersonaPayload);
  },
});

// ---------------------------------------------------------------------------
// Persona presence
// ---------------------------------------------------------------------------

async function assertLiveDocument(
  ctx: MutationCtx | QueryCtx,
  documentId: Id<"documents">,
): Promise<void> {
  const document = await ctx.db.get(documentId);
  if (document === null) {
    throw new Error(`Document ${documentId} does not exist.`);
  }
}

async function findPersonaBySlug(
  ctx: MutationCtx | QueryCtx,
  slug: string,
): Promise<Doc<"agents"> | null> {
  return await ctx.db
    .query("agents")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

/**
 * Keep the enabled personas alive on the roster. Called by the client on an
 * interval while personas are enabled for the open document.
 *
 * Writes IDENTITY data only for personas that have none yet (first join —
 * updateRoomUser drops writes for users who never heartbeat, hence heartbeat
 * first). For personas already on the roster this is heartbeat-only, so a
 * status the runner just wrote ("reading"/"thinking") is never clobbered
 * back to "idle" by a concurrent keep-alive tick.
 */
export const heartbeatPersonas = mutation({
  args: { documentId: v.id("documents"), slugs: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertLiveDocument(ctx, args.documentId);
    const roomId = args.documentId as string;
    const roster = await presence.listRoom(ctx, roomId, false);
    for (const slug of args.slugs.slice(0, MAX_PERSONAS_PER_HEARTBEAT)) {
      const persona = await findPersonaBySlug(ctx, slug);
      if (persona === null) {
        continue;
      }
      const userId = buildPersonaPresenceUserId({ slug, documentId: args.documentId });
      await presence.heartbeat(
        ctx,
        roomId,
        userId,
        `persona-session:${slug}:${roomId}`,
        PERSONA_HEARTBEAT_INTERVAL_MS,
      );
      const entry = roster.find((member) => member.userId === userId);
      // listRoom's TYPED return omits `data` (the component validator only
      // exposes userId/online/lastDisconnected) even though the row carries
      // it at runtime — read it through a widening cast; worst case (no
      // data surfaced) we re-write the identity, which is harmless.
      const hasIdentityData =
        entry !== undefined && (entry as { data?: unknown }).data !== undefined;
      if (!hasIdentityData) {
        await presence.updateRoomUser(ctx, roomId, userId, {
          name: persona.name,
          color: persona.color,
          isAgent: true,
          status: "idle",
        });
      }
    }
    return null;
  },
});

/**
 * Runner lifecycle transitions (reading → thinking → idle), written by the
 * /api/personas route around its one batched analysis call. Presence writes
 * happen on STATE TRANSITIONS only (~3 per persona per run — §3.5 fan-out
 * cost note). `selectedBlockId`, when given, points the persona's existing
 * block-presence chrome at the block its top finding targets.
 */
export const setPersonaStatus = mutation({
  args: {
    documentId: v.id("documents"),
    slug: v.string(),
    status: personaStatusValidator,
    selectedBlockId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertLiveDocument(ctx, args.documentId);
    const persona = await findPersonaBySlug(ctx, args.slug);
    if (persona === null) {
      return null;
    }
    const roomId = args.documentId as string;
    const userId = buildPersonaPresenceUserId({ slug: args.slug, documentId: args.documentId });
    await presence.heartbeat(
      ctx,
      roomId,
      userId,
      `persona-session:${args.slug}:${roomId}`,
      PERSONA_HEARTBEAT_INTERVAL_MS,
    );
    await presence.updateRoomUser(ctx, roomId, userId, {
      name: persona.name,
      color: persona.color,
      isAgent: true,
      status: args.status,
      ...(args.selectedBlockId !== undefined ? { selectedBlockId: args.selectedBlockId } : {}),
    });
    return null;
  },
});
