// @vitest-environment edge-runtime
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "@convex/_generated/api";
import schema from "@convex/schema";
import {
  coarsenClientAddress,
  deriveMagicLinkBucketKeys,
  MAGIC_LINK_COOLDOWN_MESSAGE,
  MAGIC_LINK_EMPTY_EMAIL_MESSAGE,
  MAGIC_LINK_ORIGIN_LIMIT_MESSAGE,
  MAGIC_LINK_UNAVAILABLE_MESSAGE,
  normalizeMagicLinkEmail,
} from "@convex/authMagicLink";

/*
  The guard behind the open sign-up door (convex/authMagicLink.ts).

  `/sign-in/magic-link` no longer refuses addresses it has never seen — a
  first-time visitor typing their own email is the front door, not an attack.
  What replaces the refusal is metering, and these tests are the proof that the
  meter actually meters:

    - a brand-new address gets its link (the whole point of the change);
    - the same address asking again immediately does not (one inbox cannot be
      buried, and repeated taps produce one email);
    - a client walking a list of DIFFERENT strangers runs out (the mail-relay
      attack the old refusal was really aimed at);
    - and no refusal says whether the address is registered — the guard never
      reads the user table, so sign-up and sign-in are indistinguishable from
      outside.

  The limiter is exercised through the real Convex mutation, so the rolling
  window, the lazy expiry and the all-or-nothing write are all live here.
*/

