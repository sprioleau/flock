import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";
import {
  applyOperation,
  textDocSchema,
  updateTextOperationSchema,
  type Block,
  type EmailDocument,
  type TextDoc,
} from "@flock/email-sdk";
import { v } from "convex/values";
import { normalizeEditorDoc } from "../apps/web/src/components/studio/text-editor/normalize-editor-doc";
import { buildEditorSchema, Transform } from "../apps/web/src/lib/editorSchema";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { commitVersions, loadDocumentState, type DocumentState } from "./model/emailDocuments";
import { buildSyncDocId } from "./model/textBlockSync";
import { presence } from "./presence";

/**
 * Demo mode — the GHOST COLLABORATOR: a simulated second human who types a
 * short doc-aware message character-by-character into one text block, so one
 * person can demo real-time multiplayer from a single browser.
 *
 * Architecture (per the demo-mode proposal §3.2, with the mirror question
 * resolved):
 *
 *  - TICK CHAIN: startGhost seeds a ghostSessions row (the stop flag + plan
 *    cursor) and schedules internal.ghost.ghostTick, which self-reschedules
 *    with human-ish jitter until the keystroke plan is exhausted (~20-30s,
 *    bounded by the plan length AND a hard wall-clock cap). Every tick is
 *    stamped with the session's `generation`; stopGhost deletes/supersedes
 *    the row, so in-flight stale ticks self-cancel (cleanup.ts pattern).
 *  - KEYSTROKE = prosemirrorSync.transform under GHOST_CLIENT_ID (never
 *    AI_AGENT_CLIENT_ID — the agent-pulse must not fire; the ghost imitates
 *    a HUMAN). Content-anchored and idempotent: each step recomputes its
 *    insertion point from the live doc by locating `anchorTail + the typed-
 *    so-far prefix` (never a stored position), and returns null when the
 *    post-state is already present (rebase-retry safe). If a concurrent
 *    human edit destroys the anchor, the session ends gracefully.
 *  - MIRROR: server-side transforms do NOT flow through onSnapshot (the
 *    component's snapshots are client-submitted), so each tick also writes
 *    the block row's properties.text directly — the same documented
 *    derived-cache exception as prosemirror.ts mirrorSnapshotIntoBlock
 *    (normalize + textDocSchema, patch only text, zero op rows). This is
 *    what makes the STATIC canvas show the ghost typing for viewers who do
 *    not have the block's editor open.
 *  - HISTORY: exactly ONE session-granularity `updateText` op is committed
 *    through commitVersions when the session ends (author "user", authorId
 *    = the ghost's presence userId, caller "cli" — the demo-provenance
 *    marker), exactly matching human session semantics. commitVersions'
 *    withOpLogTextInverses re-anchors the inverse to the op log, so undoing
 *    the ghost's contribution behaves like undoing a human session.
 *  - PRESENCE: the ghost heartbeats a real presence session (userId
 *    "ghost:<documentId>", name/color via updateRoomUser, editingBlockId
 *    while typing, NOT isAgent). After the session ends it stops
 *    heartbeating and drops off the facepile naturally (~2.5x interval).
 *  - Selection/caret presence broadcasts are deliberately SKIPPED: the
 *    PresenceData `selection` contract carries client-side editor state the
 *    server cannot cheaply derive; the ghost's keystrokes already appear
 *    live inside any open editor via the sync steps.
 */

const prosemirrorSync = new ProsemirrorSync(components.prosemirrorSync);

/**
 * Synthetic clientId for ghost-typed steps. Sibling of AI_AGENT_CLIENT_ID /
 * HISTORY_CLIENT_ID (model/textBlockSync.ts) but declared here on purpose —
 * the ghost is a demo-only actor and textBlockSync stays untouched. MUST stay
 * distinct from "flock-agent" or the client agent-pulse would fire.
 */
export const GHOST_CLIENT_ID = "flock-ghost";

/** Presence identity: the ghost simulates a HUMAN guest (isAgent is never set). */
const GHOST_NAME = "Riley (guest)";
/** Sky blue — distinct from the agent violet and the human hsl(70%/45%) wheel. */
const GHOST_COLOR = "#0ea5e9";
/** Offline after 2.5x this without a heartbeat — the natural drop-off. */
const GHOST_HEARTBEAT_INTERVAL_MS = 5000;

