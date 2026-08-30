import type { LanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_GEMINI_MODEL_ID,
  DEFAULT_OPENROUTER_MODEL_ID,
  MOCK_MODEL_ID,
} from "./constants";
import { resolveChatModel, selectChatProvider, type ResolveChatModelArgs } from "./provider";

/*
  Provider selection, rule by rule.

  The one that MUST NOT regress is "an unprivileged request cannot pick the
  provider": `providerId` arrives from the browser, and honouring it without
  the owner override would let any anonymous visitor choose which of the
  owner's API keys their turn spends. It is asserted in BOTH directions —
  ignored without the override, honoured with it — because a test that only
  proves the deny path passes just as happily against code that denies
  everyone.
*/

const PROVIDER_ENV_NAMES = [
  "FLOCK_CHAT_PROVIDER",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL_ID",
] as const;

const originalEnv = new Map(
  PROVIDER_ENV_NAMES.map((name) => [name, process.env[name]] as const),
);

/*
  A real `.env.local` on the developer's machine has both keys in it, so the
  suite has to start from a KNOWN-empty environment rather than inherit one —
  otherwise "no key configured" quietly becomes "the owner's key configured".
*/
beforeEach(() => {
  for (const name of PROVIDER_ENV_NAMES) {
    delete process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of originalEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

/*
  Stands in for the deterministic mock model; identity is what we assert on.
*/
const STUB_MOCK_MODEL = {
  specificationVersion: "v3",
  provider: "flock-test",
  modelId: MOCK_MODEL_ID,
} as unknown as LanguageModel;

const DEFAULT_ARGS: ResolveChatModelArgs = {
  requestedProviderId: undefined,
  hasOwnerOverride: false,
  isMockForced: false,
};

function select(overrides: Partial<ResolveChatModelArgs> = {}) {
  return selectChatProvider({ ...DEFAULT_ARGS, ...overrides });
}

function resolve(overrides: Partial<ResolveChatModelArgs> = {}) {
  let mockBuildCount = 0;
  const resolved = resolveChatModel({
    ...DEFAULT_ARGS,
    ...overrides,
    createMockModel: () => {
      mockBuildCount += 1;
      return STUB_MOCK_MODEL;
    },
  });
  return { ...resolved, mockBuildCount };
}

describe("no provider key configured", () => {
  it("runs the deterministic mock — the CI path, which needs no key", () => {
    const resolved = resolve();
    expect(resolved.providerId).toBe("mock");
    expect(resolved.isUsingMockModel).toBe(true);
    expect(resolved.modelId).toBe(MOCK_MODEL_ID);
    expect(resolved.model).toBe(STUB_MOCK_MODEL);
  });

  it("still runs the mock when a request asks for a provider, override or not", () => {
    for (const hasOwnerOverride of [false, true]) {
      const selection = select({ requestedProviderId: "openrouter", hasOwnerOverride });
      expect(selection.providerId).toBe("mock");
    }
  });
});

describe("the mock header wins outright", () => {
  it("uses the mock even with both keys configured and a provider requested", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-gemini-key";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";

    const resolved = resolve({
      isMockForced: true,
      hasOwnerOverride: true,
      requestedProviderId: "openrouter",
    });

    expect(resolved.providerId).toBe("mock");
    expect(resolved.isUsingMockModel).toBe(true);
    expect(resolved.model).toBe(STUB_MOCK_MODEL);
  });
});

describe("a client-supplied providerId is a request, not a decision", () => {
  beforeEach(() => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-gemini-key";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  });

  it("IGNORES the requested provider without the owner override", () => {
    const selection = select({ requestedProviderId: "openrouter", hasOwnerOverride: false });
    expect(selection.providerId).toBe("gemini");
    expect(selection.modelId).toBe(DEFAULT_GEMINI_MODEL_ID);
  });

  it("honours the requested provider WITH the owner override", () => {
    const resolved = resolve({ requestedProviderId: "openrouter", hasOwnerOverride: true });
    expect(resolved.providerId).toBe("openrouter");
    expect(resolved.modelId).toBe(DEFAULT_OPENROUTER_MODEL_ID);
    expect(resolved.isUsingMockModel).toBe(false);
    expect(resolved.mockBuildCount).toBe(0);
  });

  it("lets the owner request the deployment default back explicitly", () => {
    process.env.FLOCK_CHAT_PROVIDER = "openrouter";
    expect(select({ requestedProviderId: "gemini", hasOwnerOverride: true }).providerId).toBe(
      "gemini",
    );
    /*
      …and without the override the deployment default still stands.
    */
    expect(select({ requestedProviderId: "gemini", hasOwnerOverride: false }).providerId).toBe(
      "openrouter",
    );
  });
});

describe("the deployment default (FLOCK_CHAT_PROVIDER)", () => {
  it("defaults to Gemini when unset", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-gemini-key";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    expect(select().providerId).toBe("gemini");
  });

  it("selects OpenRouter when set to it, with no request preference", () => {
    process.env.FLOCK_CHAT_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-gemini-key";

    const resolved = resolve();
    expect(resolved.providerId).toBe("openrouter");
    expect(resolved.modelId).toBe(DEFAULT_OPENROUTER_MODEL_ID);
  });

  it("degrades an unknown value to Gemini rather than breaking the turn", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-gemini-key";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";

    for (const rawValue of ["anthropic", "OpenRouter", "", "   "]) {
      process.env.FLOCK_CHAT_PROVIDER = rawValue;
      expect(select().providerId).toBe("gemini");
    }
  });
});

describe("a provider with no key cannot be selected", () => {
  it("falls back to Gemini when the owner asks for a keyless OpenRouter", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-gemini-key";

    const resolved = resolve({ requestedProviderId: "openrouter", hasOwnerOverride: true });

    /*
      Not "openrouter with an empty-string key" — that provider is simply not
      on the table, so no client is built for it at all.
    */
    expect(resolved.providerId).toBe("gemini");
    expect(resolved.modelId).toBe(DEFAULT_GEMINI_MODEL_ID);
    expect(resolved.isUsingMockModel).toBe(false);
    expect(resolved.mockBuildCount).toBe(0);
  });

  it("falls back to OpenRouter when the deployment default has no key", () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    /*
      FLOCK_CHAT_PROVIDER unset → Gemini preferred, but Gemini has no key.
    */
    expect(select().providerId).toBe("openrouter");
  });

  it("treats an empty or blank key as unset, never as a usable credential", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-gemini-key";
    for (const blankValue of ["", "   "]) {
      process.env.OPENROUTER_API_KEY = blankValue;
      expect(select({ requestedProviderId: "openrouter", hasOwnerOverride: true }).providerId).toBe(
        "gemini",
      );
    }
  });

  it("reaches the mock when the only configured key is blank", () => {
    process.env.OPENROUTER_API_KEY = "";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "   ";
    expect(select().providerId).toBe("mock");
  });
});