/*
  NOTE: convex-test's documented `!(*.*.*)` extglob matches nothing under
  vitest 4 (tinyglobby has no extglob support) — the array form with negative
  patterns is the equivalent that works.
*/
const modules = import.meta.glob([
  "../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

const COOLDOWN_FLAG = "FLOCK_MAGIC_LINK_COOLDOWN_SECONDS";
const SENDS_FLAG = "FLOCK_MAGIC_LINK_SENDS_PER_HOUR";

/*
  One browser, one network — the headers a proxied request actually carries.
*/
const CLIENT_HEADERS = new Headers({ "x-forwarded-for": "203.0.113.9, 198.51.100.1" });
/*
  A different network entirely.
*/
const OTHER_CLIENT_HEADERS = new Headers({ "x-forwarded-for": "192.0.2.44" });

const previousCooldown = process.env[COOLDOWN_FLAG];
const previousSends = process.env[SENDS_FLAG];

afterEach(() => {
  restoreFlag(COOLDOWN_FLAG, previousCooldown);
  restoreFlag(SENDS_FLAG, previousSends);
});

function restoreFlag(name: string, previous: string | undefined) {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

function createBackend() {
  return convexTest(schema, modules);
}

type Backend = ReturnType<typeof createBackend>;

/*
  One request for a sign-in link, exactly as the auth hook makes it.
*/
async function requestLink(
  t: Backend,
  args: { email: string; headers?: Headers },
): Promise<{ isAllowed: boolean; refusalMessage: string }> {
  const keys = await deriveMagicLinkBucketKeys({
    email: args.email,
    headers: args.headers ?? CLIENT_HEADERS,
  });
  return await t.mutation(internal.authMagicLink.reserveMagicLinkSend, {
    addressKey: keys.addressKey,
    ...(keys.originKey === undefined ? {} : { originKey: keys.originKey }),
  });
}

/*
  The rollback the auth hook runs when the mail provider throws.
*/
async function releaseAfterFailedSend(t: Backend, email: string): Promise<void> {
  const { addressKey } = await deriveMagicLinkBucketKeys({ email, headers: undefined });
  await t.mutation(internal.authMagicLink.releaseMagicLinkAddressCooldown, { addressKey });
}

describe("a send that never went out", () => {
  beforeEach(() => {
    process.env[COOLDOWN_FLAG] = "180";
    process.env[SENDS_FLAG] = "3";
  });

  it("lets the person try again immediately instead of claiming a link is coming", async () => {
    const t = createBackend();
    expect((await requestLink(t, { email: "sam@example.com" })).isAllowed).toBe(true);
    /*
      Resend throws — the cooldown was charged for mail nobody received.
    */
    await releaseAfterFailedSend(t, "sam@example.com");

    const retry = await requestLink(t, { email: "sam@example.com" });
    expect(retry.isAllowed).toBe(true);
    expect(retry.refusalMessage).toBe("");
  });

  it("still spends the origin allowance, so failures are not free retries", async () => {
    const t = createBackend();
    /*
      Three sends that all fail. The address is released every time, but the
      origin allowance (3/hour) is not — otherwise a client that can force
      failures gets unlimited attempts at strangers.
    */
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      expect((await requestLink(t, { email })).isAllowed).toBe(true);
      await releaseAfterFailedSend(t, email);
    }
    const fourth = await requestLink(t, { email: "d@example.com" });
    expect(fourth.isAllowed).toBe(false);
    expect(fourth.refusalMessage).toBe(MAGIC_LINK_ORIGIN_LIMIT_MESSAGE);
  });

  it("is harmless when there is no cooldown row to give back", async () => {
    const t = createBackend();
    await expect(releaseAfterFailedSend(t, "never-asked@example.com")).resolves.toBeUndefined();
  });
});

describe("a stranger's first sign-in link", () => {
  beforeEach(() => {
    /*
      Roomy enough that the origin allowance is never what refuses these.
    */
    process.env[SENDS_FLAG] = "10";
  });

  it("lets an address nobody has ever seen through", async () => {
    const t = createBackend();
    expect(await requestLink(t, { email: "brand.new@example.com" })).toEqual({
      isAllowed: true,
      refusalMessage: "",
    });
  });

  it("refuses the same address asked for again straight away", async () => {
    const t = createBackend();
    await requestLink(t, { email: "brand.new@example.com" });

    const second = await requestLink(t, { email: "brand.new@example.com" });
    expect(second.isAllowed).toBe(false);
    expect(second.refusalMessage).toBe(MAGIC_LINK_COOLDOWN_MESSAGE);
  });

  it("treats casing and stray spaces as the same inbox", async () => {
    const t = createBackend();
    await requestLink(t, { email: "brand.new@example.com" });

    const disguised = await requestLink(t, { email: "  Brand.New@Example.COM " });
    expect(disguised.isAllowed).toBe(false);
    expect(disguised.refusalMessage).toBe(MAGIC_LINK_COOLDOWN_MESSAGE);
  });

  it("holds the cooldown even from a different network", async () => {
    const t = createBackend();
    await requestLink(t, { email: "brand.new@example.com" });

    const elsewhere = await requestLink(t, {
      email: "brand.new@example.com",
      headers: OTHER_CLIENT_HEADERS,
    });
    expect(elsewhere.isAllowed).toBe(false);
  });

  it("lets a different address through immediately — the cooldown is per inbox", async () => {
    const t = createBackend();
    await requestLink(t, { email: "first@example.com" });

    expect((await requestLink(t, { email: "second@example.com" })).isAllowed).toBe(true);
  });

  it("lets the address back in once the cooldown has passed", async () => {
    const t = createBackend();
    /*
      One second: the cooldown is real time, not a mocked clock, so the test
      proves expiry without waiting three minutes for it.
    */
    process.env[COOLDOWN_FLAG] = "1";
    await requestLink(t, { email: "brand.new@example.com" });

    const keys = await deriveMagicLinkBucketKeys({
      email: "brand.new@example.com",
      headers: CLIENT_HEADERS,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("authMagicLinkSends")
        .withIndex("by_bucketKey", (q) => q.eq("bucketKey", keys.addressKey))
        .first();
      expect(row).not.toBeNull();
      await ctx.db.patch(row!._id, { lastSentAtMs: row!.lastSentAtMs - 5_000 });
    });

    expect((await requestLink(t, { email: "brand.new@example.com" })).isAllowed).toBe(true);
  });
});

describe("one client walking a list of strangers", () => {
  beforeEach(() => {
    process.env[SENDS_FLAG] = "3";
  });

  it("runs out after the hourly allowance, however many addresses it tries", async () => {
    const t = createBackend();

    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      expect((await requestLink(t, { email })).isAllowed).toBe(true);
    }

    const fourth = await requestLink(t, { email: "d@example.com" });
    expect(fourth.isAllowed).toBe(false);
    expect(fourth.refusalMessage).toBe(MAGIC_LINK_ORIGIN_LIMIT_MESSAGE);
  });

  it("does not spend another network's allowance", async () => {
    const t = createBackend();
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      await requestLink(t, { email });
    }

    const elsewhere = await requestLink(t, {
      email: "d@example.com",
      headers: OTHER_CLIENT_HEADERS,
    });
    expect(elsewhere.isAllowed).toBe(true);
  });

  it("charges nothing when it refuses, so a refusal is not a second penalty", async () => {
    const t = createBackend();
    process.env[SENDS_FLAG] = "2";
    await requestLink(t, { email: "a@example.com" });
    await requestLink(t, { email: "b@example.com" });
    await requestLink(t, { email: "c@example.com" });

    /*
      The refused address must not have had a cooldown row written for it:
      otherwise a blocked send would silently lock that inbox out too.
    */
    const keys = await deriveMagicLinkBucketKeys({
      email: "c@example.com",
      headers: CLIENT_HEADERS,
    });
    const refusedRow = await t.run(async (ctx) =>
      ctx.db
        .query("authMagicLinkSends")
        .withIndex("by_bucketKey", (q) => q.eq("bucketKey", keys.addressKey))
        .first(),
    );
    expect(refusedRow).toBeNull();
  });

  it("still applies the address cooldown when no client address is visible", async () => {
    const t = createBackend();
    const headers = new Headers();

    expect((await requestLink(t, { email: "a@example.com", headers })).isAllowed).toBe(true);
    expect((await requestLink(t, { email: "a@example.com", headers })).isAllowed).toBe(false);
    /*
      Nothing to charge an origin allowance against, so other addresses flow.
    */
    expect((await requestLink(t, { email: "b@example.com", headers })).isAllowed).toBe(true);
  });
});

