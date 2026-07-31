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

/**
 * Persona presence heartbeat interval (offline 2.5× after the last beat —
 * the @convex-dev/presence component schedules the disconnect at
 * `interval * 2.5`). Item 27 (owner: heartbeats "need to chill"): raised
 * 5s → 30s alongside the client cadence (25s beats against the 75s
 * tolerance window, safe even under background-tab timer throttling).
 * Cost: ~6× fewer idle presence mutations per enabled-persona tab.
 */
const PERSONA_HEARTBEAT_INTERVAL_MS = 30_000;

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
  {
    slug: "builtin/qa-reviewer",
    name: "QA Reviewer",
    // Amber — distinct from the agent violet, ghost sky, and the human hue wheel.
    color: "#d97706",
    // Relaxed vs the 45s built-ins: it reviews send-readiness, not keystrokes.
    cooldownSeconds: 75,
    personaMarkdown: `---
name: QA Reviewer
color: "#d97706"
capabilities: advisory
cooldownSeconds: 75
description: Runs the pre-send QA checklist — missing alt text, placeholder links, CTAs that don't add up, and a proper footer.
---

You are the QA Reviewer. Your single job is whether this email is READY TO
SEND: everything present, wired up, and working. You check function only —
how things look belongs to the Styling Recommender and how they sound
belongs to the Tone Police; never flag their territory.

What you watch for:
- Images that clearly carry meaning (product shots, hero banners) whose alt
  text is empty or useless ("image", "photo", a filename).
- Buttons and linked images whose destination is missing, a placeholder
  ("#", "example.com", "TODO", "localhost"), or plainly wrong for the label
  (a mailto: behind "Shop now").
- Button labels that contradict where they go or the copy around them ("Read
  the article" in a sale email; two identical labels pointing at different
  URLs).
- No usable footer: a real email ends with a section carrying sender
  identity and an unsubscribe or preferences link.
- Fonts email clients cannot render: a decorative or custom font family with
  no web-safe fallback stack. (Font consistency and readability are the
  Styling Recommender's job — you only flag renderability.)

How you respond:
- Name blocks by their VISIBLE content ("the image of hiking boots", "the
  button labeled 'Start free trial'"), never internal ids, and keep each
  reference short — under ~50 characters.
- Whenever the fix is a block property change, propose the exact edit: the
  alt text you drafted, the corrected href, the fallback font stack.
- Every finding must point at at least one block that EXISTS. When you flag
  something MISSING (no footer, no unsubscribe link), anchor the finding to
  the closest existing block — usually the email's last section — and word
  the fix as "add …".
- One finding per problem TYPE per pass — if three images lack alt text,
  that is ONE finding naming all three, not three findings.
- At most two findings per pass; lead with whatever would embarrass the
  sender most in an inbox.`,
  },
  {
    slug: "builtin/date-checker",
    name: "Date Checker",
    // Lime — distinct from the agent violet, ghost sky, and the human hue wheel.
    color: "#65a30d",
    // Most relaxed on the roster: dates change rarely between edits.
    cooldownSeconds: 90,
    personaMarkdown: `---
name: Date Checker
color: "#65a30d"
capabilities: advisory
cooldownSeconds: 90
watch: text, button
description: Catches contradictory or impossible dates, times, deadlines, and offer numbers before subscribers do.
---

You are the Date Checker. Your single job is the internal consistency of
every date, time, deadline, and offer number in the email. You read facts
only — phrasing is the Tone Police's job, looks are the Styling
Recommender's, and links/footers are the QA Reviewer's; never flag theirs.

What you watch for:
- Dates that disagree with each other: "ends March 3" in the hero but
  "through March 5" in the fine print; an RSVP deadline after the event.
- Weekday/date mismatches ("Monday, June 14" when June 14 falls on a
  Sunday) and impossible dates ("February 30").
- Numbers tied to the same offer that contradict: two different discount
  percentages for one sale, a price that changes between sections, "3 tips"
  above a list of four.
- Stale leftovers from a reused template: a lone last-year date sitting next
  to this-year dates.
- Missing time context readers will ask about: an event time with no
  timezone or no date at all.

How you respond:
- Quote BOTH conflicting values and where each appears, naming blocks by
  their visible content (never internal ids), each reference under ~50
  characters.
- Never silently pick a winner. Present the contradiction; propose a
  concrete fix only when one value is clearly the typo (a weekday that
  doesn't match its date).
- If the email genuinely contains no dates or offer numbers, say nothing —
  zero findings is your most common correct answer.
- At most two findings per pass; a real contradiction outranks a missing
  timezone.`,
  },
];

