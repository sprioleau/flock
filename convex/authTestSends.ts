import { v } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server";
import { authComponent } from "./auth";
import { resolveOwnerIdOrNull } from "./authIdentity";

/*
  THE SEND METER — how many test emails one person may put in an inbox.

  WHAT THIS FINISHES. `POST /api/send-test-email` grew an identity gate: every
  send is now attributable to a session this server minted, and a bare curl with
  no session gets a 401. That closed half the hole. Identity is only WHO, never
  HOW MANY, and an ANONYMOUS session is free to mint — a browser is signed in
  anonymously the moment it lands on /studio, /demo, or a share link. So the gate
  alone still allows: mint a session, send, discard it, repeat, forever, mailing
  arbitrary content to arbitrary addresses from RESEND_FROM_EMAIL, DKIM-signed by
  this project's verified domain. The reputation of that domain is the asset
  actually at stake, and it is not something we can buy back. This module is the
  other half.

  NOT AN AI CREDIT, on the owner's instruction and for a good reason. Credits
  (convex/authCredits.ts) meter the daily MODEL allowance; a test send calls no
  model. Charging one would make that number mean two different things at once —
  "inference you asked for" and "mail you sent" — and would let a person who
  mailed themselves three drafts discover they can no longer talk to the agent.
  Separate concern, separate counter, separate table.

  THREE BUCKETS. Each answers a different question, and every one of them is
  load-bearing; drop any and a real attack reopens.

    owner:<better auth user id>
      The headline: this identity's own allowance. Two tiers, because a claimed
      account cost someone a round trip through their inbox and an anonymous one
      cost a click. Alone it is worthless — see the next bucket.

    origin:<salted, coarsened client address>
      THE ONE THAT DEFEATS MINT-A-NEW-SESSION. A per-identity cap is not a cap
      at all when a fresh identity is one click and one cleared localStorage
      away; the attacker simply takes a new bucket every time. The origin bucket
      is keyed to something the visitor cannot cheaply rotate and that a new
      identity does not reset, so N sessions from one network share ONE
      allowance. Charged to anonymous callers only: claimed accounts are the
      escape hatch for a throttled office, and pooling them would punish twenty
      colleagues for one person's afternoon. That exemption is not a hole,
      because minting claimed accounts is itself metered — each one costs a
      magic link, and convex/authMagicLink.ts caps those per origin too.

    recipient:<salted, normalized recipient address>
      The only bucket that survives a proxy pool. Origin coarsening is a speed
      bump, not a defence, against a VPN or a rented address range; an attacker
      with one can rotate past both buckets above. What they cannot rotate is
      the VICTIM — burying one specific inbox requires sending to that inbox.
      So this caps how much mail any single address can receive from this
      deployment per period, whoever is asking and from wherever. It is sized
      well ABOVE the per-identity tiers precisely so it never bites the ordinary
      case, which is a person mailing drafts to their own address all day.

  ALL-OR-NOTHING, the correctness rule taken verbatim from authCredits.spend:
  every applicable bucket is read before ANY is written. A refusal therefore
  never leaves the origin bucket charged for a send the owner bucket blocked.
  Convex mutations are transactional, so this holds under concurrency — two tabs
  racing the last unit of an allowance cannot both win it.

  LAZY EXPIRY, as in both neighbours: a window that has elapsed simply starts
  again on the next send. No cron, and an idle bucket costs nothing.

  RECIPIENT ADDRESSES ARE NEVER STORED IN THE CLEAR. The key is a salted digest
  derived in the Next route (apps/web/src/lib/auth/send-meter.ts), the same
  treatment and the same reasoning as authMagicLink's address buckets:
    - this table cannot be read back as a list of who Flock has mailed;
    - a key is unguessable without the deployment secret, so nobody can pre-burn
      a rival's recipient allowance to stop them receiving their own drafts;
    - rotating the secret resets every hashed bucket, which is the escape hatch
      if one ever gets wedged.
  Owner ids are NOT hashed, matching authCredits: an owner id is an opaque
  internal identifier rather than someone's personal data, it is already in the
  send logs, and leaving it legible is what lets an operator answer "why is this
  account blocked" without a rainbow table.

  HONEST LIMITS. Same as every other meter here: this stops the cheap attack —
  cleared storage, incognito windows, a loop over curl — and it bounds the
  expensive one. It does not stop a determined attacker with a large proxy pool
  from sending up to the RECIPIENT cap at any one address, which is the point of
  having that cap at all.
*/

