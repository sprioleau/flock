import { google } from "@ai-sdk/google";
import { generateText, type ToolSet } from "ai";

/**
 * The Phase 7.4(b) public-web search fan-out.
 *
 * What it returns is deliberately NOT prose: a list of CLAIMS, each already
 * bound to the page it came from. The person pipeline turns those straight
 * into `facts` with `sourceUrl`s, which is what makes the "never paraphrase
 * into fabrication" rule enforceable downstream — the model is handed
 * attributed statements, not a research summary to embroider.
 *
 * Provider: Gemini with Google Search grounding. The grounding metadata gives
 * exactly the shape we want — `groundingChunks` (source URI + title) and
 * `groundingSupports` (the sentence, plus which chunks support it). We keep
 * only supported sentences; unsupported model prose is discarded on purpose.
 *
 * QUOTA DISCIPLINE (owner law): searching costs a live model call, so it is
 * OFF unless explicitly switched on with FLOCK_ENABLE_WEB_SEARCH=1 and a real
 * key is present. Otherwise this returns `unavailable`, and the person
 * pipeline composes from the profile page alone and SAYS so. It never
 * substitutes invented results — a mock that fabricated facts about a real
 * person would violate the very rule this feature exists to honor.
 */

/** Model used for grounded search — the cheap flash tier, its own quota bucket. */
export const SEARCH_GROUNDING_MODEL_ID = "gemini-3.5-flash-lite";

/** Hard cap on claims returned, so one search can't flood the model loop. */
const MAX_CLAIMS = 8;

/** Hard cap on distinct sources returned. */
const MAX_SOURCES = 6;

const SEARCH_TIMEOUT_MS = 20_000;

/** One sentence from the search, with the page that supports it. */
export interface SearchClaim {
  text: string;
  sourceUrl: string;
  sourceTitle: string;
}

export interface SearchSource {
  title: string;
  url: string;
}

export type WebSearchOutcome =
  | { status: "searched"; claims: SearchClaim[]; sources: SearchSource[] }
  | { status: "no_results" }
  | { status: "unavailable" };

export interface SearchPublicWebInput {
  /** What to search for, in plain language. */
  query: string;
  /**
   * True when the caller is running against the deterministic mock tier. Mock
   * runs NEVER search: no live call, and no invented results either.
   */
  isMockRun?: boolean;
}

/** True when a live, grounded search is both possible and permitted. */
export function isWebSearchEnabled(): boolean {
  return (
    process.env.FLOCK_ENABLE_WEB_SEARCH === "1" &&
    Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY)
  );
}

interface GroundingChunk {
  web?: { uri: string; title?: string | null } | null;
}

interface GroundingSupport {
  segment?: { text?: string | null } | null;
  segment_text?: string | null;
  groundingChunkIndices?: number[] | null;
}

interface GroundingMetadata {
  groundingChunks?: GroundingChunk[] | null;
  groundingSupports?: GroundingSupport[] | null;
}

/** Pull the grounding metadata off a generateText result, or null. */
function readGroundingMetadata(providerMetadata: unknown): GroundingMetadata | null {
  if (typeof providerMetadata !== "object" || providerMetadata === null) {
    return null;
  }
  const googleMetadata = (providerMetadata as Record<string, unknown>).google;
  if (typeof googleMetadata !== "object" || googleMetadata === null) {
    return null;
  }
  const grounding = (googleMetadata as Record<string, unknown>).groundingMetadata;
  return typeof grounding === "object" && grounding !== null
    ? (grounding as GroundingMetadata)
    : null;
}

/** Turn grounding metadata into attributed claims + the sources behind them. */
export function toAttributedClaims(metadata: GroundingMetadata): {
  claims: SearchClaim[];
  sources: SearchSource[];
} {
  const chunks = metadata.groundingChunks ?? [];
  const supports = metadata.groundingSupports ?? [];
  const claims: SearchClaim[] = [];
  const sourceByUrl = new Map<string, SearchSource>();

  for (const support of supports) {
    const text = (support.segment?.text ?? support.segment_text ?? "").trim();
    const chunkIndices = support.groundingChunkIndices ?? [];
    if (text.length < 20 || chunkIndices.length === 0) {
      continue; // unsupported or too short to be a usable claim
    }
    const firstChunk = chunks[chunkIndices[0]];
    const uri = firstChunk?.web?.uri;
    if (uri === undefined || uri === null || uri.length === 0) {
      continue;
    }
    const title = firstChunk?.web?.title ?? new URL(uri).hostname;
    if (!sourceByUrl.has(uri)) {
      sourceByUrl.set(uri, { title, url: uri });
    }
    if (claims.some((claim) => claim.text === text)) {
      continue;
    }
    claims.push({ text, sourceUrl: uri, sourceTitle: title });
    if (claims.length >= MAX_CLAIMS) {
      break;
    }
  }
  return { claims, sources: [...sourceByUrl.values()].slice(0, MAX_SOURCES) };
}

/**
 * Search the public web and return attributed claims. Returns `unavailable`
 * (never a guess) when search is switched off, when this is a mock run, or
 * when the provider call fails.
 */
export async function searchPublicWeb({
  query,
  isMockRun = false,
}: SearchPublicWebInput): Promise<WebSearchOutcome> {
  if (isMockRun || !isWebSearchEnabled()) {
    return { status: "unavailable" };
  }
  try {
    const result = await generateText({
      model: google(SEARCH_GROUNDING_MODEL_ID),
      // The provider-executed search tool: Google runs it, we only read the
      // grounding metadata it attaches. Widened to ToolSet because a
      // provider-executed tool has no client-side input schema to infer.
      tools: { google_search: google.tools.googleSearch({}) } as ToolSet,
      abortSignal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      prompt: `Search the public web and state, in short separate sentences, the verifiable public facts about: ${query}. Only state what the sources say. Do not speculate, and do not include personal contact details, home addresses, or anything about their private life.`,
    });
    const metadata = readGroundingMetadata(result.providerMetadata);
    if (metadata === null) {
      return { status: "no_results" };
    }
    const { claims, sources } = toAttributedClaims(metadata);
    return claims.length === 0 ? { status: "no_results" } : { status: "searched", claims, sources };
  } catch (error) {
    console.error("[content-ingestion] public-web search failed:", error);
    return { status: "unavailable" };
  }
}
