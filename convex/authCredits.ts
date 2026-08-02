import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { authComponent } from "./auth";
import { resolveOwnerId } from "./authIdentity";

/**
 * The inference allowance: how much model work one person may ask for per
 * window, so a public demo cannot burn the API quota behind it.
 *
 * TWO TIERS, because an anonymous visitor and a claimed account are not the
 * same risk. A claimed account cost someone a round trip through their inbox;
 * an anonymous one costs a click. So:
 *
 *   FLOCK_CREDITS_PER_PERIOD            claimed accounts   (default 25)
 *   FLOCK_ANONYMOUS_CREDITS_PER_PERIOD  anonymous sessions (default 5)
 *
 * The gap is deliberate and is the product argument for claiming: "add your
 * email and get more" is a better reason than any copy we could write.
 *
 * TWO BUCKETS, because a per-identity cap is not a limit at all against
 * someone willing to clear storage. Signing out and back in mints a brand-new
 * anonymous user with a brand-new empty allowance — one click, unlimited
 * repeats. So an anonymous spend is charged TWICE: once to the identity, and
 * once to a shared per-origin bucket that a new identity does not reset.
 *
 *   FLOCK_ANONYMOUS_ORIGIN_CREDITS_PER_PERIOD (default 20)
 *
 * WHAT THE ORIGIN BUCKET ACTUALLY BUYS, honestly:
 *   - It stops the cheap attack: clearing storage, incognito windows, several
 *     browsers on one machine. That is the realistic abuse for a demo link.
 *   - It does NOT stop a determined attacker with a VPN, a proxy pool, or a
 *     phone hopping carrier NAT. Nothing short of real verification does, and
 *     real verification is exactly the friction this product refuses.
 *   - It OVER-restricts shared networks — an office or a conference where
 *     twenty people open the demo at once share one bucket. That is why the
 *     origin allowance is several times the per-identity one, and why claimed
 *     accounts are exempt from it entirely: the escape hatch for a throttled
 *     network is to claim an account, which is the behavior we want anyway.
 *
 * The address is coarsened and salted before it ever reaches Convex
 * (apps/web/src/lib/auth/credits.ts). This table stores an opaque hash and
 * cannot be read as a log of who visited from where.
 *
 * WHAT COSTS A CREDIT: user-initiated inference — a chat turn, a manual
 * persona sweep, a brand scrape, an image generation.
 *
 * WHAT DOES NOT: agent-initiated inference. The proactive persona runner fires
 * off the op log without anyone asking for it. Charging a person for work they
 * did not request makes the number unpredictable and punishes them for
 * editing — the opposite of what an allowance is for. That path is already
 * throttled by its own per-persona `cooldownSeconds` (convex/schema.ts
 * `agents`), which is the right control for it: a cooldown throttles the
 * SYSTEM, a credit throttles a PERSON. Manual sweeps, where a human clicked,
 * do cost a credit (apps/web/src/app/api/personas/route.ts `isManualSweep`).
 *
 * THE OVERRIDE. Unlimited access is granted at the Next.js layer, not here:
 * it is proven by an httpOnly cookie (apps/web/src/lib/auth/owner-override.ts)
 * and Convex functions cannot read cookies. A caller holding the override
 * never reaches `spend`.
 *
 * SIZING vs THE PROVIDER QUOTA. These are different limits doing different
 * jobs and neither substitutes for the other. The Gemini free tier allows ~20
 * requests/day for the WHOLE deployment; two visitors on a 25/day allowance
 * can exhaust it between them. Treat credits as per-person fairness and the
 * provider quota as the hard ceiling — on a free key, set the numbers well
 * below it; on a paid key, size them for the experience you want.
 */

const DEFAULT_CLAIMED_CREDITS = 25;
const DEFAULT_ANONYMOUS_CREDITS = 5;
const DEFAULT_ANONYMOUS_ORIGIN_CREDITS = 20;
const DEFAULT_PERIOD_HOURS = 24;