describe("the OpenRouter model id", () => {
  beforeEach(() => {
    process.env.FLOCK_CHAT_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  });

  it("uses OPENROUTER_MODEL_ID when set", () => {
    process.env.OPENROUTER_MODEL_ID = "openai/gpt-oss-120b";
    expect(select().modelId).toBe("openai/gpt-oss-120b");
  });

  it("falls back to the verified free-tier default when blank or unset", () => {
    for (const blankValue of [undefined, "", "  "]) {
      if (blankValue === undefined) {
        delete process.env.OPENROUTER_MODEL_ID;
      } else {
        process.env.OPENROUTER_MODEL_ID = blankValue;
      }
      expect(select().modelId).toBe(DEFAULT_OPENROUTER_MODEL_ID);
    }
  });
});

describe("modelId is always the real id in play", () => {
  /*
    The pipeline's latency log line is the only record of which model ran, so
    an empty string there is worse than a wrong one — the spike shipped `""`
    on every turn. Sweep every branch this module can take.
  */
  it("is never empty, in any combination of env, override and request", () => {
    const keyCombinations = [
      {},
      { GOOGLE_GENERATIVE_AI_API_KEY: "test-gemini-key" },
      { OPENROUTER_API_KEY: "test-openrouter-key" },
      { GOOGLE_GENERATIVE_AI_API_KEY: "test-gemini-key", OPENROUTER_API_KEY: "test-openrouter-key" },
    ] as const;

    for (const keys of keyCombinations) {
      for (const deploymentDefault of [undefined, "gemini", "openrouter", "nonsense"]) {
        for (const requestedProviderId of [undefined, "gemini", "openrouter"] as const) {
          for (const hasOwnerOverride of [false, true]) {
            for (const isMockForced of [false, true]) {
              for (const name of PROVIDER_ENV_NAMES) {
                delete process.env[name];
              }
              Object.assign(process.env, keys);
              if (deploymentDefault !== undefined) {
                process.env.FLOCK_CHAT_PROVIDER = deploymentDefault;
              }

              const selection = select({
                requestedProviderId,
                hasOwnerOverride,
                isMockForced,
              });

              expect(selection.modelId.length).toBeGreaterThan(0);
              expect(selection.isUsingMockModel).toBe(selection.providerId === "mock");
              expect(selection.modelId === MOCK_MODEL_ID).toBe(selection.isUsingMockModel);
            }
          }
        }
      }
    }
  });
});
