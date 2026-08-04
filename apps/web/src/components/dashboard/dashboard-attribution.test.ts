// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { register as registerBetterAuth } from "@convex-dev/better-auth/test";
import { api } from "@convex/_generated/api";
import schema from "@convex/schema";
import type { CreditBalance, FlockIdentity } from "@/lib/auth/use-flock-auth";
import { resolveDashboardAttribution } from "./dashboard-attribution";

/**
 * WHAT THE DASHBOARD SAYS TO SOMEBODY IT CANNOT NAME.
 *
 * The outage this file guards was an error boundary: `authCredits.getBalance`
 * used the THROWING owner resolver, so on a strict deployment every signed-out
 * visitor's page load threw during render. That half is pinned by
 * apps/web/src/lib/auth/credit-balance.test.ts.
 *
 * The half pinned HERE is the one that survives the crash being fixed. Once the
 * query answers instead of throwing, `/dashboard` renders — and renders an
 * EMPTY LIST, because `listMyCanvases` degrades to `[]` for a caller with no
 * identity (canvas-ownership.test.ts:132). An empty list rendered with the
 * ordinary empty-state copy tells that visitor two false things: that they have
 * made nothing, and that anything they make next will show up here. Neither is
 * true — `recordCanvasOwner` writes no ownership row for a caller who names
 * nobody, so work created in that state is unlistable forever, not just now.
 *
 * So the page has to distinguish "you have made nothing" from "we cannot tell
 * whose this is", and the ONLY evidence it has is the balance coming back null.
 * These tests exist because that inference is load-bearing and invisible: it
 * holds precisely because the browser can never send an `originKey` (it is an
 * HMAC of the client address, derived server-side in
 * apps/web/src/lib/auth/origin-key.ts). If anyone ever plumbs one into the
 * client's `getBalance` call, the last test in this file is what fails.
 */
