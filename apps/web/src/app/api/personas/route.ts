import { google } from "@ai-sdk/google";
import {
  generateDocumentOutline,
  SYSTEM_STATIC,
} from "@tandem/agent";
import {
  applyOperations,
  updateBlockPropertiesOperationSchema,
  type EmailDocument,
  type Operation,
} from "@tandem/email-sdk";
import { generateObject } from "ai";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { z } from "zod";
import { api } from "@convex/_generated/api";
import { stableStringify } from "@/lib/suggestions/serialize-block";
import { proposedEditSchema, runnerOutputSchema, truncateFindingProse } from "./finding-schema";

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
 * intent-level property edits ({blockId, property, value} — the
 * llm-tool-interface principle: simple args, deterministic translation to
 * `updateBlockProperties` ops inside this route), and every op batch is
 * DRY-RUN through the SDK's pure `applyOperations` before it is surfaced;
 * findings whose ops fail the dry-run degrade to informational. Personas
 * never dispatch anything — findings become source:"analysis" suggestions
 * client-side, and only a human clicking Apply writes to the document.
 *
 * Budget discipline (§5.1): per-persona cooldowns gate client-side; this
 * route adds a per-document minimum interval and an outline-unchanged skip
 * as server backstops, plus a `tandem.personas.request` JSON log line so
 * tokens-per-run stay observable.
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
 * Model for the batched persona analysis call. Deliberately NOT the chat
 * pipeline's DEFAULT_GEMINI_MODEL_ID ("gemini-3.6-flash"): Gemini free-tier
 * daily quotas are per-model, and the reactive runner must never starve the
 * user-initiated chat agent (the brand-kit pipeline set this precedent —
 * see generate-brand-kit.ts). 3.5-flash-lite is plenty for a one-shot
 * structured findings pass over a ~1K-token outline.
 */
const PERSONA_MODEL_ID = "gemini-3.5-flash-lite";

/** Hard timeout on the one analysis call. */
const GENERATION_TIMEOUT_MS = 45_000;

/** Server backstop between runs per document (client cooldowns are the real gate). */
const MIN_RUN_INTERVAL_MS = 20_000;

/** Brief visible "reading" beat before the call — presentation smoothing only
 * (§3.5: the one theatrical liberty; the statuses themselves are real). */
const READING_BEAT_MS = 800;

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
- In title, description, and targetBlockNames, refer to content ONLY by what the user can see ("the heading 'Spring sale'", "the button labeled 'Buy now'") — internal block ids must never appear in that prose. Put ids only in targetBlockIds and proposedEdits.blockId, copied exactly from the outline.
- Keep those visible-content quotes SHORT: when a label or heading is long, quote just its first few words followed by an ellipsis ("the button labeled 'Join thousands of happy…'").
- When the fix is a change to block properties (colors, alignment, sizes, a button label), include proposedEdits with the exact property values. When the fix is rewording copy, put the suggested rewrite in the description instead and omit proposedEdits.
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
}

function failureResponse({ message, status }: { message: string; status: number }): Response {
  return Response.json({ isOk: false, message }, { status });
}

function skippedResponse(skippedReason: string): Response {
  return Response.json({ isOk: true, findings: [], skippedReason });
}

/** Deterministic coercion of the model's string values to property scalars. */
function coercePropertyValue(raw: string): string | number | boolean {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

/**
 * Intent-level edits → validated `updateBlockProperties` ops (grouped per
 * block), dry-run against the current doc. Null when anything fails — the
 * finding then surfaces as informational instead of carrying broken ops.
 */
function composeFindingOps({
  doc,
  proposedEdits,
}: {
  doc: EmailDocument;
  proposedEdits: z.infer<typeof proposedEditSchema>[];
}): Operation[] | null {
  const propertiesByBlockId = new Map<string, Record<string, unknown>>();
  for (const edit of proposedEdits) {
    const properties = propertiesByBlockId.get(edit.blockId) ?? {};
    properties[edit.property] = coercePropertyValue(edit.value);
    propertiesByBlockId.set(edit.blockId, properties);
  }
  const ops: Operation[] = [];
  for (const [blockId, properties] of propertiesByBlockId) {
    const parsed = updateBlockPropertiesOperationSchema.safeParse({
      name: "updateBlockProperties",
      blockId,
      properties,
    });
    if (!parsed.success) {
      return null;
    }
    ops.push(parsed.data);
  }
  return applyOperations(doc, ops).isOk ? ops : null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

  const document = await convexClient.query(api.documents.getDocumentByKey, {
    documentKey: documentId,
  });
  if (document === null) {
    return failureResponse({ status: 404, message: "That document does not exist." });
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
  const outline = generateDocumentOutline({ doc, options: { depth: "full" } });
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

  const setStatusForAll = async (status: "idle" | "reading" | "thinking"): Promise<void> => {
    await Promise.all(
      personas.map((persona) =>
        convexClient.mutation(api.personas.setPersonaStatus, {
          documentId: document.documentId,
          slug: persona.slug,
          status,
        }),
      ),
    );
  };

  try {
    // Status choreography: reading (context assembly) → thinking (call in
    // flight) → idle. Transition-only presence writes (§3.5).
    await setStatusForAll("reading");

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

    await setStatusForAll("thinking");
    const { object, usage } = await generateObject({
      model: google(PERSONA_MODEL_ID),
      schema: runnerOutputSchema,
      system,
      prompt,
      abortSignal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    });

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
      const ops =
        finding.proposedEdits !== undefined && finding.proposedEdits.length > 0
          ? composeFindingOps({ doc, proposedEdits: finding.proposedEdits })
          : [];
      findings.push({
        personaSlug: persona.slug,
        personaName: persona.name,
        personaColor: persona.color,
        title: finding.title,
        description: finding.description,
        targetBlockNames: finding.targetBlockNames,
        targetBlockIds: knownTargetBlockIds,
        // ops === null → the dry-run failed → informational fallback.
        ops: ops ?? [],
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

    // The budget ledger line (plan §4.4 cost-logging convention).
    console.log(
      JSON.stringify({
        tag: "tandem.personas.request",
        model: PERSONA_MODEL_ID,
        personaSlugs: personas.map((persona) => persona.slug),
        findingCount: findings.length,
        usage,
      }),
    );

    return Response.json({ isOk: true, findings, usage });
  } catch (error) {
    console.error("[personas] runner failed:", error);
    await setStatusForAll("idle").catch(() => undefined);
    return failureResponse({
      status: 502,
      message: "The persona review call failed — the next settled edit will retry.",
    });
  } finally {
    runState.isRunInFlight = false;
  }
}