/* A full day of intense authoring. Someone who needs more is a real user. */
const DEFAULT_CLAIMED_TEST_SENDS = 30;
/*
  Enough to iterate on a draft and watch it land several times over, which is
  the whole reason a visitor would try the feature. The gap to the claimed tier
  is the product argument for adding an email address — a better one than any
  copy we could write.
*/
const DEFAULT_ANONYMOUS_TEST_SENDS = 8;
/*
  Roughly two and a half anonymous sessions' worth. Deliberately NOT a multiple
  large enough to make minting worthwhile: the whole job of this number is to
  make the tenth fresh session no more useful than the third.
*/
const DEFAULT_ANONYMOUS_ORIGIN_TEST_SENDS = 20;
/*
  Above the claimed tier on purpose. A single author must be able to spend their
  ENTIRE allowance on their own inbox without this bucket ever being what stops
  them; it exists for the address nobody asked to be mailed, not for the one
  someone is testing.
*/
const DEFAULT_RECIPIENT_TEST_SENDS = 40;
/* Matches authCredits, so "today's allowance" means the same thing in both. */
const DEFAULT_PERIOD_HOURS = 24;

function readPositiveInt(args: { name: string; fallback: number }): number {
  const parsed = Number(process.env[args.name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : args.fallback;
}

function readPeriodMs(): number {
  const parsed = Number(process.env.FLOCK_TEST_SEND_PERIOD_HOURS);
  const hours = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PERIOD_HOURS;
  return hours * 60 * 60 * 1000;
}

/*
  USER-FACING COPY.

  Every string below is a statement about the STATE OF AN ALLOWANCE, never a
  verdict on the person — the same posture as the route's NOT_SIGNED_IN_MESSAGE
  ("This Flock couldn't confirm who's sending"), and for the same reason: on a
  normal deployment the overwhelmingly likely reader is someone who did nothing
  wrong. Each one says WHEN they can send again, because we know: the window is
  a rolling period with a computable end, and "try again later" when we could
  have said "in about three hours" is withholding the only useful part.
*/

/* Rounded, never precise: a countdown to the second invites watching it. */
export function describeRetryDelay(msUntilReset: number): string {
  if (msUntilReset <= 60_000) {
    return "in a moment";
  }
  const minutes = Math.round(msUntilReset / 60_000);
  if (minutes < 60) {
    return minutes === 1 ? "in about a minute" : `in about ${minutes} minutes`;
  }
  const hours = Math.max(1, Math.round(msUntilReset / (60 * 60 * 1000)));
  return hours === 1 ? "in about an hour" : `in about ${hours} hours`;
}

/* Which bucket ran out — chooses the copy, and nothing else. */
type BucketKind = "owner" | "origin" | "recipient";

type Bucket = { kind: BucketKind; key: string; limit: number };

export function buildTestSendRefusalMessage(args: {
  kind: BucketKind;
  isClaimedTier: boolean;
  msUntilReset: number;
}): string {
  const delay = describeRetryDelay(args.msUntilReset);
  if (args.kind === "recipient") {
    /*
      Names the address as the thing that is full, not the sender, because on a
      shared team inbox the person reading this may have sent none of them. And
      it offers the remedy that works immediately: a different address.
    */
    return `That address has had a lot of test emails today. Try a different address, or send to it again ${delay}.`;
  }
  if (args.kind === "origin") {
    /*
      "This connection", not "you" — the origin bucket pools everyone behind one
      network, so blaming the reader would frequently be false. The nudge is
      honest rather than promotional: claiming really does move them out of this
      bucket entirely.
    */
    return `That's a lot of test sends from this connection today. You can send again ${delay}, or add your email to get your own allowance.`;
  }
  if (args.isClaimedTier) {
    return `You've used today's test sends — the allowance refills ${delay}.`;
  }
  return `You've used today's test sends — the allowance refills ${delay}. Adding your email raises it.`;
}

/*
  Is the caller a claimed account? Read from the Better Auth user row, never
  from anything the client sent: the entire point is that a caller does not get
  to choose their own tier, or to opt out of the origin bucket by asserting one.
*/
async function getIsClaimedIdentity(ctx: MutationCtx): Promise<boolean> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    return false;
  }
  const user = await authComponent.safeGetAuthUser(ctx);
  return user !== undefined && user !== null && user.isAnonymous !== true;
}

