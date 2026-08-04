// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { register as registerBetterAuth } from "@convex-dev/better-auth/test";
import { api } from "@convex/_generated/api";
import schema from "@convex/schema";

/**
 * THE ALLOWANCE TESTS for convex/authCredits.ts, written from the posture that
 * actually broke: FLOCK_REQUIRE_AUTH_IDENTITY=true with nobody signed in.
 *
 * WHY THIS FILE EXISTS. `getBalance` used to call the THROWING owner resolver
 * (`resolveOwnerId`), so on a strict deployment every signed-out visitor got a
 * ConvexError back from a query that `useFlockAuth` runs on page load. A
 * Convex query error surfaces by THROWING during render, so the whole route
 * died in Next's error boundary — `/dashboard` and `/studio` both, since the
 * hook is shared. None of it reproduces on Convex dev, where the flag is unset
 * and the pre-auth fallback quietly answers instead. That env split is the
 * whole reason these tests pin strict mode explicitly.
 *
 * THE TWO THINGS THAT MUST HOLD AT ONCE, and they pull apart:
 *
 *   1. A read-only balance query must DEGRADE, never explode. Same rule
 *      `canvases.listMyCanvases` already follows ("returns an empty list, not
 *      an error, for a caller with no identity").
 *   2. A client-supplied `sessionId` must still name NOBODY in strict mode. It
 *      is a scraped, published string (the presence roster hands it to every
 *      collaborator), so the moment it selects an `owner:` bucket, one visitor
 *      can read — and burn — another's allowance. Degrading by falling back to
 *      the claimed id would be strictly worse than the outage it fixes.
 *
 * The honest answer for a caller with no identity is therefore the per-ORIGIN
 * bucket, which is keyed to a salted address hash and is not owner-scoped, or
 * `null` when there is no origin key either — "we cannot attribute an
 * allowance to you", which is the truth, rather than a fabricated number.
 *
 * Mirrors the convex-test setup of owner-identity.test.ts, including the note
 * about the array-form glob (the documented extglob matches nothing under
 * vitest 4).
 */
const modules = import.meta.glob([
  "../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

const STRICT_FLAG = "FLOCK_REQUIRE_AUTH_IDENTITY";

/** A pre-auth browser's localStorage UUID — the legacy fallback key. */
const LEGACY_SESSION_ID = "7b3d9e01-2c4f-4a6b-9d8e-1f2a3b4c5d6e";

const VICTIM_OWNER_ID = "user_victim";

/** A salted address hash, exactly the shape `deriveOriginKey` produces. */
const ORIGIN_KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

const DEFAULT_ANONYMOUS_ORIGIN_CREDITS = 20;
const DEFAULT_ANONYMOUS_CREDITS = 5;

/**
 * `isClaimedIdentity` reads the Better Auth user row to decide the tier, which
 * reaches INTO the betterAuth component. convex-test knows nothing about an
 * installed component until it is registered, so without this every test with
 * an identity fails with "Component betterAuth is not registered" — a harness
 * gap, not an allowance failure. The component ships its own registrar; do not
 * hand-roll the schema+glob, since its internal layout is not a public export.
 */
function createBackend() {
  const backend = convexTest(schema, modules);
  registerBetterAuth(backend);
  return backend;
}

type Backend = ReturnType<typeof createBackend>;

/**
 * A signed-in caller. `sessionId` is not decoration: `safeGetAuthUser` looks the
 * Better Auth session up by the `sessionId` CLAIM on the token, and a
 * `withIdentity` without one dies inside the component's validator rather than
 * in anything this file is testing. No session row is seeded to match, so these
 * callers land on the anonymous tier — which is the tier that matters here,
 * since the claimed one is the easy case.
 */
function asSignedIn(t: Backend, ownerId: string) {
  return t.withIdentity({ subject: ownerId, sessionId: `session_${ownerId}` });
}

/** Every bucket row in the table, so "which bucket got charged" is assertable. */
async function readBucketKeys(t: Backend): Promise<string[]> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("authCredits").collect();
    return rows.map((row) => row.bucketKey).sort();
  });
}

const previousStrictFlag = process.env[STRICT_FLAG];

afterEach(() => {
  if (previousStrictFlag === undefined) {
    delete process.env[STRICT_FLAG];
  } else {
    process.env[STRICT_FLAG] = previousStrictFlag;
  }
});