const modules = import.meta.glob([
  "../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

const STRICT_FLAG = "FLOCK_REQUIRE_AUTH_IDENTITY";

/** A pre-auth browser's localStorage UUID — the legacy fallback key. */
const LEGACY_SESSION_ID = "7b3d9e01-2c4f-4a6b-9d8e-1f2a3b4c5d6e";

const SIGNED_IN: FlockIdentity = {
  id: "user_claimed",
  email: "someone@example.com",
  isAnonymous: false,
};

const A_REAL_BALANCE: CreditBalance = {
  limit: 5,
  spent: 1,
  remaining: 4,
  resetsAtMs: 0,
  isClaimedTier: false,
};

describe("resolveDashboardAttribution", () => {
  /**
   * The pre-auth deployment, and the reason `isAuthEnabled` is checked FIRST.
   * With the flag off `useFlockAuth` skips the balance query entirely, so
   * `credits` is permanently undefined. Reading that as "still loading" would
   * park the page on a loading skeleton that never resolves.
   */
  it("resolves immediately with auth off, where undefined credits never arrive", () => {
    expect(
      resolveDashboardAttribution({
        isAuthEnabled: false,
        identity: null,
        credits: undefined,
      }),
    ).toBe("attributed");
  });

  it("waits while the identity query is still in flight", () => {
    expect(
      resolveDashboardAttribution({
        isAuthEnabled: true,
        identity: undefined,
        credits: undefined,
      }),
    ).toBe("resolving");
  });

  it("attributes a signed-in caller without waiting on their balance", () => {
    expect(
      resolveDashboardAttribution({
        isAuthEnabled: true,
        identity: SIGNED_IN,
        credits: undefined,
      }),
    ).toBe("attributed");
  });

  /**
   * The flash this prevents: `listMyCanvases` resolving to `[]` a beat before
   * the balance lands would otherwise paint "Nothing here yet" and then swap it
   * for "Sign in to see your emails" — two opposite claims in sequence.
   */
  it("waits for the balance before speaking for a signed-out caller", () => {
    expect(
      resolveDashboardAttribution({
        isAuthEnabled: true,
        identity: null,
        credits: undefined,
      }),
    ).toBe("resolving");
  });

  /**
   * Strict mode OFF with auth on: the claimed session id IS the ownership key,
   * so a signed-out visitor's empty list is genuinely theirs and genuinely
   * empty. Telling this person to sign in to find work they never made would be
   * the same lie in the other direction.
   */
  it("treats a real balance as proof the server named an owner", () => {
    expect(
      resolveDashboardAttribution({
        isAuthEnabled: true,
        identity: null,
        credits: A_REAL_BALANCE,
      }),
    ).toBe("attributed");
  });

  /** THE PRODUCTION STATE. Signed out, strict on, nothing attributable. */
  it("reports unattributed when the server can name nobody", () => {
    expect(
      resolveDashboardAttribution({
        isAuthEnabled: true,
        identity: null,
        credits: null,
      }),
    ).toBe("unattributed");
  });
});

/**
 * `isClaimedIdentity` reaches into the betterAuth component, which convex-test
 * does not know about until it is registered. Same harness note as
 * credit-balance.test.ts — the component ships its own registrar.
 */
function createBackend() {
  const backend = convexTest(schema, modules);
  registerBetterAuth(backend);
  return backend;
}

const previousStrictFlag = process.env[STRICT_FLAG];

afterEach(() => {
  if (previousStrictFlag === undefined) {
    delete process.env[STRICT_FLAG];
  } else {
    process.env[STRICT_FLAG] = previousStrictFlag;
  }
});

describe("a signed-out /dashboard load on a strict deployment", () => {
  beforeEach(() => {
    // Exactly how Convex prod is configured, and the only posture in which any
    // of this is observable — Convex dev leaves the flag unset, which is why
    // "it works locally" proved nothing here.
    process.env[STRICT_FLAG] = "true";
  });

  /**
   * The whole page load, end to end: both queries `DashboardShell` +
   * `useFlockAuth` fire, run against real Convex functions with the real flag,
   * and their real answers fed into the real decision. Nothing is stubbed, so
   * this fails if EITHER query changes its degraded answer — including the way
   * it would break if a client-supplied `originKey` ever started arriving.
   */
  it("comes back empty and unattributed, without throwing", async () => {
    const t = createBackend();

    const canvases = await t.query(api.canvases.listMyCanvases, {
      sessionId: LEGACY_SESSION_ID,
    });
    const credits = await t.query(api.authCredits.getBalance, {
      sessionId: LEGACY_SESSION_ID,
    });

    expect(canvases).toEqual([]);
    expect(credits).toBeNull();
    expect(
      resolveDashboardAttribution({ isAuthEnabled: true, identity: null, credits }),
    ).toBe("unattributed");
  });

  /**
   * The same load for someone signed in. The dashboard must not start telling
   * real users to sign in because the strict flag is on.
   */
  it("still attributes a signed-in caller's list to them", async () => {
    const t = createBackend();
    const caller = t.withIdentity({ subject: SIGNED_IN.id, sessionId: "session_claimed" });

    const credits = await caller.query(api.authCredits.getBalance, {
      sessionId: LEGACY_SESSION_ID,
    });

    expect(credits).not.toBeNull();
    expect(
      resolveDashboardAttribution({ isAuthEnabled: true, identity: SIGNED_IN, credits }),
    ).toBe("attributed");
  });
});

describe("the same load with strict mode off", () => {
  beforeEach(() => {
    delete process.env[STRICT_FLAG];
  });

  /**
   * The pre-auth deployment must be untouched: the claimed session id still
   * names an owner, so the balance is real and the dashboard keeps its ordinary
   * empty state rather than prompting a sign-in nobody needs.
   */
  it("attributes a signed-out caller through the pre-auth fallback", async () => {
    const t = createBackend();

    const credits = await t.query(api.authCredits.getBalance, {
      sessionId: LEGACY_SESSION_ID,
    });

    expect(credits).not.toBeNull();
    expect(
      resolveDashboardAttribution({ isAuthEnabled: true, identity: null, credits }),
    ).toBe("attributed");
  });
});