/** Keystroke cadence: base + jitter = 140-300ms, human-ish. */
const MIN_TICK_DELAY_MS = 140;
const TICK_JITTER_MS = 160;
/** Extra beat after ending a sentence. */
const SENTENCE_PAUSE_MS = 300;
/** The "noticing the typo" beat before the backspace step. */
const TYPO_NOTICE_PAUSE_MS = 450;
/** Delay before the first keystroke (the ghost "arrives", then types). */
const INITIAL_TICK_DELAY_MS = 450;

/** Anchor context captured at start: the last N flattened chars of the block. */
const ANCHOR_TAIL_CHARS = 24;
/** Hard cap on the script (bounds the plan, the run time, and mutation count). */
const MAX_SCRIPT_CHARS = 200;
/** A session row older than this is a dead chain — treated as not running. */
const STALE_GHOST_SESSION_MS = 120_000;
/** Absolute wall-clock bound on a run; the tick chain finishes past this. */
const MAX_SESSION_RUN_MS = 60_000;

// ProseMirror types via the shared schema module (no @tiptap/pm import here —
// unresolvable from the repo-root convex/ dir; same trick as agentText.ts).
type EditorSchema = ReturnType<typeof buildEditorSchema>;
type PmNode = ReturnType<EditorSchema["nodeFromJSON"]>;

function buildGhostUserId(documentId: Id<"documents">): string {
  return `ghost:${documentId}`;
}

/** At most one session row per document (unique by construction). */
async function findGhostSession(
  ctx: QueryCtx | MutationCtx,
  documentId: Id<"documents">,
): Promise<Doc<"ghostSessions"> | null> {
  return await ctx.db
    .query("ghostSessions")
    .withIndex("by_documentId", (q) => q.eq("documentId", documentId))
    .unique();
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export const startGhost = mutation({
  args: {
    documentId: v.id("documents"),
    /** Target text block; a sensible one is picked when omitted. */
    blockId: v.optional(v.string()),
  },
  returns: v.object({ blockId: v.string(), isAlreadyTyping: v.boolean() }),
  handler: async (ctx, args) => {
    const state = await loadDocumentState(ctx, args.documentId);
    if (state === null) {
      throw new Error(`Document ${args.documentId} does not exist.`);
    }

    const existingSession = await findGhostSession(ctx, args.documentId);
    if (existingSession !== null) {
      if (Date.now() - existingSession.startedAtMs < STALE_GHOST_SESSION_MS) {
        // One ghost per document; Start while running is a friendly no-op.
        return { blockId: existingSession.blockId, isAlreadyTyping: true };
      }
      // Dead chain (deploy restart etc.) — sweep and start fresh.
      await ctx.db.delete(existingSession._id);
    }

    const blockId = resolveTargetBlockId({ state, requestedBlockId: args.blockId });
    const schema = buildEditorSchema();
    const syncDocId = buildSyncDocId({ documentId: args.documentId, blockId });

    // Ensure the block's sync doc exists (prosemirror.ts ensureBlockDoc
    // semantics: check-then-create is safe within this mutation).
    const existingVersion = await ctx.runQuery(components.prosemirrorSync.lib.latestVersion, {
      id: syncDocId,
    });
    if (existingVersion === null) {
      const initialText = textDocSchema.safeParse(
        state.blockRowsByBlockId.get(blockId)?.properties.text,
      );
      if (!initialText.success) {
        throw new Error(`Block ${blockId} has no valid properties.text to seed the sync doc from.`);
      }
      await prosemirrorSync.create(ctx, syncDocId, initialText.data);
    }

    // Content anchor: the live doc's flattened tail at start. Every keystroke
    // recomputes its position from `anchorTail + typed-so-far` — never a
    // stored position (Spike B retry semantics).
    const { doc } = await prosemirrorSync.getDoc(ctx, syncDocId, schema);
    const flat = flattenPmDocText(doc);
    const anchorTail = flat.text.slice(-ANCHOR_TAIL_CHARS);

    const script = composeGhostScript({
      headingText: findFirstHeadingText(state.doc),
      hasExistingText: flat.text.length > 0,
    });
    const { typoIndex, typoChar } = pickTypo(script);

    const generation = Date.now();
    await ctx.db.insert("ghostSessions", {
      documentId: args.documentId,
      blockId,
      generation,
      script,
      typoIndex,
      typoChar,
      planIndex: 0,
      anchorTail,
      startedAtMs: generation,
    });

    await heartbeatGhostPresence({ ctx, documentId: args.documentId, editingBlockId: blockId });
    await ctx.scheduler.runAfter(INITIAL_TICK_DELAY_MS, internal.ghost.ghostTick, {
      documentId: args.documentId,
      generation,
    });
    return { blockId, isAlreadyTyping: false };
  },
});

export const stopGhost = mutation({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (document === null) {
      throw new Error(`Document ${args.documentId} does not exist.`);
    }
    const session = await findGhostSession(ctx, args.documentId);
    if (session === null) {
      return null;
    }
    // Deleting the row makes every pending tick self-cancel; the session op
    // for whatever was typed so far commits here (same path as natural end).
    await finishGhostSession({ ctx, session });
    return null;
  },
});