describe("strict mode: a signed-out visitor gets an answer, not an error", () => {
  beforeEach(() => {
    // The deployment's REAL posture — exactly how Convex prod is configured,
    // and the only posture in which this bug is visible at all.
    process.env[STRICT_FLAG] = "true";
  });

  /**
   * THE REGRESSION. This is the production crash, reduced: one query, no
   * identity, a session id in hand. Before the fix it threw
   * "You're signed out, so we can't tell whose library this is", which
   * `useQuery` re-threw during render and Next turned into "This page couldn't
   * load" on every route that mounts `useFlockAuth`.
   */
  it("answers getBalance with null instead of throwing when nobody is signed in", async () => {
    const t = createBackend();

    const balance = await t.query(api.authCredits.getBalance, {
      sessionId: LEGACY_SESSION_ID,
    });

    expect(balance).toBeNull();
  });

  it("reports the per-origin bucket, which is the limit that will actually stop them", async () => {
    const t = createBackend();

    const balance = await t.query(api.authCredits.getBalance, {
      sessionId: LEGACY_SESSION_ID,
      originKey: ORIGIN_KEY,
    });

    // Not a fabricated per-identity tier: the number quoted is the one that
    // meters them, so the UI copy about it is true.
    expect(balance).toMatchObject({
      limit: DEFAULT_ANONYMOUS_ORIGIN_CREDITS,
      spent: 0,
      remaining: DEFAULT_ANONYMOUS_ORIGIN_CREDITS,
      isClaimedTier: false,
    });
  });

  it("peeks without starting a window, so polling the balance costs nothing", async () => {
    const t = createBackend();

    await t.query(api.authCredits.getBalance, {
      sessionId: LEGACY_SESSION_ID,
      originKey: ORIGIN_KEY,
    });

    expect(await readBucketKeys(t)).toEqual([]);
  });

  /**
   * THE ATTACK, in allowance form. The quoted id belongs to a real signed-in
   * user with a real balance. If degrading ever meant "fall back to the
   * claimed id", this query would hand a stranger the victim's remaining
   * count — and `spend` below would let the stranger burn it.
   */
  it("never reads a victim's allowance from a session id quoted at it", async () => {
    const t = createBackend();
    const victim = asSignedIn(t, VICTIM_OWNER_ID);

    await victim.mutation(api.authCredits.spend, { sessionId: LEGACY_SESSION_ID, amount: 3 });
    const victimBalance = await victim.query(api.authCredits.getBalance, {
      sessionId: LEGACY_SESSION_ID,
    });
    expect(victimBalance).toMatchObject({ spent: 3 });

    // A stranger replays the victim's owner id verbatim, with no auth cookie.
    const stolen = await t.query(api.authCredits.getBalance, { sessionId: VICTIM_OWNER_ID });
    expect(stolen).toBeNull();

    // ...and with an origin key, they are told about their OWN origin bucket
    // and nothing of the victim's.
    const stolenWithOrigin = await t.query(api.authCredits.getBalance, {
      sessionId: VICTIM_OWNER_ID,
      originKey: ORIGIN_KEY,
    });
    expect(stolenWithOrigin).toMatchObject({ spent: 0, limit: DEFAULT_ANONYMOUS_ORIGIN_CREDITS });
  });
});