function readPositiveInt(args: { name: string; fallback: number }): number {
  const parsed = Number(process.env[args.name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : args.fallback;
}

function readPeriodMs(): number {
  const parsed = Number(process.env.FLOCK_CREDIT_PERIOD_HOURS);
  const hours = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PERIOD_HOURS;
  return hours * 60 * 60 * 1000;
}

/**
 * Is the caller a claimed account? Anonymous callers — and signed-out ones
 * during the pre-roll-out window — get the stricter tier. Read from the Better
 * Auth user row, never from a client-supplied hint: the whole point is that
 * the caller does not get to choose their own tier.
 */
async function isClaimedIdentity(ctx: QueryCtx | MutationCtx): Promise<boolean> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    return false;
  }
  const user = await authComponent.safeGetAuthUser(ctx);
  return user !== undefined && user !== null && user.isAnonymous !== true;
}

const balanceValidator = v.object({
  limit: v.number(),
  spent: v.number(),
  remaining: v.number(),
  /** When the current window rolls over and the allowance refills. */
  resetsAtMs: v.number(),
  /** True for claimed accounts — the UI uses it to explain the bigger cap. */
  isClaimedTier: v.boolean(),
});

type Bucket = { key: string; limit: number };

/** One bucket's state, without writing (a peek must never start a window). */
async function peekBucket(
  ctx: QueryCtx | MutationCtx,
  args: { bucket: Bucket; nowMs: number; periodMs: number },
): Promise<{ spent: number; periodStartMs: number }> {
  const row = await ctx.db
    .query("authCredits")
    .withIndex("by_bucketKey", (q) => q.eq("bucketKey", args.bucket.key))
    .first();
  if (row === null || args.nowMs - row.periodStartMs >= args.periodMs) {
    return { spent: 0, periodStartMs: args.nowMs };
  }
  return { spent: row.spentCount, periodStartMs: row.periodStartMs };
}

/** The buckets a caller is charged against. */
function resolveBuckets(args: {
  ownerId: string;
  isClaimed: boolean;
  originKey: string | undefined;
}): Bucket[] {
  const buckets: Bucket[] = [
    {
      key: `owner:${args.ownerId}`,
      limit: args.isClaimed
        ? readPositiveInt({
            name: "FLOCK_CREDITS_PER_PERIOD",
            fallback: DEFAULT_CLAIMED_CREDITS,
          })
        : readPositiveInt({
            name: "FLOCK_ANONYMOUS_CREDITS_PER_PERIOD",
            fallback: DEFAULT_ANONYMOUS_CREDITS,
          }),
    },
  ];
  // Claimed accounts are exempt from the shared bucket: they are the escape
  // hatch for a throttled network, and pooling them would punish a whole
  // office for one person's usage.
  if (!args.isClaimed && args.originKey !== undefined && args.originKey.length > 0) {
    buckets.push({
      key: `origin:${args.originKey}`,
      limit: readPositiveInt({
        name: "FLOCK_ANONYMOUS_ORIGIN_CREDITS_PER_PERIOD",
        fallback: DEFAULT_ANONYMOUS_ORIGIN_CREDITS,
      }),
    });
  }
  return buckets;
}

/** The tightest of a set of bucket states — the one that will actually stop you. */
function pickTightest(
  entries: { limit: number; spent: number; periodStartMs: number }[],
  args: { nowMs: number; periodMs: number },
): { limit: number; spent: number; remaining: number; resetsAtMs: number } {
  let tightest = {
    limit: 0,
    spent: 0,
    remaining: Number.POSITIVE_INFINITY,
    resetsAtMs: args.nowMs + args.periodMs,
  };
  for (const entry of entries) {
    const remaining = Math.max(0, entry.limit - entry.spent);
    if (remaining < tightest.remaining) {
      tightest = {
        limit: entry.limit,
        spent: entry.spent,
        remaining,
        resetsAtMs: entry.periodStartMs + args.periodMs,
      };
    }
  }
  return tightest;
}