/** Reactive Start/Stop state for the settings menu. */
export const getGhostStatus = query({
  args: { documentId: v.id("documents") },
  returns: v.object({ isTyping: v.boolean(), blockId: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const session = await findGhostSession(ctx, args.documentId);
    const isTyping = session !== null && Date.now() - session.startedAtMs < STALE_GHOST_SESSION_MS;
    return { isTyping, blockId: isTyping && session !== null ? session.blockId : null };
  },
});

// ---------------------------------------------------------------------------
// The tick chain
// ---------------------------------------------------------------------------

export const ghostTick = internalMutation({
  args: {
    documentId: v.id("documents"),
    /** Must match the live session row or this tick is stale and self-cancels. */
    generation: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await findGhostSession(ctx, args.documentId);
    if (session === null || session.generation !== args.generation) {
      return null; // Stopped or superseded — stale tick self-cancels.
    }
    const document = await ctx.db.get(args.documentId);
    if (document === null) {
      await ctx.db.delete(session._id);
      return null;
    }

    const planStepCount = countPlanSteps(session);
    const hasRunTooLong = Date.now() - session.startedAtMs > MAX_SESSION_RUN_MS;
    if (session.planIndex >= planStepCount || hasRunTooLong) {
      await finishGhostSession({ ctx, session });
      return null;
    }

    const blockRow = await ctx.db
      .query("blocks")
      .withIndex("by_documentId_and_blockId", (q) =>
        q.eq("documentId", session.documentId).eq("blockId", session.blockId),
      )
      .unique();
    if (blockRow === null || blockRow.type !== "text") {
      // Block deleted mid-run: nothing to type into or commit against.
      await ctx.db.delete(session._id);
      await clearGhostEditingPresence({ ctx, documentId: session.documentId });
      return null;
    }

    const outcome = await applyGhostKeystroke({ ctx, session, blockRow });
    if (outcome.hasLostAnchor) {
      // A concurrent human edit removed the ghost's typed prefix — end the
      // session gracefully instead of typing anywhere aggressive.
      await finishGhostSession({ ctx, session });
      return null;
    }
    if (outcome.mirroredText !== null) {
      await ctx.db.patch(blockRow._id, {
        properties: { ...blockRow.properties, text: outcome.mirroredText },
      });
    }

    await heartbeatGhostPresence({
      ctx,
      documentId: session.documentId,
      editingBlockId: session.blockId,
    });

    const nextPlanIndex = session.planIndex + 1;
    await ctx.db.patch(session._id, { planIndex: nextPlanIndex });
    await ctx.scheduler.runAfter(
      nextTickDelayMs({ session, nextPlanIndex }),
      internal.ghost.ghostTick,
      { documentId: args.documentId, generation: args.generation },
    );
    return null;
  },
});

/**
 * One keystroke: transform the sync doc under GHOST_CLIENT_ID and return the
 * resulting TextDoc for the block-row mirror. Idempotent by construction —
 * the callback recomputes everything from the live doc on every (re)invoke:
 *  - post-state already present -> null (retry after a successful submit);
 *  - pre-state anchor found -> apply exactly one insert/delete at its end;
 *  - anchor missing -> report lost (the caller ends the session).
 */
async function applyGhostKeystroke({
  ctx,
  session,
  blockRow,
}: {
  ctx: MutationCtx;
  session: Doc<"ghostSessions">;
  blockRow: Doc<"blocks">;
}): Promise<{ hasLostAnchor: boolean; mirroredText: TextDoc | null }> {
  const schema = buildEditorSchema();
  const syncDocId = buildSyncDocId({
    documentId: session.documentId,
    blockId: session.blockId,
  });
  const beforeText = session.anchorTail + typedPrefixAt({ session, planIndex: session.planIndex });
  const afterText = session.anchorTail + typedPrefixAt({ session, planIndex: session.planIndex + 1 });
  const isDeleteStep = session.typoIndex >= 0 && session.planIndex === session.typoIndex + 1;
  const insertedText = afterText.slice(beforeText.length);

  let hasLostAnchor = false;
  const transformedDoc = await prosemirrorSync.transform(
    ctx,
    syncDocId,
    schema,
    (liveDoc) => {
      hasLostAnchor = false;
      const flat = flattenPmDocText(liveDoc);
      const matchIndex = beforeText.length > 0 ? flat.text.lastIndexOf(beforeText) : flat.text.length;

      if (isDeleteStep) {
        // afterText is a PREFIX of beforeText here, so check the pre-state
        // first: gone (with the post-state still present) means the delete
        // already applied on a previous attempt.
        if (matchIndex === -1) {
          if (afterText.length === 0 || flat.text.includes(afterText)) {
            return null;
          }
          hasLostAnchor = true;
          return null;
        }
        const endChar = matchIndex + beforeText.length;
        const deleteFrom = flat.positionsByCharIndex[endChar - 1];
        if (deleteFrom === undefined) {
          hasLostAnchor = true;
          return null;
        }
        const tr = new Transform(liveDoc);
        tr.delete(deleteFrom, deleteFrom + 1);
        return tr;
      }

      // Insert step: beforeText is a prefix of afterText, so the post-state
      // check comes first (found -> this step already applied).
      if (flat.text.includes(afterText)) {
        return null;
      }
      if (matchIndex === -1) {
        hasLostAnchor = true;
        return null;
      }
      const endChar = matchIndex + beforeText.length;
      const insertPos =
        endChar > 0
          ? flat.positionsByCharIndex[endChar - 1]! + 1
          : endOfLastTextblockPosition(liveDoc);
      if (insertPos === null) {
        hasLostAnchor = true;
        return null;
      }
      const tr = new Transform(liveDoc);
      // Inherit the marks at the caret so the ghost's text blends into any
      // styled run it continues.
      tr.insert(insertPos, schema.text(insertedText, liveDoc.resolve(insertPos).marks()));
      return tr;
    },
    { clientId: GHOST_CLIENT_ID },
  );

  if (hasLostAnchor) {
    return { hasLostAnchor: true, mirroredText: null };
  }
  return { hasLostAnchor: false, mirroredText: toMirrorableTextDoc(transformedDoc) };
}

/**
 * End a session (natural completion, stopGhost, or lost anchor): delete the
 * row (pending ticks self-cancel), clear the editing indicator, and commit
 * the ONE session-granularity updateText op recording the ghost's
 * contribution on the history spine — human session semantics exactly
 * (commitVersions re-anchors the inverse to the op log, because the mirror
 * has already advanced properties.text without op rows).
 */
async function finishGhostSession({
  ctx,
  session,
}: {
  ctx: MutationCtx;
  session: Doc<"ghostSessions">;
}): Promise<void> {
  await ctx.db.delete(session._id);
  const state = await loadDocumentState(ctx, session.documentId);
  if (state === null) {
    return;
  }
  await clearGhostEditingPresence({ ctx, documentId: session.documentId });
  if (session.planIndex === 0) {
    return; // Never typed — no session op.
  }
  const blockRow = state.blockRowsByBlockId.get(session.blockId);
  if (blockRow === undefined || blockRow.type !== "text") {
    return;
  }

  // Final text: prefer the live sync doc (ahead of the mirror by design);
  // fall back to the mirrored properties.text.
  const syncDocId = buildSyncDocId({
    documentId: session.documentId,
    blockId: session.blockId,
  });
  let finalText: TextDoc | null = null;
  const syncVersion = await ctx.runQuery(components.prosemirrorSync.lib.latestVersion, {
    id: syncDocId,
  });
  if (syncVersion !== null) {
    const { doc } = await prosemirrorSync.getDoc(ctx, syncDocId, buildEditorSchema());
    finalText = toMirrorableTextDoc(doc);
  }
  if (finalText === null) {
    const fallback = textDocSchema.safeParse(blockRow.properties.text);
    finalText = fallback.success ? fallback.data : null;
  }
  if (finalText === null) {
    return;
  }

  const parsedOp = updateTextOperationSchema.safeParse({
    name: "updateText",
    blockId: session.blockId,
    text: finalText,
  });
  if (!parsedOp.success) {
    return;
  }
  const result = applyOperation(state.doc, parsedOp.data);
  if (!result.isOk) {
    console.warn(
      `[ghost] session op for ${session.blockId} failed to apply; skipping the history record:`,
      result.errors.map((error) => error.message).join("; "),
    );
    return;
  }
  await commitVersions({
    ctx,
    state,
    newDoc: result.doc,
    entries: [{ op: parsedOp.data, inverse: result.inverse, kind: "edit" }],
    // The ghost impersonates a HUMAN on purpose (author "user"); caller "cli"
    // is the demo-provenance marker (proposal §2), authorId matches the
    // presence userId so identity is consistent across surfaces.
    context: {
      author: "user",
      authorId: buildGhostUserId(session.documentId),
      caller: "cli",
    },
  });
}

// ---------------------------------------------------------------------------
// Presence (the markAgentEditing pattern with the ghost's own HUMAN identity)
// ---------------------------------------------------------------------------

/**
 * Heartbeat first, then updateRoomUser — the component drops data for users
 * who never heartbeat. A stable sessionId per document bumps one session's
 * deadline instead of piling up sessions; when the chain stops heartbeating
 * the ghost goes offline ~2.5x the interval later, no disconnect needed.
 */
async function heartbeatGhostPresence({
  ctx,
  documentId,
  editingBlockId,
}: {
  ctx: MutationCtx;
  documentId: Id<"documents">;
  editingBlockId?: string;
}): Promise<void> {
  const roomId = documentId as string;
  const userId = buildGhostUserId(documentId);
  await presence.heartbeat(
    ctx,
    roomId,
    userId,
    `ghost-session:${roomId}`,
    GHOST_HEARTBEAT_INTERVAL_MS,
  );
  await presence.updateRoomUser(ctx, roomId, userId, {
    name: GHOST_NAME,
    color: GHOST_COLOR,
    ...(editingBlockId !== undefined ? { editingBlockId } : {}),
  });
}

/** Drop editingBlockId but keep the identity, so the avatar lingers briefly. */
async function clearGhostEditingPresence({
  ctx,
  documentId,
}: {
  ctx: MutationCtx;
  documentId: Id<"documents">;
}): Promise<void> {
  await presence.updateRoomUser(ctx, documentId as string, buildGhostUserId(documentId), {
    name: GHOST_NAME,
    color: GHOST_COLOR,
  });
}

// ---------------------------------------------------------------------------
// Keystroke plan (pure)
// ---------------------------------------------------------------------------

type GhostPlan = Pick<Doc<"ghostSessions">, "script" | "typoIndex" | "typoChar">;

/** Steps 0..typoIndex-1 insert script chars; step typoIndex inserts the wrong
 * char; step typoIndex+1 backspaces it; later steps resume the script. */
function countPlanSteps(plan: GhostPlan): number {
  return plan.typoIndex < 0 ? plan.script.length : plan.script.length + 2;
}

/** The exact text the ghost has typed after `planIndex` steps — deterministic,
 * so every tick (and every transform retry) recomputes the same anchor. */
function typedPrefixAt({ session, planIndex }: { session: GhostPlan; planIndex: number }): string {
  const { script, typoIndex, typoChar } = session;
  if (typoIndex < 0 || planIndex <= typoIndex) {
    return script.slice(0, Math.min(planIndex, script.length));
  }
  if (planIndex === typoIndex + 1) {
    return script.slice(0, typoIndex) + typoChar;
  }
  return script.slice(0, Math.min(planIndex - 2, script.length));
}

function nextTickDelayMs({
  session,
  nextPlanIndex,
}: {
  session: GhostPlan;
  nextPlanIndex: number;
}): number {
  // Convex mutations record Math.random, so jitter is replay-safe.
  const base = MIN_TICK_DELAY_MS + Math.random() * TICK_JITTER_MS;
  const isAboutToFixTypo = session.typoIndex >= 0 && nextPlanIndex === session.typoIndex + 1;
  if (isAboutToFixTypo) {
    return Math.round(base + TYPO_NOTICE_PAUSE_MS);
  }
  const lastTypedChar = typedPrefixAt({ session, planIndex: nextPlanIndex }).slice(-1);
  if (".!?".includes(lastTypedChar)) {
    return Math.round(base + SENTENCE_PAUSE_MS);
  }
  return Math.round(base);
}

/** Common mistype neighbors (QWERTY-ish) for the typo-and-correct beat. */
const TYPO_NEIGHBOR_BY_CHAR: Record<string, string> = {
  a: "s",
  c: "v",
  d: "f",
  e: "r",
  g: "h",
  h: "j",
  i: "o",
  k: "l",
  l: "k",
  m: "n",
  n: "m",
  o: "i",
  r: "t",
  s: "d",
  t: "r",
  u: "y",
  w: "e",
  y: "u",
};

/** First mistypable letter past ~45% of the script; -1 disables the typo. */
function pickTypo(script: string): { typoIndex: number; typoChar: string } {
  for (let index = Math.floor(script.length * 0.45); index < script.length; index += 1) {
    const neighbor = TYPO_NEIGHBOR_BY_CHAR[script[index]!];
    if (neighbor !== undefined && neighbor !== script[index]) {
      return { typoIndex: index, typoChar: neighbor };
    }
  }
  return { typoIndex: -1, typoChar: "" };
}

// ---------------------------------------------------------------------------
// Script + target-block selection (doc-aware)
// ---------------------------------------------------------------------------

function composeGhostScript({
  headingText,
  hasExistingText,
}: {
  headingText: string | null;
  hasExistingText: boolean;
}): string {
  const opener =
    headingText !== null
      ? `Ooh, "${truncateToWords(headingText, 4)}" is a strong opener!`
      : "Ooh, this draft is coming together nicely!";
  const script = `${opener} Adding a quick thought here so you can watch me type. Ok, back to you!`;
  return (hasExistingText ? ` ${script}` : script).slice(0, MAX_SCRIPT_CHARS);
}

function truncateToWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  const truncated = words.slice(0, maxWords).join(" ");
  return words.length > maxWords ? `${truncated}…` : truncated;
}

