import { google } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
// `resolveChatProviderId` carries DEFAULT_CHAT_PROVIDER_ID (Gemini) as its
// fallback, so the default lives in exactly one place — there, not here.
import { resolveChatProviderId, type ChatProviderId } from "@/lib/chat-provider";
import {
  DEFAULT_GEMINI_MODEL_ID,
  DEFAULT_OPENROUTER_MODEL_ID,
  MOCK_MODEL_ID,
} from "./constants";

/**
 * THE model-selection decision for a chat turn — the one place that answers
 * "which provider, which model id, and is this a mock run?".
 *
 * Why it is its own module: the route used to make this decision inline, and
 * the moment a second provider existed the inline version tangled three
 * unrelated questions (is the caller privileged, is a key configured, is this
 * a test) into one boolean expression. Pulling it out makes each rule
 * separately testable — in particular the SECURITY rule below, which is the
 * only one here that can cost the owner money if it regresses.
 *
 * ---------------------------------------------------------------------------
 * The rules, in the order they apply
 * ---------------------------------------------------------------------------
 *
 * 1. `x-flock-mock: 1` wins outright. CI and the unit suite never need a key
 *    and never spend one. (chat-contract.ts owns the header name.)
 *
 * 2. The DEPLOYMENT default provider comes from FLOCK_CHAT_PROVIDER, parsed
 *    through `resolveChatProviderId` so an unset or mistyped value degrades to
 *    Gemini instead of breaking the turn.
 *
 * 3. The REQUEST's `providerId` is honoured ONLY for a caller holding a valid
 *    owner override. This is a security property, not a preference: the
 *    provider id arrives on the wire from the browser, and without this gate
 *    any anonymous visitor could choose which of the owner's API keys their
 *    turn spends. Without the override the request's preference is ignored
 *    ENTIRELY — not merged, not used as a tiebreak.
 *
 * 4. A provider with no API key cannot be selected. An unset key means the
 *    provider is UNAVAILABLE, never "the empty string works" — a client built
 *    with `apiKey: ""` fails at the edge of the network with an opaque 401
 *    instead of falling back cleanly here. Selection falls through to the
 *    other provider if IT has a key, and to the deterministic mock if neither
 *    does.
 *
 * The returned `modelId` is always the REAL id in play (never ""), because the
 * pipeline's latency log line is the only record of which model ran.
 */

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Env vars this module reads. Collected here so the deployment checklist has
 * one source of truth:
 *
 * - `FLOCK_CHAT_PROVIDER`         — "gemini" | "openrouter". The deployment
 *                                   default. Unset or unrecognised → Gemini.
 * - `GOOGLE_GENERATIVE_AI_API_KEY`— Gemini's key. Unset → Gemini unavailable.
 * - `OPENROUTER_API_KEY`          — OpenRouter's key. Unset → unavailable.
 * - `OPENROUTER_MODEL_ID`         — overrides {@link DEFAULT_OPENROUTER_MODEL_ID}.
 *                                   Unset → the default constant.
 *
 * With NO key of either kind configured, every turn runs the deterministic
 * mock — which is exactly how the test suite and a fresh clone behave.
 */
const PROVIDER_ENV_VARS = {
  chatProvider: "FLOCK_CHAT_PROVIDER",
  geminiApiKey: "GOOGLE_GENERATIVE_AI_API_KEY",
  openRouterApiKey: "OPENROUTER_API_KEY",
  openRouterModelId: "OPENROUTER_MODEL_ID",
} as const;

/**
 * An env var's value, or undefined when it is absent OR blank. Vercel keeps
 * a variable you have cleared as an empty string rather than removing it, so
 * "" has to mean the same thing as unset everywhere in this module.
 */
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

function getApiKey(providerId: ChatProviderId): string | undefined {
  return providerId === "gemini"
    ? readEnv(PROVIDER_ENV_VARS.geminiApiKey)
    : readEnv(PROVIDER_ENV_VARS.openRouterApiKey);
}

/** The other member of the pair — the fallback candidate. */
function getAlternateProviderId(providerId: ChatProviderId): ChatProviderId {
  return providerId === "gemini" ? "openrouter" : "gemini";
}

// ---------------------------------------------------------------------------
// Selection (pure: no clients constructed)
// ---------------------------------------------------------------------------

/** "mock" is a real outcome of selection, not a provider the owner can pick. */
export type ResolvedChatProviderId = ChatProviderId | "mock";

export interface ChatProviderSelection {
  providerId: ResolvedChatProviderId;
  /** The real model id that will run. Never "". */
  modelId: string;
  isUsingMockModel: boolean;
}