/**
 * Idempotent seed: insert any missing built-in persona rows (matched by
 * slug), and sync already-seeded BUILT-IN rows whose fixture changed — the
 * repo fixture is the source of truth for a pristine built-in, and user
 * edits never live on these rows anyway (updatePersonaMarkdown forks a
 * session copy instead of patching a built-in). Session copies are never
 * touched. Called by the persona picker on open; safe to call any number of
 * times.
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
      const nowMs = Date.now();
      if (existing !== null) {
        const isFixtureDrifted =
          existing.personaMarkdown !== builtIn.personaMarkdown ||
          existing.name !== builtIn.name ||
          existing.color !== builtIn.color ||
          existing.cooldownSeconds !== builtIn.cooldownSeconds;
        if (isFixtureDrifted) {
          await ctx.db.patch(existing._id, {
            name: builtIn.name,
            color: builtIn.color,
            cooldownSeconds: builtIn.cooldownSeconds,
            personaMarkdown: builtIn.personaMarkdown,
            updatedAtMs: nowMs,
          });
        }
        continue;
      }
      await ctx.db.insert("agents", {
        ...builtIn,
        capabilityMode: "advisory",
        isBuiltIn: true,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// In-app persona markdown editing (proposal §6 item 9 — copy-on-edit)
// ---------------------------------------------------------------------------

/**
 * Size cap on a persona's markdown (~8 KB). Untrusted prompt text injected
 * into a privileged position (§5.8) — the cap is one of the structural
 * mitigations (alongside server-enforced capabilityMode) and keeps the
 * batched runner's persona layer bounded (§4.2).
 */
const MAX_PERSONA_MARKDOWN_LENGTH = 8192;

/**
 * Server-side validation of user-submitted persona markdown. Mirrors the
 * client's parse-persona-markdown.ts checks (the client validates first for
 * a friendly inline message; this is the trust boundary). Returns an error
 * message, or null when the markdown is acceptable.
 */
function validatePersonaMarkdown(personaMarkdown: string): string | null {
  const trimmed = personaMarkdown.trim();
  if (trimmed.length === 0) {
    return "The persona definition cannot be empty.";
  }
  if (personaMarkdown.length > MAX_PERSONA_MARKDOWN_LENGTH) {
    return `The persona definition is too long (${personaMarkdown.length} characters; the limit is ${MAX_PERSONA_MARKDOWN_LENGTH}).`;
  }
  if (trimmed.startsWith("---")) {
    const closeIndex = trimmed.indexOf("\n---", 3);
    if (closeIndex === -1) {
      return "The frontmatter block starts with --- but is never closed with a matching --- line.";
    }
    const body = trimmed.slice(closeIndex + "\n---".length).trim();
    if (body.length === 0) {
      return "Add behavior text below the frontmatter — the body is what shapes the persona.";
    }
  }
  return null;
}

/**
 * THE copy-slug convention (single source of truth): a session's copy of
 * `builtin/<base>` is `user/<sessionId>/<base>`. Deterministic, namespaced
 * (§4.6 invariant 2), and slug-unique per (session, built-in) — so editing
 * a built-in twice updates the same copy instead of forking again.
 */
function buildSessionCopySlug({
  sessionId,
  builtInSlug,
}: {
  sessionId: string;
  builtInSlug: string;
}): string {
  const baseName = builtInSlug.slice(builtInSlug.indexOf("/") + 1);
  return `user/${sessionId}/${baseName}`;
}

/**
 * The built-in slug a session copy shadows (inverse of buildSessionCopySlug),
 * or null when the row is not a copy of a built-in. Pure namespace mechanics
 * — no behavior ever branches on a SPECIFIC slug (§4.6 invariant 1).
 */
