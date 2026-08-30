// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { register as registerBetterAuth } from "@convex-dev/better-auth/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "@convex/_generated/api";
import schema from "@convex/schema";
import { buildTestSendRefusalMessage, describeRetryDelay } from "@convex/authTestSends";

/*
  THE SEND METER (convex/authTestSends.ts), tested against a real backend.

  WHAT THESE ARE PROVING. `POST /api/send-test-email` already refuses a caller
  it cannot name. That made every send ATTRIBUTABLE and capped nothing, and the
  sessions it accepts are free to mint — a browser is signed in anonymously the
  moment it loads /studio. So the attack the identity gate did not stop is:
  mint a session, send, throw it away, mint another, repeat, mailing arbitrary
  content to arbitrary inboxes from our DKIM-signed domain.

  The test that matters most in this file is therefore "a brand-new identity
  does not reset the cap". Everything else is the arithmetic that has to hold
  for that one to mean anything.

  The mutation runs for real here — the rolling window, the lazy expiry and the
  all-or-nothing write are all live, and Convex's transactionality is what makes
  the last one true under concurrency.

  ONE HARNESS LIMIT, stated rather than papered over: `withIdentity` produces a
  caller with NO Better Auth user row behind it, so `safeGetAuthUser` finds
  nothing and every signed-in caller below lands on the ANONYMOUS tier. The
  claimed tier is not reachable from convex-test (credit-balance.test.ts hit the
  same wall and says so). That is the right way round: the anonymous tier is the
  one under attack, and the claimed tier only ever RELAXES the meter.
*/

// NOTE: convex-test's documented `!(*.*.*)` extglob matches nothing under
// vitest 4 (tinyglobby has no extglob support) — the array form with negative
// patterns is the equivalent that works.
const modules = import.meta.glob([
  "../../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

const CLAIMED_FLAG = "FLOCK_TEST_SENDS_PER_PERIOD";
const ANONYMOUS_FLAG = "FLOCK_ANONYMOUS_TEST_SENDS_PER_PERIOD";
const ORIGIN_FLAG = "FLOCK_ANONYMOUS_ORIGIN_TEST_SENDS_PER_PERIOD";
const RECIPIENT_FLAG = "FLOCK_RECIPIENT_TEST_SENDS_PER_PERIOD";
const PERIOD_FLAG = "FLOCK_TEST_SEND_PERIOD_HOURS";
const STRICT_FLAG = "FLOCK_REQUIRE_AUTH_IDENTITY";

const ALL_FLAGS = [
  CLAIMED_FLAG,
  ANONYMOUS_FLAG,
  ORIGIN_FLAG,
  RECIPIENT_FLAG,
  PERIOD_FLAG,
  STRICT_FLAG,
] as const;

/* The shape `deriveOriginKey` produces: a salted digest, never an address. */
const HOME_ORIGIN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const OTHER_ORIGIN = "0f9e8d7c6b5a49382716f5e4d3c2b1a0";

/* The shape `deriveRecipientKey` produces: a salted digest, never an email. */
const RECIPIENT = "11223344556677889900aabbccddeeff";
const OTHER_RECIPIENT = "ffeeddccbbaa00998877665544332211";

const previousFlags = new Map(ALL_FLAGS.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of ALL_FLAGS) {
    const previous = previousFlags.get(name);
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
});

/*
  `safeGetAuthUser` reaches INTO the betterAuth component to decide the tier.
  convex-test knows nothing about an installed component until it is registered,
  so without this every test with an identity fails with "Component betterAuth is
  not registered" — a harness gap, not a metering failure.
*/
function createBackend() {
  const backend = convexTest(schema, modules);
  registerBetterAuth(backend);
  return backend;
}

type Backend = ReturnType<typeof createBackend>;

type SendAttempt = { isAllowed: boolean; refusalMessage: string; retryAtMs: number | null };

/*
  One test-send attempt, exactly as the route makes it. `identity` absent means
  a caller with no verified identity at all — an auth-off deployment, or a
  strict deployment with nobody signed in.
*/
async function attemptSend(
  t: Backend,
  args: {
    identity?: string;
    originKey?: string;
    recipientKey?: string;
    /* A multi-recipient send. Takes precedence over `recipientKey` when given. */
    recipientKeys?: string[];
  },
): Promise<SendAttempt> {
  const caller =
    args.identity === undefined
      ? t
      : t.withIdentity({ subject: args.identity, sessionId: `session_${args.identity}` });
  return await caller.mutation(api.authTestSends.reserveTestSend, {
    recipientKeys: args.recipientKeys ?? [args.recipientKey ?? RECIPIENT],
    ...(args.originKey === undefined ? {} : { originKey: args.originKey }),
  });
}

/** Every bucket row, so "which bucket got charged" is directly assertable. */
async function readBuckets(t: Backend): Promise<{ bucketKey: string; sentCount: number }[]> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("authTestSends").collect();
    return rows
      .map((row) => ({ bucketKey: row.bucketKey, sentCount: row.sentCount }))
      .sort((left, right) => left.bucketKey.localeCompare(right.bucketKey));
  });
}