describe("strict mode: a signed-out spend is metered, not waved through", () => {
  beforeEach(() => {
    process.env[STRICT_FLAG] = "true";
  });

  /**
   * The charge path had the same defect with a nastier ending: the throw was
   * swallowed by `chargeCreditForRequest`, which FAILS OPEN by design
   * (apps/web/src/lib/auth/credits.ts). So on a strict deployment every
   * signed-out visitor's inference was entirely UNMETERED — the opposite of
   * what the allowance exists for. Charging the origin bucket is what actually
   * closes that.
   */
  it("charges the per-origin bucket and no owner bucket at all", async () => {
    const t = createBackend();

    const result = await t.mutation(api.authCredits.spend, {
      sessionId: LEGACY_SESSION_ID,
      originKey: ORIGIN_KEY,
    });

    expect(result.isAllowed).toBe(true);
    expect(result.balance).toMatchObject({
      limit: DEFAULT_ANONYMOUS_ORIGIN_CREDITS,
      spent: 1,
      remaining: DEFAULT_ANONYMOUS_ORIGIN_CREDITS - 1,
    });
    // The claimed session id names nobody: no `owner:` row exists to find.
    expect(await readBucketKeys(t)).toEqual([`origin:${ORIGIN_KEY}`]);
  });

  it("cannot burn a victim's allowance by quoting their id", async () => {
    const t = createBackend();
    const victim = asSignedIn(t, VICTIM_OWNER_ID);
    await victim.mutation(api.authCredits.spend, { sessionId: LEGACY_SESSION_ID });

    await t.mutation(api.authCredits.spend, { sessionId: VICTIM_OWNER_ID, originKey: ORIGIN_KEY });

    const victimBalance = await victim.query(api.authCredits.getBalance, {
      sessionId: LEGACY_SESSION_ID,
    });
    // Still 1 — the stranger's spend landed on the origin bucket, not here.
    expect(victimBalance).toMatchObject({ spent: 1 });
    expect(await readBucketKeys(t)).toEqual([
      `origin:${ORIGIN_KEY}`,
      `owner:${VICTIM_OWNER_ID}`,
    ]);
  });

  it("refuses once the shared origin bucket is exhausted", async () => {
    const t = createBackend();

    const spent = await t.mutation(api.authCredits.spend, {
      sessionId: LEGACY_SESSION_ID,
      originKey: ORIGIN_KEY,
      amount: DEFAULT_ANONYMOUS_ORIGIN_CREDITS,
    });
    expect(spent.isAllowed).toBe(true);

    const refused = await t.mutation(api.authCredits.spend, {
      sessionId: LEGACY_SESSION_ID,
      originKey: ORIGIN_KEY,
    });
    expect(refused.isAllowed).toBe(false);
    expect(refused.balance).toMatchObject({ remaining: 0 });
  });

  /**
   * No identity AND no origin key — local dev, direct calls, a request with no
   * proxy headers. There is genuinely nothing to charge and nothing to report,
   * so the work goes through and the balance is null. That matches the
   * module's standing policy: a metering gap must not take the product down,
   * and the provider quota is still the hard ceiling behind it.
   */
  it("lets work through with a null balance when there is no bucket at all", async () => {
    const t = createBackend();

    const result = await t.mutation(api.authCredits.spend, { sessionId: LEGACY_SESSION_ID });

    expect(result.isAllowed).toBe(true);
    expect(result.balance).toBeNull();
    expect(await readBucketKeys(t)).toEqual([]);
  });
});

describe("strict mode: a signed-in caller is unaffected", () => {
  beforeEach(() => {
    process.env[STRICT_FLAG] = "true";
  });

  it("keeps the anonymous per-identity tier and its shared origin bucket", async () => {
    const t = createBackend();
    const caller = asSignedIn(t, "user_anonymous");

    const result = await caller.mutation(api.authCredits.spend, {
      sessionId: LEGACY_SESSION_ID,
      originKey: ORIGIN_KEY,
    });

    // No auth user row behind the identity, so this is the anonymous tier —
    // the tighter of the two buckets is what the caller is told about.
    expect(result.balance).toMatchObject({
      limit: DEFAULT_ANONYMOUS_CREDITS,
      remaining: DEFAULT_ANONYMOUS_CREDITS - 1,
      isClaimedTier: false,
    });
    expect(await readBucketKeys(t)).toEqual([
      `origin:${ORIGIN_KEY}`,
      "owner:user_anonymous",
    ]);
  });

  it("keys the owner bucket to the identity, never to the id the client sent", async () => {
    const t = createBackend();
    const caller = asSignedIn(t, "user_anonymous");

    await caller.mutation(api.authCredits.spend, { sessionId: LEGACY_SESSION_ID });

    expect(await readBucketKeys(t)).toEqual(["owner:user_anonymous"]);
  });
});

describe("strict mode off: the pre-auth deployment is untouched", () => {
  beforeEach(() => {
    delete process.env[STRICT_FLAG];
  });

  /**
   * The other half of the deal. With the flag off there is no identity to have,
   * so the claimed session id IS the ownership key and a signed-out caller
   * still gets a real per-identity allowance. A fix that quietly moved every
   * pre-auth visitor onto a shared origin bucket would have throttled a whole
   * office as one person.
   */
  it("still keys the owner bucket to the claimed session id", async () => {
    const t = createBackend();

    const result = await t.mutation(api.authCredits.spend, { sessionId: LEGACY_SESSION_ID });

    expect(result.isAllowed).toBe(true);
    expect(result.balance).toMatchObject({
      limit: DEFAULT_ANONYMOUS_CREDITS,
      remaining: DEFAULT_ANONYMOUS_CREDITS - 1,
    });
    expect(await readBucketKeys(t)).toEqual([`owner:${LEGACY_SESSION_ID}`]);

    const balance = await t.query(api.authCredits.getBalance, { sessionId: LEGACY_SESSION_ID });
    expect(balance).toMatchObject({ spent: 1, remaining: DEFAULT_ANONYMOUS_CREDITS - 1 });
  });
});