/**
 * The caller's current balance. Never writes, so polling it does not start a
 * window.
 */
export const getBalance = query({
  args: {
    sessionId: v.string(),
    /** Salted, coarsened origin hash; omitted by callers that cannot see one. */
    originKey: v.optional(v.string()),
  },
  returns: balanceValidator,
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const isClaimed = await isClaimedIdentity(ctx);
    const periodMs = readPeriodMs();
    const nowMs = Date.now();
    const buckets = resolveBuckets({ ownerId, isClaimed, originKey: args.originKey });

    const states = [];
    for (const bucket of buckets) {
      const state = await peekBucket(ctx, { bucket, nowMs, periodMs });
      states.push({ limit: bucket.limit, ...state });
    }
    return {
      ...pickTightest(states, { nowMs, periodMs }),
      isClaimedTier: isClaimed,
    };
  },
});

/**
 * Consume credits, or report that there are none left.
 *
 * Returns `isAllowed: false` rather than throwing: the caller (a Next route)
 * turns this into user-facing copy and an HTTP status, and an exhausted
 * allowance is an expected state, not an error.
 *
 * ALL-OR-NOTHING across buckets: every bucket is checked before any is
 * written, so a refusal never leaves the origin bucket charged for work the
 * identity bucket blocked. Convex mutations are transactional, so this holds
 * under concurrency.
 *
 * Charged BEFORE the model call, never after. A refund path would be a second
 * write on the error path and a way to spend without paying if it ever
 * misfired; a rare lost credit on a provider error is the cheaper trade.
 */
export const spend = mutation({
  args: {
    sessionId: v.string(),
    originKey: v.optional(v.string()),
    /** How many credits this piece of work costs. Defaults to one. */
    amount: v.optional(v.number()),
  },
  returns: v.object({ isAllowed: v.boolean(), balance: balanceValidator }),
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerId(ctx, { claimedSessionId: args.sessionId });
    const isClaimed = await isClaimedIdentity(ctx);
    const periodMs = readPeriodMs();
    const nowMs = Date.now();
    const amount = Math.max(1, Math.floor(args.amount ?? 1));
    const buckets = resolveBuckets({ ownerId, isClaimed, originKey: args.originKey });

    const planned: { bucket: Bucket; spent: number; periodStartMs: number }[] = [];
    for (const bucket of buckets) {
      const state = await peekBucket(ctx, { bucket, nowMs, periodMs });
      planned.push({ bucket, ...state });
    }

    const blocked = planned.find((entry) => entry.spent + amount > entry.bucket.limit);
    if (blocked !== undefined) {
      return {
        isAllowed: false,
        balance: {
          limit: blocked.bucket.limit,
          spent: blocked.spent,
          remaining: Math.max(0, blocked.bucket.limit - blocked.spent),
          resetsAtMs: blocked.periodStartMs + periodMs,
          isClaimedTier: isClaimed,
        },
      };
    }

    const states = [];
    for (const entry of planned) {
      const spentAfter = entry.spent + amount;
      const existing = await ctx.db
        .query("authCredits")
        .withIndex("by_bucketKey", (q) => q.eq("bucketKey", entry.bucket.key))
        .first();
      if (existing === null) {
        await ctx.db.insert("authCredits", {
          bucketKey: entry.bucket.key,
          periodStartMs: entry.periodStartMs,
          spentCount: spentAfter,
          updatedAtMs: nowMs,
        });
      } else {
        await ctx.db.patch(existing._id, {
          periodStartMs: entry.periodStartMs,
          spentCount: spentAfter,
          updatedAtMs: nowMs,
        });
      }
      states.push({
        limit: entry.bucket.limit,
        spent: spentAfter,
        periodStartMs: entry.periodStartMs,
      });
    }

    return {
      isAllowed: true,
      balance: {
        ...pickTightest(states, { nowMs, periodMs }),
        isClaimedTier: isClaimed,
      },
    };
  },
});