describe("minting a fresh anonymous session does not buy more sends", () => {
  beforeEach(() => {
    /* Two per identity, three per network — small enough to walk in one test. */
    process.env[ANONYMOUS_FLAG] = "2";
    process.env[ORIGIN_FLAG] = "3";
    process.env[RECIPIENT_FLAG] = "99";
  });

  /*
    THE REGRESSION THIS FEATURE EXISTS FOR. Before the meter, this loop had no
    end: the identity gate happily attributed every send to whichever throwaway
    session had just been minted, and nothing counted them. Signing out and back
    in is one click, and it is the entire attack.
  */
  it("stops the loop, because the origin bucket is not reset by a new identity", async () => {
    const t = createBackend();

    /* The first session spends its own small allowance. */
    expect((await attemptSend(t, { identity: "user_1", originKey: HOME_ORIGIN })).isAllowed).toBe(
      true,
    );
    expect((await attemptSend(t, { identity: "user_1", originKey: HOME_ORIGIN })).isAllowed).toBe(
      true,
    );
    const ownerExhausted = await attemptSend(t, { identity: "user_1", originKey: HOME_ORIGIN });
    expect(ownerExhausted.isAllowed).toBe(false);

    /* Clear storage, reload, get a brand-new anonymous user. Same network. */
    const freshSession = await attemptSend(t, { identity: "user_2", originKey: HOME_ORIGIN });
    expect(freshSession.isAllowed).toBe(true);

    /* And that is the last one this network gets, however many more it mints. */
    const secondFresh = await attemptSend(t, { identity: "user_3", originKey: HOME_ORIGIN });
    expect(secondFresh.isAllowed).toBe(false);
    expect(secondFresh.refusalMessage).toContain("from this connection");

    const thirdFresh = await attemptSend(t, { identity: "user_4", originKey: HOME_ORIGIN });
    expect(thirdFresh.isAllowed).toBe(false);

    /* Four identities, three sends. Without the origin bucket it would be six. */
    const buckets = await readBuckets(t);
    expect(buckets.find((row) => row.bucketKey === `origin:${HOME_ORIGIN}`)).toEqual({
      bucketKey: `origin:${HOME_ORIGIN}`,
      sentCount: 3,
    });
  });

  /*
    ALL-OR-NOTHING. The fresh identity is refused by the ORIGIN bucket, so its
    own owner bucket must not have been charged on the way past. Otherwise a
    refusal is a second penalty, and a user who came back after the network
    allowance refilled would find their personal one mysteriously spent.
  */
  it("charges nothing at all when one bucket refuses", async () => {
    const t = createBackend();
    for (const identity of ["user_1", "user_2"]) {
      await attemptSend(t, { identity, originKey: HOME_ORIGIN });
    }
    await attemptSend(t, { identity: "user_1", originKey: HOME_ORIGIN });

    const refused = await attemptSend(t, { identity: "user_blocked", originKey: HOME_ORIGIN });
    expect(refused.isAllowed).toBe(false);

    const buckets = await readBuckets(t);
    expect(buckets.map((row) => row.bucketKey)).not.toContain("owner:user_blocked");
  });

  it("does not spend another network's allowance", async () => {
    const t = createBackend();
    for (const identity of ["user_1", "user_2", "user_3"]) {
      await attemptSend(t, { identity, originKey: HOME_ORIGIN });
    }

    const elsewhere = await attemptSend(t, { identity: "user_4", originKey: OTHER_ORIGIN });
    expect(elsewhere.isAllowed).toBe(true);
  });
});

