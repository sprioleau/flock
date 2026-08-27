import { google } from "@ai-sdk/google";
import {
  generateDocumentOutline,
  SYSTEM_STATIC,
} from "@flock/agent";
import { ROOT_BLOCK_ID, type EmailDocument, type Operation } from "@flock/email-sdk";
import { generateObject } from "ai";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { z } from "zod";
import { api } from "@convex/_generated/api";
import { chargeCreditForRequest } from "@/lib/auth/credits";
import { MOCK_MODEL_HEADER, MODEL_RESPONSE_HEADER } from "@/lib/chat-contract";
import { selectIsMockForced } from "@/lib/demo/mock-authority";
import { createTraceId, logFailure, logRecord, summarizeError } from "@/lib/observability/log";
import {
  modelTelemetryFor,
  type ModelTelemetryContext,
} from "@/lib/observability/model-telemetry";
import { stableStringify } from "@/lib/suggestions/serialize-block";
import { MOCK_MODEL_ID } from "../chat/constants";
import { selectSeededFinding } from "./demo-findings";
import { composeFindingOps } from "./finding-ops";
import { runnerOutputSchema, truncateFindingProse, type RunnerOutputFinding } from "./finding-schema";

/**
 * POST /api/personas — the multi-agent canvas v0 ADVISORY RUNNER
 * (docs/proposals/multi-agent-canvas.md §3.3 model A, §4.2 batched call).
 *
 * One settled user gesture (client watcher, use-persona-advisors.ts) fires at
 * most ONE Gemini analysis call covering ALL enabled advisory personas. The
 * prompt stacks cache-friendly (§3.4): shared static core first, then the
 * enabled personas' markdowns ordered by slug (a stable extended prefix per
 * enabled set), fresh tokens (outline + trigger summary) always last.
 *
 * Structured output = per-persona findings. A finding MAY carry concrete
 * intent-level edits — property edits ({blockId, property, value}) and/or
 * copy rewrites ({blockId, text} as PLAIN TEXT) — which finding-ops.ts
 * translates deterministically into `updateBlockProperties` / `updateText`
 * operations (the llm-tool-interface principle: simple args in, structure
 * built server-side). Every op batch is DRY-RUN through the SDK's pure
 * `applyOperations` before it is surfaced; findings whose ops fail the dry-run
 * degrade to informational. Personas never dispatch anything — findings become
 * source:"analysis" suggestions client-side, and only a human clicking Apply
 * writes to the document.
 *
 * Budget discipline (§5.1): per-persona cooldowns gate client-side; this
 * route adds a per-document minimum interval and an outline-unchanged skip
 * as server backstops, plus a `flock.personas.request` JSON log line so
 * tokens-per-run stay observable. Requests carrying `x-flock-mock: 1` (or any
 * request when GOOGLE_GENERATIVE_AI_API_KEY is absent — the chat route's exact
 * convention) skip the Gemini call for a deterministic mock findings set;
 * everything else in the pipeline stays real.
 *
 * FORCED MOCK ON DEMO DOCUMENTS (demo-mode.md §H, stage 2). A document whose
 * row carries `isDemo` runs the mock NO MATTER WHAT THE CLIENT SENT — resolved
 * from the row this route already fetches, so it costs no extra read. /demo is
 * a public unauthenticated link onto a Gemini free-tier quota shared with
 * production; a header the client chooses to send is a request, not a guard.
 * The rule itself lives in lib/demo/mock-authority.ts.
 *
 * PERSISTENCE (multi-agent v1): surviving findings are RECORDED in the
 * `personaFindings` table (convex/personaFindings.ts) rather than consumed
 * only by the initiating client — every tab/collaborator reads them
 * reactively, and dismiss/apply converge through row status. Each finding is
 * stored with `targetSnapshots` (stableStringify of every block it depends
 * on, from THIS run's doc snapshot — the exact doc the ops were dry-run
 * against) as the shared staleness baseline. Before the call, the runner
 * prunes stale open rows and feeds the fresh ones back into the prompt as
 * §5.6b turn-input dedup context — per-request data, appended in the
 * fresh-tokens-LAST position (the user message), never into a static layer.
 */