export interface ResolveChatModelArgs {
  /** The provider the CLIENT asked for. A request, honoured only for an owner. */
  requestedProviderId: ChatProviderId | undefined;
  /** Does this caller hold a valid owner override? (lib/auth/owner-override.ts) */
  hasOwnerOverride: boolean;
  /** Did the request carry `x-flock-mock: 1`? */
  isMockForced: boolean;
}

function getModelId(providerId: ChatProviderId): string {
  return providerId === "gemini"
    ? DEFAULT_GEMINI_MODEL_ID
    : (readEnv(PROVIDER_ENV_VARS.openRouterModelId) ?? DEFAULT_OPENROUTER_MODEL_ID);
}

const MOCK_SELECTION: ChatProviderSelection = {
  providerId: "mock",
  modelId: MOCK_MODEL_ID,
  isUsingMockModel: true,
};

/**
 * Decide which provider runs this turn, WITHOUT building anything. Exported
 * separately from {@link resolveChatModel} because the route needs the mock
 * verdict before it charges a credit (mock runs are free), and because every
 * rule above is assertable against this return value alone.
 */
export function selectChatProvider(args: ResolveChatModelArgs): ChatProviderSelection {
  if (args.isMockForced) {
    return MOCK_SELECTION;
  }

  const deploymentDefaultId = resolveChatProviderId(readEnv(PROVIDER_ENV_VARS.chatProvider));

  // Rule 3. Note the order: `hasOwnerOverride` is checked FIRST, so an
  // unprivileged request's providerId never even reaches this expression.
  const preferredId =
    args.hasOwnerOverride && args.requestedProviderId !== undefined
      ? args.requestedProviderId
      : deploymentDefaultId;

  // Rule 4. Prefer the chosen provider, then the other one, then the mock.
  const availableId = [preferredId, getAlternateProviderId(preferredId)].find(
    (candidateId) => getApiKey(candidateId) !== undefined,
  );
  if (availableId === undefined) {
    return MOCK_SELECTION;
  }

  return {
    providerId: availableId,
    modelId: getModelId(availableId),
    isUsingMockModel: false,
  };
}

// ---------------------------------------------------------------------------
// Model construction
// ---------------------------------------------------------------------------

export interface ResolvedChatModel extends ChatProviderSelection {
  model: LanguageModel;
}

export interface CreateChatModelArgs extends ResolveChatModelArgs {
  /**
   * Builds the deterministic mock model. A thunk, not a value, for two
   * reasons: the mock is expensive to describe (it needs the last user turn,
   * the selection, and the document's root section count) and it must not be
   * built for the turns that will not use it. Keeping it a callback also keeps
   * this module free of any dependency on mock-model.ts.
   */
  createMockModel: () => LanguageModel;
}

/**
 * The whole model decision, materialised. `route.ts` calls this once and uses
 * the result verbatim — there is no provider logic left in the route.
 *
 * Neither provider client is constructed unless it is the one being used:
 * `createOpenRouter` in particular reads config eagerly, so building it on a
 * Gemini turn would be pure waste (and, with an unset key, a client that
 * cannot work).
 */
export function resolveChatModel(args: CreateChatModelArgs): ResolvedChatModel {
  const selection = selectChatProvider({
    requestedProviderId: args.requestedProviderId,
    hasOwnerOverride: args.hasOwnerOverride,
    isMockForced: args.isMockForced,
  });

  if (selection.providerId === "mock") {
    return { ...selection, model: args.createMockModel() };
  }

  if (selection.providerId === "gemini") {
    // @ai-sdk/google reads GOOGLE_GENERATIVE_AI_API_KEY itself; selection has
    // already established it is set.
    return { ...selection, model: google(selection.modelId) };
  }

  // The key is non-empty here by construction — `selectChatProvider` will not
  // return "openrouter" otherwise — so the `?? ""` the spike carried is gone.
  const openRouter = createOpenRouter({ apiKey: getApiKey("openrouter") });

  // NO `models: [...]` routing-fallback list, deliberately. OpenRouter would
  // silently run a DIFFERENT model on an error, while `selection.modelId` —
  // the only thing the pipeline logs — kept naming the first one. On a
  // free-tier model that misroute would be common, not rare, and untraceable.
  // If fallbacks are wanted later, add a named constant of ids verified
  // against https://openrouter.ai/api/v1/models and report the id that
  // actually served the turn.
  return { ...selection, model: openRouter.chat(selection.modelId) };
}