describe("one identity's own allowance", () => {
  beforeEach(() => {
    process.env[ANONYMOUS_FLAG] = "3";
    process.env[ORIGIN_FLAG] = "99";
    process.env[RECIPIENT_FLAG] = "99";
  });

  it("counts down and then refuses, naming when it refills", async () => {
    const t = createBackend();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await attemptSend(t, { identity: "user_1", originKey: HOME_ORIGIN })).isAllowed).toBe(
        true,
      );
    }

    const refused = await attemptSend(t, { identity: "user_1", originKey: HOME_ORIGIN });
    expect(refused.isAllowed).toBe(false);
    expect(refused.refusalMessage).toContain("today's test sends");
    /* The one useful fact in a refusal: when it stops being true. */
    expect(refused.refusalMessage).toMatch(/refills in about/);
    expect(refused.retryAtMs).toBeGreaterThan(Date.now());
  });

  it("keys the bucket to the verified identity, never to anything the client sent", async () => {
    const t = createBackend();
    await attemptSend(t, { identity: "user_1" });

    expect((await readBuckets(t)).map((row) => row.bucketKey)).toEqual([
      `recipient:${RECIPIENT}`,
      "owner:user_1",
    ].sort());
  });

  it("lets the identity back in once its window has rolled over", async () => {
    const t = createBackend();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await attemptSend(t, { identity: "user_1" });
    }
    expect((await attemptSend(t, { identity: "user_1" })).isAllowed).toBe(false);

    /* Back-date the window rather than wait a day for it. */
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("authTestSends")
        .withIndex("by_bucketKey", (q) => q.eq("bucketKey", "owner:user_1"))
        .first();
      expect(row).not.toBeNull();
      await ctx.db.patch(row!._id, { periodStartMs: row!.periodStartMs - 25 * 60 * 60 * 1000 });
    });

    const afterRollover = await attemptSend(t, { identity: "user_1" });
    expect(afterRollover.isAllowed).toBe(true);
    /* The window restarted rather than resumed — the count is 1, not 4. */
    const buckets = await readBuckets(t);
    expect(buckets.find((row) => row.bucketKey === "owner:user_1")?.sentCount).toBe(1);
  });
});

describe("the inbox on the receiving end", () => {
  beforeEach(() => {
    process.env[ANONYMOUS_FLAG] = "99";
    process.env[ORIGIN_FLAG] = "99";
    process.env[RECIPIENT_FLAG] = "2";
  });

  /*
    THE PROXY-POOL CASE, which the origin bucket honestly does not cover. An
    attacker who can rotate client addresses rotates past `origin:`, and a fresh
    session rotates past `owner:`. What they cannot rotate is the victim: burying
    one inbox means sending to that inbox. This is the bucket that bounds it.
  */
  it("caps one address however many identities and networks are used", async () => {
    const t = createBackend();
    expect(
      (await attemptSend(t, { identity: "user_1", originKey: HOME_ORIGIN })).isAllowed,
    ).toBe(true);
    expect(
      (await attemptSend(t, { identity: "user_2", originKey: OTHER_ORIGIN })).isAllowed,
    ).toBe(true);

    const third = await attemptSend(t, { identity: "user_3", originKey: "cafebabe".repeat(4) });
    expect(third.isAllowed).toBe(false);
    expect(third.refusalMessage).toContain("That address has had a lot of test emails");
  });

  it("leaves every other address alone", async () => {
    const t = createBackend();
    await attemptSend(t, { identity: "user_1" });
    await attemptSend(t, { identity: "user_1" });

    const different = await attemptSend(t, {
      identity: "user_1",
      recipientKey: OTHER_RECIPIENT,
    });
    expect(different.isAllowed).toBe(true);
  });
});

/*
  ONE SEND ADDRESSED TO SEVERAL INBOXES.

  A test send now carries up to five recipients in one email. The rule the
  recipient bucket exists to enforce must survive that: a fat `to` array is one
  human action against the SENDER (owner/origin charged once) but N arrivals
  against the RECEIVERS (each distinct recipient bucket charged once). If a send
  were counted as a single recipient — or later recipients skipped — a capped
  victim could be smuggled through alongside addresses that still have room,
  which is precisely the end-run this bucket was built to stop.

  Five distinct salted digests, the shape `deriveRecipientKey` produces.
*/
const FIVE_RECIPIENTS = [
  "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
  "2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b",
  "3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c",
  "4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d",
  "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e",
];