/** Blocks in document tree order (root-first depth-first walk). */
function listBlocksInTreeOrder(doc: EmailDocument): Block[] {
  const blocksById = doc as Record<string, Block | undefined>;
  const ordered: Block[] = [];
  const visit = (blockId: string): void => {
    const block = blocksById[blockId];
    if (block === undefined) {
      return;
    }
    ordered.push(block);
    for (const childId of block.childrenIds) {
      visit(childId as string);
    }
  };
  visit("root");
  return ordered;
}

type TextBlockNode = TextDoc["content"][number];

function flattenInlineText(node: TextBlockNode): string {
  return (node.content ?? [])
    .map((inline) => (inline.type === "text" ? inline.text : " "))
    .join("")
    .trim();
}

/** The first non-empty heading in tree order — the script's doc-aware hook. */
function findFirstHeadingText(doc: EmailDocument): string | null {
  for (const block of listBlocksInTreeOrder(doc)) {
    if (block.type !== "text") {
      continue;
    }
    const parsed = textDocSchema.safeParse(block.properties.text);
    if (!parsed.success) {
      continue;
    }
    for (const node of parsed.data.content) {
      if (node.type === "heading") {
        const headingText = flattenInlineText(node);
        if (headingText.length > 0) {
          return headingText;
        }
      }
    }
  }
  return null;
}