/*
  The buckets this send is charged against.

  NEVER EMPTY in practice, which is a property authCredits does not have: a send
  always has a recipient, so the recipient bucket always exists. That is what
  keeps a deployment with auth switched off, or one behind no proxy at all, from
  being silently unmetered — the exact failure mode the credit meter documents
  as its "neither → no bucket" case.
*/
function resolveBuckets(args: {
  ownerId: string | null;
  isClaimed: boolean;
  originKey: string | undefined;
  recipientKey: string;
}): Bucket[] {
  const buckets: Bucket[] = [];
  /*
    No owner id means either strict mode declined an unauthenticated caller or
    this deployment has no identity system at all. Either way there is nobody to
    charge, and inventing a bucket from a client-supplied string would hand a
    scraped session id the power to burn its owner's allowance — the precise
    hole convex/authIdentity.ts exists to shut. The origin and recipient buckets
    carry the meter instead.
  */
  if (args.ownerId !== null) {
    buckets.push({
      kind: "owner",
      key: `owner:${args.ownerId}`,
      limit: args.isClaimed
        ? readPositiveInt({
            name: "FLOCK_TEST_SENDS_PER_PERIOD",
            fallback: DEFAULT_CLAIMED_TEST_SENDS,
          })
        : readPositiveInt({
            name: "FLOCK_ANONYMOUS_TEST_SENDS_PER_PERIOD",
            fallback: DEFAULT_ANONYMOUS_TEST_SENDS,
          }),
    });
  }
  if (!args.isClaimed && args.originKey !== undefined && args.originKey.length > 0) {
    buckets.push({
      kind: "origin",
      key: `origin:${args.originKey}`,
      limit: readPositiveInt({
        name: "FLOCK_ANONYMOUS_ORIGIN_TEST_SENDS_PER_PERIOD",
        fallback: DEFAULT_ANONYMOUS_ORIGIN_TEST_SENDS,
      }),
    });
  }
  buckets.push({
    kind: "recipient",
    key: `recipient:${args.recipientKey}`,
    limit: readPositiveInt({
      name: "FLOCK_RECIPIENT_TEST_SENDS_PER_PERIOD",
      fallback: DEFAULT_RECIPIENT_TEST_SENDS,
    }),
  });
  return buckets;
}

/* One bucket's state, without writing — a peek must never start a window. */
async function peekBucket(
  ctx: MutationCtx,
  args: { bucket: Bucket; nowMs: number; periodMs: number },
): Promise<{ sentCount: number; periodStartMs: number }> {
  const row = await ctx.db
    .query("authTestSends")
    .withIndex("by_bucketKey", (q) => q.eq("bucketKey", args.bucket.key))
    .first();
  if (row === null || args.nowMs - row.periodStartMs >= args.periodMs) {
    return { sentCount: 0, periodStartMs: args.nowMs };
  }
  return { sentCount: row.sentCount, periodStartMs: row.periodStartMs };
}