describe("one send addressed to several inboxes", () => {
  beforeEach(() => {
    /* Headroom everywhere, so the counts below come only from this one send. */
    process.env[ANONYMOUS_FLAG] = "99";
    process.env[ORIGIN_FLAG] = "99";
    process.env[RECIPIENT_FLAG] = "99";
  });

  it("charges each recipient bucket once, and owner/origin once — not once per recipient", async () => {
    const t = createBackend();

    const sent = await attemptSend(t, {
      identity: "user_1",
      originKey: HOME_ORIGIN,
      recipientKeys: FIVE_RECIPIENTS,
    });
    expect(sent.isAllowed).toBe(true);

    const buckets = await readBuckets(t);
    const byKey = new Map(buckets.map((row) => [row.bucketKey, row.sentCount]));

    /* One increment per DISTINCT recipient — five buckets, each at 1. */
    for (const recipientKey of FIVE_RECIPIENTS) {
      expect(byKey.get(`recipient:${recipientKey}`)).toBe(1);
    }
    /* The sender is charged ONCE, however many people the one send addressed. */
    expect(byKey.get("owner:user_1")).toBe(1);
    expect(byKey.get(`origin:${HOME_ORIGIN}`)).toBe(1);
  });

  it("counts a repeated address in one send as a single recipient", async () => {
    // Dedupe first: listing the same inbox twice cannot charge it twice, and it
    // cannot dodge the cap by not being counted either.
    const t = createBackend();
    const [victim] = FIVE_RECIPIENTS;

    await attemptSend(t, { identity: "user_1", recipientKeys: [victim, victim, victim] });

    const buckets = await readBuckets(t);
    expect(buckets.find((row) => row.bucketKey === `recipient:${victim}`)?.sentCount).toBe(1);
  });

  /*
    THE NEGATIVE TEST. One recipient in the array is already at its cap, while
    the sending identity and the origin have plenty of headroom. The WHOLE send
    must be refused, and — all-or-nothing — nothing may be charged: not the
    fresh owner bucket, not the origin, not the other recipients.

    The capped address is deliberately NOT first in the list, so an
    implementation that counted the send as a single recipient (metering only
    `to[0]`) would wave it straight through. That is the failure this pins.
  */
  it("refuses the whole send when ANY one recipient is capped, though identity and origin have room", async () => {
    process.env[RECIPIENT_FLAG] = "1";
    const t = createBackend();
    const [capped, ...others] = FIVE_RECIPIENTS;

    /* Fill the victim's bucket with a send addressed only to them. */
    const first = await attemptSend(t, {
      identity: "user_filler",
      originKey: OTHER_ORIGIN,
      recipientKeys: [capped],
    });
    expect(first.isAllowed).toBe(true);

    /* A brand-new identity, a different origin — both with headroom to spare. */
    const refused = await attemptSend(t, {
      identity: "user_fresh",
      originKey: HOME_ORIGIN,
      /* The capped address sits AFTER a healthy one on purpose. */
      recipientKeys: [others[0], capped, others[1]],
    });
    expect(refused.isAllowed).toBe(false);
    expect(refused.refusalMessage).toContain("That address has had a lot of test emails");

    /* All-or-nothing: nothing about the refused send was charged. */
    const buckets = await readBuckets(t);
    const keys = buckets.map((row) => row.bucketKey);
    expect(keys).not.toContain("owner:user_fresh");
    expect(keys).not.toContain(`origin:${HOME_ORIGIN}`);
    expect(keys).not.toContain(`recipient:${others[0]}`);
    expect(keys).not.toContain(`recipient:${others[1]}`);
    /* The victim's own bucket stays exactly where the first send left it. */
    expect(buckets.find((row) => row.bucketKey === `recipient:${capped}`)?.sentCount).toBe(1);
  });
});