describe("nothing the caller sees reveals whether the address is registered", () => {
  it("says the same words for every refusal, and never mentions accounts", async () => {
    const t = createBackend();
    process.env[SENDS_FLAG] = "1";

    /*
      A known address and an unknown one are indistinguishable by construction:
      the guard is keyed on a hash of the address and never reads the user
      table. These are the only strings a caller can ever be shown.
    */
    const cooldownRefusal = await (async () => {
      await requestLink(t, { email: "known@example.com" });
      return await requestLink(t, { email: "known@example.com" });
    })();
    const allowanceRefusal = await requestLink(t, { email: "never-seen@example.com" });

    expect(cooldownRefusal.refusalMessage).toBe(MAGIC_LINK_COOLDOWN_MESSAGE);
    expect(allowanceRefusal.refusalMessage).toBe(MAGIC_LINK_ORIGIN_LIMIT_MESSAGE);

    for (const message of [
      MAGIC_LINK_COOLDOWN_MESSAGE,
      MAGIC_LINK_ORIGIN_LIMIT_MESSAGE,
      MAGIC_LINK_EMPTY_EMAIL_MESSAGE,
      MAGIC_LINK_UNAVAILABLE_MESSAGE,
    ]) {
      expect(message).not.toMatch(/account|registered|sign ?up|unknown|exists|we don't have/i);
    }
  });
});

describe("bucket keys give nothing away", () => {
  it("stores a digest, never the address or the email", async () => {
    const t = createBackend();
    await requestLink(t, { email: "someone@example.com" });

    const rows = await t.run(async (ctx) => ctx.db.query("authMagicLinkSends").collect());
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("someone@example.com");
    expect(serialized).not.toContain("203.0.113.9");
    expect(rows).toHaveLength(2);
  });

  it("coarsens IPv6 to the /64 one subscriber controls, and keeps IPv4 whole", () => {
    expect(coarsenClientAddress("203.0.113.9")).toBe("203.0.113.9");
    expect(coarsenClientAddress("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2");
    expect(coarsenClientAddress("[2001:db8:1:2:3:4:5:6]:443")).toBe("2001:db8:1:2");
  });

  it("normalizes an absent or non-string email to nothing to send to", () => {
    expect(normalizeMagicLinkEmail(undefined)).toBe("");
    expect(normalizeMagicLinkEmail("  ")).toBe("");
    expect(normalizeMagicLinkEmail(" Sam@Site.com ")).toBe("sam@site.com");
  });
});