/*
  Claim the right to send one test email, or explain why not.

  Returns a result instead of throwing. An exhausted allowance is an EXPECTED
  state of the world, not an error: the route turns it into copy and a 429, and
  a thrown ConvexError would arrive at the client as an opaque failure with the
  sentence buried in it.

  A PUBLIC mutation, unlike authMagicLink's internal one, because its caller is
  a Next route reaching Convex over HTTP — internal functions are unreachable
  from there. That makes the identity resolution below load-bearing: the owner is
  taken from `ctx.auth`, which Convex verified from a signed token, and there is
  deliberately NO `sessionId` argument to fall back to. A caller who invokes this
  mutation directly can therefore only ever burn their OWN buckets.

  CHARGED BEFORE THE SEND, never after. Two reasons, and the first is the one
  that makes it non-negotiable: a send that is in flight has to be counted, or
  two tabs submitting at once both read an unspent allowance and both go out.
  Charging afterwards makes the meter downstream of the thing it is supposed to
  gate. The second: the asset being protected is the reputation of mail that has
  already LEFT, so the decision has to precede the departure.

  AND NO REFUND PATH, which is the deliberate half of that choice. It costs a
  real user an occasional unit when Resend has a bad minute, and the alternative
  costs more:
    - `send_failed` and `invalid_recipient` are the outcomes an attacker can
      MANUFACTURE at will (poisoned addresses, malformed recipients). Refunding
      them hands anyone who can force a failure an unlimited supply of free
      attempts, which is exactly the trap authMagicLink documents at its
      `releaseMagicLinkAddressCooldown` — it refunds only the bucket that
      protects a victim, never the one that protects against abuse.
    - Applying that same split HERE buys the user nothing. The victim-protecting
      bucket is `recipient`, sized so it is never what stops a legitimate author;
      the bucket a frustrated user is actually up against is `owner`, which is
      abuse-protecting and must not be refunded. So a refund path would be a
      second write on the error path, a second way to spend without paying if it
      ever misfired, and zero improvement to the experience it was written for.
  authCredits reached the same conclusion for the same trade, and says so at its
  `spend`.
*/
export const reserveTestSend = mutation({
  args: {
    /* Salted digest of the normalized recipient address. Never the address. */
    recipientKey: v.string(),
    /* Salted digest of the coarsened client address; absent when unknown. */
    originKey: v.optional(v.string()),
  },
  returns: v.object({
    isAllowed: v.boolean(),
    /* Empty when allowed; otherwise the exact words to show the person. */
    refusalMessage: v.string(),
    /* When the blocking bucket refills. Null when nothing blocked. */
    retryAtMs: v.union(v.null(), v.number()),
  }),
  handler: async (ctx, args) => {
    const ownerId = await resolveOwnerIdOrNull(ctx);
    const isClaimed = await getIsClaimedIdentity(ctx);
    const periodMs = readPeriodMs();
    const nowMs = Date.now();
    const buckets = resolveBuckets({
      ownerId,
      isClaimed,
      originKey: args.originKey,
      recipientKey: args.recipientKey,
    });

    /* Read every bucket first. Nothing below writes until all of them pass. */
    const planned: { bucket: Bucket; sentCount: number; periodStartMs: number }[] = [];
    for (const bucket of buckets) {
      const state = await peekBucket(ctx, { bucket, nowMs, periodMs });
      planned.push({ bucket, ...state });
    }

    const blocked = planned.find((entry) => entry.sentCount + 1 > entry.bucket.limit);
    if (blocked !== undefined) {
      const retryAtMs = blocked.periodStartMs + periodMs;
      return {
        isAllowed: false,
        refusalMessage: buildTestSendRefusalMessage({
          kind: blocked.bucket.kind,
          isClaimedTier: isClaimed,
          msUntilReset: Math.max(0, retryAtMs - nowMs),
        }),
        retryAtMs,
      };
    }

    for (const entry of planned) {
      const existing = await ctx.db
        .query("authTestSends")
        .withIndex("by_bucketKey", (q) => q.eq("bucketKey", entry.bucket.key))
        .first();
      const fields = {
        bucketKey: entry.bucket.key,
        periodStartMs: entry.periodStartMs,
        sentCount: entry.sentCount + 1,
        updatedAtMs: nowMs,
      };
      if (existing === null) {
        await ctx.db.insert("authTestSends", fields);
      } else {
        await ctx.db.patch(existing._id, fields);
      }
    }

    return { isAllowed: true, refusalMessage: "", retryAtMs: null };
  },
});