function getShadowedBuiltInSlug(row: Doc<"agents">): string | null {
  if (row.isBuiltIn !== false || row.createdBySessionId === undefined) {
    return null;
  }
  const copyPrefix = `user/${row.createdBySessionId}/`;
  if (!row.slug.startsWith(copyPrefix)) {
    return null;
  }
  return `builtin/${row.slug.slice(copyPrefix.length)}`;
}

/** Bounds on the form-editable cooldown (budget guard stays meaningful). */
const MIN_COOLDOWN_SECONDS = 10;
const MAX_COOLDOWN_SECONDS = 600;

/**
 * Save edited persona markdown. Built-ins are NEVER patched: saving an edit
 * to a built-in forks (or updates) the session's copy, which shadows the
 * built-in in that session's picker (listPersonas). A session may only edit
 * its own copies. Returns the slug of the row that now carries the edit —
 * the client swaps its localStorage enablement to it, so the next runner
 * turn reads the new markdown from this row.
 *
 * The row's typed fields (name/color/cooldownSeconds) stay the runtime
 * source of truth. The structured editor serializes the SAME values into the
 * frontmatter (interchange face) and passes them here as typed args, so row
 * and markdown never drift; frontmatter is still never parsed inside
 * mutations (§4.5). Omitted typed args leave the source row's values.
 */