/**
 * The requested block (must be a text block) or a sensible default: the text
 * block with the most paragraph copy — body text reads best mid-demo — with
 * any text block as the fallback.
 */
function resolveTargetBlockId({
  state,
  requestedBlockId,
}: {
  state: DocumentState;
  requestedBlockId: string | undefined;
}): string {
  if (requestedBlockId !== undefined) {
    const requested = state.blockRowsByBlockId.get(requestedBlockId);
    if (requested === undefined) {
      throw new Error(`Block ${requestedBlockId} does not exist in this document.`);
    }
    if (requested.type !== "text") {
      throw new Error(
        `Block ${requestedBlockId} is a "${requested.type}" block; the ghost only types into text blocks.`,
      );
    }
    return requestedBlockId;
  }
  let bestBlockId: string | null = null;
  let bestScore = -1;
  for (const block of listBlocksInTreeOrder(state.doc)) {
    if (block.type !== "text") {
      continue;
    }
    const parsed = textDocSchema.safeParse(block.properties.text);
    if (!parsed.success) {
      continue;
    }
    const paragraphChars = parsed.data.content
      .filter((node) => node.type === "paragraph")
      .reduce((total, node) => total + flattenInlineText(node).length, 0);
    if (paragraphChars > bestScore) {
      bestScore = paragraphChars;
      bestBlockId = block.id as string;
    }
  }
  if (bestBlockId === null) {
    throw new Error("This document has no text block for the ghost to type into.");
  }
  return bestBlockId;
}