describe("a deployment with no identity system at all", () => {
  beforeEach(() => {
    /*
      The auth-off posture: nothing signs anyone in, so `ctx.auth` is empty on
      every call. The strict flag is set to its LOOSER value on purpose — the
      meter takes no `sessionId` argument, so there is nothing for the pre-auth
      fallback to fall back to, and the answer must be the same either way.
    */
    delete process.env[STRICT_FLAG];
    process.env[ANONYMOUS_FLAG] = "99";
    process.env[ORIGIN_FLAG] = "2";
    process.env[RECIPIENT_FLAG] = "3";
  });

  it("still meters, on the origin bucket, with no owner bucket to key", async () => {
    const t = createBackend();
    expect((await attemptSend(t, { originKey: HOME_ORIGIN })).isAllowed).toBe(true);
    expect((await attemptSend(t, { originKey: HOME_ORIGIN })).isAllowed).toBe(true);

    const refused = await attemptSend(t, { originKey: HOME_ORIGIN });
    expect(refused.isAllowed).toBe(false);
    expect((await readBuckets(t)).map((row) => row.bucketKey)).toEqual([
      `origin:${HOME_ORIGIN}`,
      `recipient:${RECIPIENT}`,
    ]);
  });

  /*
    No identity AND no visible client address — local dev, a direct call, a
    request behind no proxy. The credit meter's equivalent case is genuinely
    unmetered ("no bucket exists"); this one is not, because a send always has a
    recipient. So the sending domain is never protected by nothing at all.
  */
  it("is still bounded when there is no client address either", async () => {
    const t = createBackend();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await attemptSend(t, {})).isAllowed).toBe(true);
    }

    const refused = await attemptSend(t, {});
    expect(refused.isAllowed).toBe(false);
    expect((await readBuckets(t)).map((row) => row.bucketKey)).toEqual([
      `recipient:${RECIPIENT}`,
    ]);
  });
});

describe("the numbers a deployment gets without configuring anything", () => {
  beforeEach(() => {
    for (const name of ALL_FLAGS) {
      delete process.env[name];
    }
  });

  /*
    The defaults are the product decision, so they are pinned here rather than
    left to whatever the env happens to hold. Eight is chosen to sit comfortably
    above "I sent myself a few while editing" — the limit that breaks ordinary
    authoring would be a worse outcome than one that is slightly loose.
  */
  it("gives an anonymous visitor eight test sends before asking them to wait", async () => {
    const t = createBackend();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect((await attemptSend(t, { identity: "user_1" })).isAllowed).toBe(true);
    }

    expect((await attemptSend(t, { identity: "user_1" })).isAllowed).toBe(false);
  });
});

describe("what the person is actually told", () => {
  it("says when they can send again, and never blames a shared network on one user", () => {
    const threeHours = 3 * 60 * 60 * 1000;
    const ownerRefusal = buildTestSendRefusalMessage({
      kind: "owner",
      isClaimedTier: false,
      msUntilReset: threeHours,
    });
    const originRefusal = buildTestSendRefusalMessage({
      kind: "origin",
      isClaimedTier: false,
      msUntilReset: threeHours,
    });
    const recipientRefusal = buildTestSendRefusalMessage({
      kind: "recipient",
      isClaimedTier: false,
      msUntilReset: threeHours,
    });

    for (const message of [ownerRefusal, originRefusal, recipientRefusal]) {
      expect(message).toContain("in about 3 hours");
      /* A cap is a state of an allowance, not an accusation. */
      expect(message).not.toMatch(/abuse|blocked|banned|spam|violat|suspicious/i);
    }
    /* The origin bucket pools strangers, so it must not say "you did this". */
    expect(originRefusal).toContain("from this connection");
    /* An anonymous caller is told the thing that actually raises their cap. */
    expect(ownerRefusal).toContain("Adding your email");
    expect(
      buildTestSendRefusalMessage({
        kind: "owner",
        isClaimedTier: true,
        msUntilReset: threeHours,
      }),
    ).not.toContain("Adding your email");
  });

  it("rounds the wait to something a person would say out loud", () => {
    expect(describeRetryDelay(0)).toBe("in a moment");
    expect(describeRetryDelay(30_000)).toBe("in a moment");
    expect(describeRetryDelay(70_000)).toBe("in about a minute");
    expect(describeRetryDelay(20 * 60_000)).toBe("in about 20 minutes");
    expect(describeRetryDelay(60 * 60_000)).toBe("in about an hour");
    expect(describeRetryDelay(23 * 60 * 60_000)).toBe("in about 23 hours");
  });
});