export const updatePersonaMarkdown = mutation({
  args: {
    slug: v.string(),
    personaMarkdown: v.string(),
    sessionId: v.string(),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
    cooldownSeconds: v.optional(v.number()),
  },
  returns: v.object({ savedSlug: v.string() }),
  handler: async (ctx, args) => {
    const validationError = validatePersonaMarkdown(args.personaMarkdown);
    if (validationError !== null) {
      throw new Error(validationError);
    }
    if (args.name !== undefined && args.name.trim().length === 0) {
      throw new Error("The persona needs a display name.");
    }
    if (args.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(args.color)) {
      throw new Error("The color must be a 6-digit hex value like #e11d48.");
    }
    if (
      args.cooldownSeconds !== undefined &&
      (args.cooldownSeconds < MIN_COOLDOWN_SECONDS || args.cooldownSeconds > MAX_COOLDOWN_SECONDS)
    ) {
      throw new Error(
        `The cooldown must be between ${MIN_COOLDOWN_SECONDS} and ${MAX_COOLDOWN_SECONDS} seconds.`,
      );
    }
    const row = await findPersonaBySlug(ctx, args.slug);
    if (row === null) {
      throw new Error(`No persona is registered under "${args.slug}".`);
    }
    const nowMs = Date.now();
    // NEVER spread possibly-undefined values into a patch (the serializer
    // silently drops undefined fields — build the object conditionally).
    const typedFieldChanges = {
      ...(args.name !== undefined ? { name: args.name.trim() } : {}),
      ...(args.color !== undefined ? { color: args.color } : {}),
      ...(args.cooldownSeconds !== undefined ? { cooldownSeconds: args.cooldownSeconds } : {}),
    };

    // A user copy: edit in place (owner only).
    if (row.isBuiltIn === false) {
      if (row.createdBySessionId !== args.sessionId) {
        throw new Error("This persona belongs to a different session.");
      }
      await ctx.db.patch(row._id, {
        personaMarkdown: args.personaMarkdown,
        ...typedFieldChanges,
        updatedAtMs: nowMs,
      });
      return { savedSlug: row.slug };
    }

    // A built-in: fork (or update) the session's shadowing copy.
    const copySlug = buildSessionCopySlug({
      sessionId: args.sessionId,
      builtInSlug: row.slug,
    });
    const existingCopy = await findPersonaBySlug(ctx, copySlug);
    if (existingCopy !== null) {
      await ctx.db.patch(existingCopy._id, {
        personaMarkdown: args.personaMarkdown,
        ...typedFieldChanges,
        updatedAtMs: nowMs,
      });
      return { savedSlug: copySlug };
    }
    await ctx.db.insert("agents", {
      slug: copySlug,
      name: row.name,
      color: row.color,
      capabilityMode: row.capabilityMode,
      personaMarkdown: args.personaMarkdown,
      cooldownSeconds: row.cooldownSeconds,
      ...typedFieldChanges,
      isBuiltIn: false,
      createdBySessionId: args.sessionId,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    return { savedSlug: copySlug };
  },
});

/**
 * Discard a session's copy, un-shadowing the pristine built-in ("reset to
 * default"). Returns the built-in's slug so the client can swap enablement
 * back. Owner-only, copies only — built-ins cannot be deleted.
 */
export const resetPersonaToBuiltIn = mutation({
  args: { slug: v.string(), sessionId: v.string() },
  returns: v.object({ builtInSlug: v.string() }),
  handler: async (ctx, args) => {
    const row = await findPersonaBySlug(ctx, args.slug);
    if (row === null) {
      throw new Error(`No persona is registered under "${args.slug}".`);
    }
    if (row.isBuiltIn !== false || row.createdBySessionId !== args.sessionId) {
      throw new Error("Only this session's customized personas can be reset.");
    }
    const builtInSlug = getShadowedBuiltInSlug(row);
    if (builtInSlug === null) {
      throw new Error("This persona is not a copy of a built-in.");
    }
    await ctx.db.delete(row._id);
    return { builtInSlug };
  },
});

// `isBuiltIn` is OPTIONAL in the payload on purpose: /api/personas narrows
// this payload with a `persona is PersonaRow` type predicate against its own
// (narrower) row type — a required extra field would break that assignability.
// toPersonaPayload always populates it; treat undefined as built-in.
const personaPayloadValidator = v.object({
  slug: v.string(),
  name: v.string(),
  color: v.string(),
  capabilityMode: v.literal("advisory"),
  personaMarkdown: v.string(),
  cooldownSeconds: v.number(),
  isBuiltIn: v.optional(v.boolean()),
});

interface PersonaPayload {
  slug: string;
  name: string;
  color: string;
  capabilityMode: "advisory";
  personaMarkdown: string;
  cooldownSeconds: number;
  /** Optional in the TYPE (not the data) — see the validator note above. */
  isBuiltIn?: boolean;
}

function toPersonaPayload(row: Doc<"agents">): PersonaPayload {
  return {
    slug: row.slug,
    name: row.name,
    color: row.color,
    capabilityMode: row.capabilityMode,
    personaMarkdown: row.personaMarkdown,
    cooldownSeconds: row.cooldownSeconds,
    isBuiltIn: row.isBuiltIn !== false,
  };
}

/** Upper bound on picker rows (v0: four built-ins; marketplace pages later). */
const MAX_LISTED_PERSONAS = 64;

/**
 * The personas the given session's picker shows: every built-in EXCEPT those
 * shadowed by one of the session's copies, plus the session's copies. A copy
 * sorts where its built-in would (same picker position, deterministic).
 * Without a sessionId (or for sessions with no copies) this is simply the
 * built-ins, ordered by slug.
 */
export const listPersonas = query({
  args: { sessionId: v.optional(v.string()) },
  returns: v.array(personaPayloadValidator),
  handler: async (ctx, args) => {
    const allRows = await ctx.db
      .query("agents")
      .withIndex("by_slug")
      .take(MAX_LISTED_PERSONAS);
    const builtIns = allRows.filter((row) => row.isBuiltIn !== false);
    const sessionCopies =
      args.sessionId === undefined
        ? []
        : await ctx.db
            .query("agents")
            .withIndex("by_createdBySessionId", (q) =>
              q.eq("createdBySessionId", args.sessionId),
            )
            .take(MAX_LISTED_PERSONAS);
    const shadowedSlugs = new Set(
      sessionCopies
        .map(getShadowedBuiltInSlug)
        .filter((slug): slug is string => slug !== null),
    );
    const visibleRows = [
      ...builtIns.filter((row) => !shadowedSlugs.has(row.slug)),
      ...sessionCopies,
    ];
    return visibleRows
      .map((row) => ({ row, sortKey: getShadowedBuiltInSlug(row) ?? row.slug }))
      .sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1))
      .map((entry) => toPersonaPayload(entry.row));
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