// ---------------------------------------------------------------------------
// ProseMirror flatten + mirror helpers
// ---------------------------------------------------------------------------

const BLOCK_SEPARATOR = "\n";
const LEAF_PLACEHOLDER = "￼";

/** A doc's text flattened to one string, with a char-index -> PM-position map
 * (agentText.ts pattern: block boundaries become separators so anchors never
 * false-match across paragraphs). */
interface FlatDocText {
  text: string;
  positionsByCharIndex: number[];
}

function flattenPmDocText(doc: PmNode): FlatDocText {
  let text = "";
  const positionsByCharIndex: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text !== undefined) {
      for (let charIndex = 0; charIndex < node.text.length; charIndex += 1) {
        positionsByCharIndex.push(pos + charIndex);
      }
      text += node.text;
    } else if (node.isLeaf) {
      positionsByCharIndex.push(pos);
      text += LEAF_PLACEHOLDER;
    } else if (node.isBlock && text.length > 0) {
      positionsByCharIndex.push(pos);
      text += BLOCK_SEPARATOR;
    }
    return true;
  });
  return { text, positionsByCharIndex };
}

/** Insertion point for a fully empty doc: the end of its last textblock. */
function endOfLastTextblockPosition(doc: PmNode): number | null {
  let position: number | null = null;
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      position = pos + 1 + node.content.size;
    }
    return true;
  });
  return position;
}

/**
 * PM doc -> strict SDK TextDoc for the properties.text mirror (the same
 * normalize + validate boundary as prosemirror.ts mirrorSnapshotIntoBlock).
 * Null when the doc does not survive validation — the mirror is then skipped
 * for this tick and the next one retries with fresher content.
 */
function toMirrorableTextDoc(doc: PmNode): TextDoc | null {
  const editorDoc = doc.toJSON() as Parameters<typeof normalizeEditorDoc>[0];
  const validation = textDocSchema.safeParse(normalizeEditorDoc(editorDoc));
  if (!validation.success) {
    console.warn(
      `[ghost] transformed doc failed textDocSchema after normalization; skipping this mirror tick: ${validation.error.message}`,
    );
    return null;
  }
  return validation.data;
}