/**
 * Model for the batched persona analysis call. Plenty for a one-shot
 * structured findings pass over a ~1K-token outline.
 *
 * This id was once chosen to be DIFFERENT from the chat pipeline's, because
 * Gemini free-tier quotas are per-model and a reactive runner must not starve
 * the user-initiated chat agent. That isolation is GONE and its loss was
 * deliberate: on 2026-08-04 constants.ts moved DEFAULT_GEMINI_MODEL_ID to
 * this same id, so every caller now shares one bucket.
 *
 * Do not "restore" the isolation by moving this back to gemini-3.6-flash.
 * The numbers in constants.ts are why: flash-lite is 15 RPM / 500 per day
 * against 5 RPM / 20 per day for every alternative. A private 20-per-day
 * bucket is worse for this runner than a fifth of a 500-per-day one, and it
 * would cap the whole deployment at 20 chat turns to buy that. Shared and
 * large beats isolated and tiny.
 */
const PERSONA_MODEL_ID = "gemini-3.5-flash-lite";

/** Hard timeout on the one analysis call. */
const GENERATION_TIMEOUT_MS = 45_000;

/**
 * How much of each text block's words the outline shows the personas
 * (the generator's own default is 60). See the outline call for why the
 * copy-rewrite capability makes the default too narrow to be honest.
 */
const PERSONA_OUTLINE_MAX_TEXT_CHARS = 400;

/** Server backstop between runs per document (client cooldowns are the real gate). */
const MIN_RUN_INTERVAL_MS = 20_000;

/** Brief visible "reading" beat before the call — presentation smoothing only
 * (§3.5: the one theatrical liberty; the statuses themselves are real). */
const READING_BEAT_MS = 800;

/**
 * Per-persona random stagger on the reading/thinking transition writes
 * (owner feedback 2026-07-31: personas must not flip states in lockstep —
 * the same de-synchronization ask as the client-side walk randomization,
 * applied to the phase EDGES, and server-driven so every collaborator sees
 * the same offsets). Presentation smoothing only; adds ≤ ~1s to a run.
 */
const READING_STAGGER_MAX_MS = 900;
const THINKING_STAGGER_MAX_MS = 600;

/** Visible "thinking" beat for mock runs (no real model latency to show). */
const MOCK_THINKING_BEAT_MS = 1_400;

const requestBodySchema = z.object({
  documentId: z.string().min(1),
  personaSlugs: z.array(z.string().min(1)).min(1).max(8),
  /** Short human-readable note about the settled gesture(s) that triggered this run. */
  triggerSummary: z.string().max(600).optional(),
  /**
   * An explicit human "Check now" (persona-sweep.ts) rather than the ambient
   * settled-edit watcher. Explicit intent is the strongest trigger there is:
   * it bypasses the server cooldown AND the outline-unchanged skip (the user
   * wants a fresh verdict on the document AS IS). The in-flight guard still
   * applies — one batched analysis call per document at a time.
   */
  isManualSweep: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Model output schema — intent-level findings (deterministic translation to
// ops happens below, never inside the model). Lives in finding-schema.ts
// (with the long-label truncation backstop) so the reliability contract is
// unit-testable — see that module's header for why prose fields carry NO
// hard length caps.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared static persona-conduct layer (byte-identical every request — part of
// the cacheable prefix together with SYSTEM_STATIC).
// ---------------------------------------------------------------------------

const PERSONA_CONDUCT_STATIC = `## Advisory persona review

You are NOT editing this email. You are a panel of advisory reviewer personas, each defined below. The user just made an edit; review the CURRENT document as each persona and report findings.

Rules for every persona:
- Emit at most 2 findings per persona, and only issues that persona's definition genuinely covers. Zero findings is a perfectly good answer — never invent a nitpick to have something to say.
- Tag every finding with the persona's slug in personaSlug.
- In title, description, and targetBlockNames, refer to content ONLY by what the user can see ("the heading 'Spring sale'", "the button labeled 'Buy now'") — internal block ids must never appear in that prose. Put ids only in targetBlockIds, proposedEdits.blockId and proposedCopyEdits.blockId, copied exactly from the outline.
- Keep those visible-content quotes SHORT: when a label or heading is long, quote just its first few words followed by an ellipsis ("the button labeled 'Join thousands of happy…'").
- ALWAYS propose the fix itself when you can express it. A finding the user can accept in one press is worth several a user has to go and ask for.
- When the fix is a change to block properties (colors, alignment, sizes, a button's label, an image's alt text or href), include proposedEdits with the exact property values.
- When the fix is a change to the WORDS of a text block, include proposedCopyEdits: the block's id and its complete new wording as PLAIN TEXT. Write out every word the block should say afterwards, not just the part you changed, with ONE LINE per paragraph or heading the block already has, in the same order — the outline shows those pieces separated by " | ", so a block listed as \`h2|p\` takes two lines. Never write JSON or markup; the heading levels, alignment and styling are kept for you.
- Two limits on a copy rewrite, so it is never destructive: give at least as many lines as the block has pieces (a shorter rewrite would delete a paragraph and is refused), and do not rewrite a block whose outline line shows mixed inline styling on the words themselves (a +link or +bold spanning part of the text) — that formatting cannot survive a reword, so describe the change instead.
- Whenever you propose NO edits of either kind, ALSO fill suggestedPrompt: a short ready-to-send message (1-3 sentences) the user could send to their email-editing assistant to resolve the finding. Write it in the user's first-person voice ("Replace the hero image's placeholder link — help me pick a real image URL from my website."), name the content by its visible text, and make it actionable. Omit suggestedPrompt whenever you proposed any edit.
- Findings must be about the document as it is NOW (the outline below is current).`;

// ---------------------------------------------------------------------------
// In-memory run state (demo-scale, single instance — the brand-kit pattern)
// ---------------------------------------------------------------------------

interface DocumentRunState {
  lastRunStartedAtMs: number;
  /** Outline + enabled-set fingerprint of the last completed run. */
  lastRunKey: string | null;
  isRunInFlight: boolean;
}

const runStateByDocument = new Map<string, DocumentRunState>();

function getRunState(documentId: string): DocumentRunState {
  let state = runStateByDocument.get(documentId);
  if (state === undefined) {
    state = { lastRunStartedAtMs: 0, lastRunKey: null, isRunInFlight: false };
    runStateByDocument.set(documentId, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PersonaRow = {
  slug: string;
  name: string;
  color: string;
  capabilityMode: "advisory";
  personaMarkdown: string;
  cooldownSeconds: number;
};

interface RunnerFinding {
  personaSlug: string;
  personaName: string;
  personaColor: string;
  title: string;
  description: string;
  targetBlockNames: string[];
  targetBlockIds: string[];
  /** Dry-run-validated updateBlockProperties ops; empty = informational. */
  ops: Operation[];
  /**
   * Main-agent handoff (op-less findings only): a ready-to-send chat prompt,
   * in the user's voice, that asks the chat agent to resolve the finding. The
   * card/modal "Ask in chat" button inserts it into the composer — never
   * auto-sent. Absent on findings that carry ops (Apply covers those).
   */
  suggestedPrompt?: string;
}

function failureResponse({ message, status }: { message: string; status: number }): Response {
  return Response.json({ isOk: false, message }, { status });
}

function skippedResponse(skippedReason: string): Response {
  return Response.json({ isOk: true, findings: [], skippedReason });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/*
  Findings for a run that will not call a model — `x-flock-mock: 1`, a
  deployment with no key, or (since demo-mode.md stage 2) a document whose row
  says `isDemo`. Everything downstream of the call stays real: dry-run
  validation, Convex persistence, cross-tab delivery, the whole presence
  choreography.

  TWO SOURCES, in priority order, and the order is the point:

  1. THE SEEDED FIXTURE (demo-findings.ts) when the document still IS the demo
     seed email. Two recommendations written to pair with the two problems
     planted in that email, each carrying an op the visitor can apply in one
     press. This is what a stranger on /demo sees, and it has to read as
     product output rather than as scaffolding — the honesty about the run
     being scripted is delivered once, at the exit, not stamped on every card
     (see demo-findings.ts for the full argument).

  2. THE GENERIC FALLBACK for every other mocked run: one placeholder note per
     persona, each on a DIFFERENT leaf block, which exercises the choreography
     end-to-end in CI and on a fresh clone. It also covers a demo document the
     visitor has since edited out from under the fixture — better a visibly
     generic note than a confident recommendation about a paragraph that no
     longer says what the recommendation quotes.

  Real model runs never reach this function.
*/
function buildMockRunnerOutput({
  doc,
  personas,
}: {
  doc: EmailDocument;
  personas: PersonaRow[];
}): { findings: RunnerOutputFinding[]; findingSource: string } {
  const leafBlockIds = Object.entries(
    doc as Record<string, { childrenIds?: string[] } | undefined>,
  )
    .filter(
      ([blockId, block]) =>
        blockId !== ROOT_BLOCK_ID && (block?.childrenIds === undefined || block.childrenIds.length === 0),
    )
    .map(([blockId]) => blockId);
  if (leafBlockIds.length === 0) {
    return { findings: [], findingSource: "generic-mock" };
  }
  const stride = Math.max(1, Math.floor(leafBlockIds.length / personas.length));
  /*
    Which of the two sources actually served this run is decided here, where
    it is known for certain, and carried out on the return. It rides the run's
    log line so that "the demo showed a placeholder" stays diagnosable from
    the ledger without guessing at what the visitor's document looked like at
    the time — developer-facing only.
  */
  let isSeedServed = false;
  const findings = personas.map((persona, personaIndex) => {
    const seeded = selectSeededFinding({ doc, personaSlug: persona.slug });
    if (seeded !== null) {
      isSeedServed = true;
      return seeded;
    }
    return {
      personaSlug: persona.slug,
      title: `Mock note from ${persona.name}`,
      description:
        "Deterministic mock finding (x-flock-mock / no model key) — exercises the persona presence choreography without a Gemini call.",
      targetBlockNames: [`mock target ${personaIndex + 1}`],
      targetBlockIds: [
        leafBlockIds[(personaIndex * stride + 1) % leafBlockIds.length] ?? leafBlockIds[0]!,
      ],
    };
  });
  return { findings, findingSource: isSeedServed ? "demo-seed" : "generic-mock" };
}

type OpenFindingRow = FunctionReturnType<typeof api.personaFindings.listOpenFindings>[number];

/** Dismissal identity — MUST match the client's buildPatternKey (use-persona-advisors.ts). */
function buildFindingPatternKey({
  personaSlug,
  targetBlockIds,
}: {
  personaSlug: string;
  targetBlockIds: string[];
}): string {
  return `persona:${personaSlug}|${[...targetBlockIds].sort().join(",")}`;
}

/**
 * A persisted finding is stale when ANY snapshotted block drifted from this
 * run's doc (or vanished). Checks every `targetSnapshots` key — that map
 * covers the ops' blocks too, so fresh ⇒ the stored ops still apply.
 */
function isFindingStale({ doc, row }: { doc: EmailDocument; row: OpenFindingRow }): boolean {
  return Object.entries(row.targetSnapshots).some(([blockId, snapshot]) => {
    const block = doc[blockId as keyof EmailDocument];
    return block === undefined || stableStringify(block) !== snapshot;
  });
}

/**
 * §5.6b turn-input dedup: a persona sees its own (and its peers') still-open
 * findings so it never re-flags what it already flagged. PER-REQUEST content —
 * this string may only ever be appended in the fresh-tokens-last position.
 */
function buildOpenFindingsContext(rows: OpenFindingRow[]): string | null {
  if (rows.length === 0) {
    return null;
  }
  const lines = rows.map(
    (row) =>
      `- [${row.personaSlug}] ${row.title} (about: ${row.targetBlockIds.join(", ")})`,
  );
  return [
    "Findings already reported and still open — do NOT re-report these or minor variations of them; only report genuinely new issues:",
    ...lines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return failureResponse({ status: 400, message: "Request body must be JSON." });
  }
  const parsedBody = requestBodySchema.safeParse(json);
  if (!parsedBody.success) {
    return failureResponse({ status: 400, message: "Expected { documentId, personaSlugs }." });
  }
  const { documentId, personaSlugs, triggerSummary } = parsedBody.data;
  const isManualSweep = parsedBody.data.isManualSweep === true;

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (convexUrl === undefined) {
    return failureResponse({ status: 500, message: "Convex is not configured." });
  }
  const convexClient = new ConvexHttpClient(convexUrl);

  // THE DOCUMENT IS FETCHED FIRST, before anything is decided about this run,
  // because the row is what decides. `isDemo` is a spend authority
  // (lib/demo/mock-authority.ts): /demo is a public link, and if the mock it
  // depends on were requested by the client — which is all stage 1 could do —
  // then stripping one header off the request would spend the deployment's
  // shared Gemini quota through a URL published for strangers.
  //
  // COSTING NOTHING EXTRA, deliberately. This route already had to read the
  // document to build the outline, so the forced-mock verdict rides on a fetch
  // that was happening anyway — no second round trip, no new query. That is
  // also why the fetch moved ABOVE the credit charge rather than the flag
  // being looked up separately below it.
  const document = await convexClient.query(api.documents.getDocumentByKey, {
    documentKey: documentId,
  });
  if (document === null) {
    return failureResponse({ status: 404, message: "That document does not exist." });
  }
  const isDemoDocument = document.isDemo === true;

  const isMockRun =
    selectIsMockForced({
      isDemoDocument,
      isMockRequestedByClient: request.headers.get(MOCK_MODEL_HEADER) === "1",
    }) || !process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  // AI ALLOWANCE (convex/authCredits.ts). Only a MANUAL sweep costs a credit:
  // a human clicked, so they asked for this. The ambient trigger fires off the
  // op log without anyone asking, and charging a person for work they did not
  // request would make their balance unpredictable and punish them for
  // editing. The ambient path is throttled instead by the per-persona cooldown
  // and the server backstops below — a cooldown throttles the system, a credit
  // throttles a person.
  //
  // Resolved BEFORE the charge, not at the model call: a run that will spend no
  // provider quota must not bill a person for work nobody paid for — that would
  // empty a demo visitor's whole allowance on a scripted run, or charge on a
  // deployment with no API key configured at all. `chargeCreditForRequest`
  // already short-circuits on that flag; this route simply was not telling it.
  // A demo document therefore never spends a credit, whether or not its client
  // remembered to ask for the mock.
  //
  // THE CHARGE READS A NARROWER FLAG THAN THE MODEL CALL DOES, and the gap
  // between the two flags is the whole point of there being two. `isMockRun`
  // above folds in `x-flock-mock: 1` (MOCK_MODEL_HEADER) — a header the CLIENT
  // chooses to send. The exemption below folds in only what the SERVER
  // established for itself: the document row said `isDemo`, or this deployment
  // has no GOOGLE_GENERATIVE_AI_API_KEY at all. Those are the two runs the
  // server can vouch for as free; a header is not one of them.
  //
  // It matters here more than anywhere else on this route because a manual
  // sweep has deliberately given up the other backstops: it skips the server
  // cooldown and the outline-unchanged skip below, on the grounds that
  // explicit human intent deserves a fresh verdict. The credit is then the
  // ONLY throttle left standing, and a client must not be able to talk its way
  // out of the only throttle a manual sweep has — sending one header would
  // otherwise strip every limit on the route at once, and the writes a sweep
  // makes (findings rows, presence churn, invocations) are real whether or not
  // a model was called.
  //
  // The header keeps its real meaning everywhere else (see the model call and
  // the run's log line): a caller who sends it still gets the deterministic
  // mock and no Gemini call. It just pays a credit for the run it asked for.
  const isFreeRunTheServerVouchesFor =
    isDemoDocument || !process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (isManualSweep) {
    const charge = await chargeCreditForRequest({
      request,
      isMockRun: isFreeRunTheServerVouchesFor,
    });
    if (!charge.isAllowed) {
      return failureResponse({ status: 429, message: charge.message });
    }
  }

  // CAPABILITY ENFORCEMENT (proposal §4.6): only registry rows run, and only
  // advisory ones — which is every row the v0 schema can hold. This filter is
  // the guard that stays when v1 widens capabilityMode.
  const personas = (
    await convexClient.query(api.personas.getPersonasBySlugs, { slugs: [...personaSlugs] })
  ).filter((persona): persona is PersonaRow => persona.capabilityMode === "advisory");
  if (personas.length === 0) {
    return failureResponse({ status: 400, message: "No known advisory personas were requested." });
  }

  const doc = document.doc as EmailDocument;
  // Depth "full": every explicitly-set property as key=value. The default
  // "blocks" depth omits styling props (a button line is just label+href),
  // which would blind the Styling Recommender AND make the outline-unchanged
  // skip treat pure styling edits as no-ops. Still compact (~1 line/block).
  //
  // maxTextChars is raised well past the outline default (60) because the
  // personas may now propose COPY REWRITES, and a reviewer that can read the
  // first 60 characters of a paragraph cannot honestly rewrite it — it would
  // be rewriting around an ellipsis. Cost is bounded and small: a few hundred
  // extra characters on the handful of text blocks in an email, paid once per
  // run, in the fresh-tokens-last position that was never cacheable anyway.
  const outline = generateDocumentOutline({
    doc,
    options: { depth: "full", maxTextChars: PERSONA_OUTLINE_MAX_TEXT_CHARS },
  });
  const enabledKey = personas.map((persona) => persona.slug).join(",");
  const runKey = `${enabledKey}\n${outline}`;

  // Server-side budget backstops (the client gates per-persona cooldowns).
  const runState = getRunState(documentId);
  const now = Date.now();
  if (runState.isRunInFlight) {
    return skippedResponse("run-in-flight");
  }
  // A manual sweep (explicit human intent) skips the budget backstops that
  // exist to tame the AMBIENT trigger; the in-flight guard above still holds.
  if (!isManualSweep) {
    if (now - runState.lastRunStartedAtMs < MIN_RUN_INTERVAL_MS) {
      return skippedResponse("server-cooldown");
    }
    if (runState.lastRunKey === runKey) {
      return skippedResponse("outline-unchanged");
    }
  }
  runState.isRunInFlight = true;
  runState.lastRunStartedAtMs = now;
  // One id for this sweep — shared by the model-call record, any failure
  // record, and the budget ledger line below.
  const traceId = createTraceId();

  const setStatusForAll = async (
    status: "idle" | "reading" | "thinking",
    { staggerMaxMs = 0 }: { staggerMaxMs?: number } = {},
  ): Promise<void> => {
    await Promise.all(
      personas.map(async (persona) => {
        // Per-persona random offset on the transition write (see the
        // READING/THINKING_STAGGER constants): the personas stop flipping
        // states in lockstep, and because the offset rides the presence
        // WRITE, every collaborator sees the same de-synced edges.
        if (staggerMaxMs > 0) {
          await sleep(Math.random() * staggerMaxMs);
        }
        await convexClient.mutation(api.personas.setPersonaStatus, {
          documentId: document.documentId,
          slug: persona.slug,
          status,
        });
      }),
    );
  };

  try {
    // Status choreography: reading (context assembly) → thinking (call in
    // flight) → idle. Transition-only presence writes (§3.5), with random
    // per-persona stagger so the personas never move in lockstep.
    await setStatusForAll("reading", { staggerMaxMs: READING_STAGGER_MAX_MS });

    // Persisted-findings maintenance (the real "reading" work): prune open
    // rows whose target blocks drifted since they were recorded (they die
    // quietly — §5.6), and keep the fresh ones as dedup context (§5.6b).
    const openFindingRows = await convexClient.query(api.personaFindings.listOpenFindings, {
      documentId: document.documentId,
    });
    const staleFindingIds = openFindingRows
      .filter((row) => isFindingStale({ doc, row }))
      .map((row) => row.findingId);
    if (staleFindingIds.length > 0) {
      await convexClient.mutation(api.personaFindings.pruneStaleFindings, {
        documentId: document.documentId,
        findingIds: staleFindingIds,
      });
    }
    const openFindingsContext = buildOpenFindingsContext(
      openFindingRows.filter((row) => !staleFindingIds.includes(row.findingId)),
    );

    await sleep(READING_BEAT_MS);

    // Cache-ordered prompt (§3.4): [shared static ‖ persona layer] as the
    // system message — stable per enabled set — and ALL per-request content
    // (outline, trigger) in the user message, always last.
    const personaLayer = personas
      .map((persona) => `## Persona: ${persona.name} (slug: ${persona.slug})\n\n${persona.personaMarkdown}`)
      .join("\n\n");
    const system = [SYSTEM_STATIC, PERSONA_CONDUCT_STATIC, personaLayer].join("\n\n");
    const prompt = [
      "Current document outline:",
      "```",
      outline,
      "```",
      triggerSummary !== undefined ? `What just happened: ${triggerSummary}` : null,
      openFindingsContext,
      "Review the document as each persona and return your findings.",
    ]
      .filter((part): part is string => part !== null)
      .join("\n\n");

    await setStatusForAll("thinking", { staggerMaxMs: THINKING_STAGGER_MAX_MS });
    // The chat route's mock convention (resolved at the top of the handler,
    // because the credit charge depends on it): `x-flock-mock: 1` forces the
    // deterministic mock, and an absent key falls back to it — the whole
    // downstream pipeline (dry-run, persistence, statuses) stays real.
    const telemetryContext: ModelTelemetryContext = {
      operation: "personas.review",
      traceId,
      isMock: isMockRun,
    };
    let object: { findings: RunnerOutputFinding[] };
    let mockFindingSource: string | null = null;
    let usage: unknown;
    if (isMockRun) {
      await sleep(MOCK_THINKING_BEAT_MS); // a visible thinking beat to watch
      const mock = buildMockRunnerOutput({ doc, personas });
      object = { findings: mock.findings };
      mockFindingSource = mock.findingSource;
    } else {
      const generated = await generateObject({
        model: google(PERSONA_MODEL_ID),
        schema: runnerOutputSchema,
        system,
        prompt,
        abortSignal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
        telemetry: modelTelemetryFor(telemetryContext),
      });
      object = generated.object;
      usage = generated.usage;
    }

    const personasBySlug = new Map(personas.map((persona) => [persona.slug, persona]));
    const findings: RunnerFinding[] = [];
    // Truncation backstop (finding-schema.ts): one wordy label must never
    // cost the run, and stored findings must stay card-sized.
    for (const finding of object.findings.map(truncateFindingProse)) {
      const persona = personasBySlug.get(finding.personaSlug);
      if (persona === undefined) {
        continue; // hallucinated slug — drop
      }
      const knownTargetBlockIds = finding.targetBlockIds.filter(
        (blockId) => doc[blockId as keyof EmailDocument] !== undefined,
      );
      if (knownTargetBlockIds.length === 0) {
        continue; // finding points at nothing real — drop
      }
      // The fix, whichever shape the persona expressed it in: scalar property
      // values, plain-text copy rewrites, or both at once. finding-ops.ts
      // translates them into real operations and dry-runs the whole batch
      // against THIS run's doc, so a fix that would not apply becomes an
      // informational finding rather than a broken Apply button. The demo
      // fixture goes through the identical path — it is written in the same
      // model-facing shape and gets no special trust.
      const ops = composeFindingOps({
        doc,
        proposedEdits: finding.proposedEdits,
        proposedCopyEdits: finding.proposedCopyEdits,
      });
      // The handoff prompt rides along ONLY while the finding is op-less
      // (informational — including the dry-run-failed degradation): a finding
      // with live ops is served by Apply, and the two CTAs never coexist.
      const validatedOps = ops ?? [];
      const suggestedPrompt =
        validatedOps.length === 0 && finding.suggestedPrompt !== undefined
          ? finding.suggestedPrompt
          : undefined;
      findings.push({
        personaSlug: persona.slug,
        personaName: persona.name,
        personaColor: persona.color,
        title: finding.title,
        description: finding.description,
        targetBlockNames: finding.targetBlockNames,
        targetBlockIds: knownTargetBlockIds,
        // ops === null → the dry-run failed → informational fallback.
        ops: validatedOps,
        ...(suggestedPrompt !== undefined ? { suggestedPrompt } : {}),
      });
    }

    runState.lastRunKey = runKey;

    // PERSIST the surviving findings (cross-tab/collab visibility — the
    // clients' reactive listOpenFindings query does the rest). Snapshots are
    // taken from THIS run's `doc` — the exact doc the ops were dry-run
    // against — and cover the ops' blocks as well as the finding's declared
    // targets, so any drift that could invalidate the ops reads as stale.
    if (findings.length > 0) {
      await convexClient.mutation(api.personaFindings.recordFindings, {
        documentId: document.documentId,
        findings: findings.map((finding) => {
          const snapshotBlockIds = new Set(finding.targetBlockIds);
          for (const op of finding.ops) {
            if ("blockId" in op && typeof op.blockId === "string") {
              snapshotBlockIds.add(op.blockId);
            }
          }
          return {
            personaSlug: finding.personaSlug,
            personaName: finding.personaName,
            personaColor: finding.personaColor,
            patternKey: buildFindingPatternKey({
              personaSlug: finding.personaSlug,
              targetBlockIds: finding.targetBlockIds,
            }),
            title: finding.title,
            description: finding.description,
            targetBlockNames: finding.targetBlockNames,
            targetBlockIds: finding.targetBlockIds,
            ops: finding.ops,
            ...(finding.suggestedPrompt !== undefined
              ? { suggestedPrompt: finding.suggestedPrompt }
              : {}),
            targetSnapshots: Object.fromEntries(
              [...snapshotBlockIds].map((blockId) => [
                blockId,
                stableStringify(doc[blockId as keyof EmailDocument]),
              ]),
            ),
          };
        }),
      });
    }

    // Back to idle; each persona's block-presence chrome points at its top
    // finding's first target block (BlockPresenceIndicator lights up free).
    await Promise.all(
      personas.map((persona) => {
        const topFinding = findings.find((finding) => finding.personaSlug === persona.slug);
        return convexClient.mutation(api.personas.setPersonaStatus, {
          documentId: document.documentId,
          slug: persona.slug,
          status: "idle",
          ...(topFinding !== undefined
            ? { selectedBlockId: topFinding.targetBlockIds[0]! }
            : {}),
        });
      }),
    );

    // The budget ledger line (plan §4.4 cost-logging convention). THE LOG
    // STAYS BLUNT ABOUT THE MOCK even though the visitor-facing surfaces no
    // longer are: `isMock`, `isDemoDocument` and `findingSource` are how an
    // operator tells a scripted run from a real one after the fact, and the
    // whole point of moving the disclosure to /demo's exit was to stop
    // shouting at the visitor — not to stop recording.
    logRecord({
      tag: "flock.personas.request",
      traceId,
      model: PERSONA_MODEL_ID,
      isMock: isMockRun,
      isDemoDocument,
      ...(mockFindingSource !== null ? { findingSource: mockFindingSource } : {}),
      personaSlugs: personas.map((persona) => persona.slug),
      findingCount: findings.length,
      usage,
    });

    /* The same model verdict the log line above carries, on the wire — see
       MODEL_RESPONSE_HEADER. Only the success response names a model, because
       it is the only one that ran (or deliberately did not run) one. */
    return Response.json(
      { isOk: true, findings, usage },
      { headers: { [MODEL_RESPONSE_HEADER]: isMockRun ? MOCK_MODEL_ID : PERSONA_MODEL_ID } },
    );
  } catch (error) {
    const summary = summarizeError(error);
    logFailure({
      tag: "flock.personas.failed",
      traceId,
      model: PERSONA_MODEL_ID,
      errorCode: summary.code,
      errorName: summary.name,
      statusCode: summary.statusCode,
      message: summary.message,
    });
    await setStatusForAll("idle").catch(() => undefined);
    return failureResponse({
      status: 502,
      message: "The persona review call failed — the next settled edit will retry.",
    });
  } finally {
    runState.isRunInFlight = false;
  }
}
