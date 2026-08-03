import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";

/**
 * The two limits that make an OPEN magic-link endpoint safe to expose.
 *
 * `/sign-in/magic-link` sends real email to whatever address it is handed, from
 * our verified domain. Anyone may now request one (convex/auth.ts explains why
 * that is the right front door), so the abuse we have to price in is a script
 * using this deployment to drop mail into inboxes that never asked for it. The
 * cost of that is the sending domain's reputation, which is not something we
 * can buy back.
 *
 * Better Auth's own rate limiter is the coarse brake in front of this; it
 * cannot be the whole answer, because behind Convex it has no trustworthy
 * client IP to bucket on (measured — see the rateLimit note in
 * convex/auth.ts). So the per-person limits live here, where the request
 * headers ARE readable, and they come in two shapes because one alone is
 * useless:
 *
 *   ADDRESS COOLDOWN. One address may be mailed once every few minutes.
 *   This is what stops a single inbox being buried, and it doubles as ordinary
 *   good behaviour — a person who taps "send" three times gets one email.
 *
 *   ORIGIN ALLOWANCE. One coarsened client address may trigger only a handful
 *   of sends per hour. Without it, the cooldown is trivially defeated by
 *   walking a list of DIFFERENT strangers' addresses, which is precisely the
 *   mail-relay attack.
 *
 * NEITHER KEY IS STORED IN THE CLEAR. Rows hold salted SHA-256 digests
 * truncated to 32 hex characters — the same shape and the same reasoning as
 * apps/web/src/lib/auth/origin-key.ts, mirrored rather than imported because
 * Convex bundles only the `convex/` directory and cannot reach the web app's
 * `server-only` modules. The consequences are worth restating:
 *   - this table cannot be read as a list of who was mailed, or from where;
 *   - the keys are unguessable without the deployment secret, so nobody can
 *     pre-burn a stranger's cooldown or a rival network's allowance;
 *   - rotating the secret resets every bucket, which is the escape hatch if
 *     one ever gets wedged.
 *
 * HONEST LIMITS, same as the credit buckets: this is a speed bump against a
 * script, not a defence against a proxy pool. It also pools an office behind
 * one NAT into a single hourly allowance, which is why the numbers are
 * env-tunable — a deployment that outgrows the defaults should raise them
 * rather than tear the guard out.
 */

/** Minutes-scale, so a real "I didn't get it" resend is not a dead end. */
const DEFAULT_COOLDOWN_SECONDS = 180;
/** Deliberately small: a person needs one link, maybe two after a typo. */
const DEFAULT_SENDS_PER_ORIGIN_PER_HOUR = 3;
const ORIGIN_WINDOW_MS = 60 * 60 * 1000;

/** Cheap, non-secret fallback so a missing secret degrades rather than throws. */
const FALLBACK_SALT = "flock-magic-link";

/**
 * USER-FACING COPY. Every refusal below is identical for an address we know
 * and an address we have never seen — the guard never consults the user table,
 * so there is nothing here to leak and no timing difference to measure.
 */
export const MAGIC_LINK_EMPTY_EMAIL_MESSAGE =
  "Add an email address and we'll send you a link.";

export const MAGIC_LINK_COOLDOWN_MESSAGE =
  "A link is already on its way to that address. Have a look in your inbox — you can ask for another one in a few minutes.";

export const MAGIC_LINK_ORIGIN_LIMIT_MESSAGE =
  "That's a lot of sign-in links from this connection in the last hour. Try again a little later.";

export const MAGIC_LINK_UNAVAILABLE_MESSAGE =
  "We couldn't send your link just now. Please try again in a moment.";

function readPositiveInt(args: { name: string; fallback: number }): number {
  const parsed = Number(process.env[args.name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : args.fallback;
}

function readSalt(): string {
  // Reuses the auth secret rather than adding another variable to configure:
  // it is already required, already high-entropy, and already server-only.
  const secret = process.env.BETTER_AUTH_SECRET;
  return secret !== undefined && secret.length > 0 ? secret : FALLBACK_SALT;
}

/** Web Crypto, not `node:crypto`: this module runs inside the Convex runtime. */
async function hashWithSalt(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(`${readSalt()}\n${value}`);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/**
 * The address as a bucket identity: trimmed and lowercased, so "Sam@Site.com "
 * and "sam@site.com" cannot each buy their own cooldown.
 */
export function normalizeMagicLinkEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

/**
 * Coarsen an address to the unit one subscriber controls: a whole IPv4
 * address, or an IPv6 /64 prefix. Hashing a full IPv6 address would buy
 * nothing — a single subscriber is routinely handed a whole /64 and can pick
 * new addresses inside it at will.
 */
export function coarsenClientAddress(address: string): string {
  const withoutPort = address.startsWith("[")
    ? (address.slice(1).split("]")[0] ?? address)
    : address;
  if (!withoutPort.includes(":")) {
    return withoutPort;
  }
  return withoutPort.split(":").slice(0, 4).join(":");
}

/**
 * The client address as the proxies in front of us report it. The LEFTMOST
 * `x-forwarded-for` entry is the browser; everything after it is a hop (Vercel
 * egress, then Convex's edge), which is exactly why Better Auth's own resolver
 * declines to trust the header and we read it ourselves.
 */
function readClientAddress(headers: Headers | undefined): string | null {
  if (headers === undefined) {
    return null;
  }
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor !== null && forwardedFor.length > 0) {
    const first = forwardedFor.split(",")[0]?.trim() ?? "";
    if (first.length > 0) {
      return first;
    }
  }
  const realIp = headers.get("x-real-ip");
  return realIp !== null && realIp.length > 0 ? realIp.trim() : null;
}

/**
 * The opaque bucket keys for one send request. `originKey` is undefined when
 * no client address is visible (local dev, direct calls, tests); the origin
 * allowance is then simply not charged, and the address cooldown still holds.
 */
export async function deriveMagicLinkBucketKeys(args: {
  email: string;
  headers: Headers | undefined;
}): Promise<{ addressKey: string; originKey: string | undefined }> {
  const addressKey = `address:${await hashWithSalt(normalizeMagicLinkEmail(args.email))}`;
  const address = readClientAddress(args.headers);
  if (address === null) {
    return { addressKey, originKey: undefined };
  }
  return {
    addressKey,
    originKey: `origin:${await hashWithSalt(coarsenClientAddress(address))}`,
  };
}

/**
 * Claim the right to send one magic link, or explain why not.
 *
 * Returns a result instead of throwing: "you asked too soon" is an expected
 * state that the caller turns into copy and an HTTP status, not an error.
 *
 * ALL-OR-NOTHING, like authCredits.spend: both buckets are read before either
 * is written, so a refusal never leaves the origin allowance charged for mail
 * that was never sent. Convex mutations are transactional, so two requests
 * racing the same cooldown cannot both win.
 *
 * CHARGED BEFORE THE SEND, never after — a send that is in flight has to be
 * counted, or two tabs racing each other both get through. If the send then
 * fails, `releaseMagicLinkAddressCooldown` gives the ADDRESS bucket back; see
 * the note there for why the origin bucket is deliberately not refunded.
 */
export const reserveMagicLinkSend = internalMutation({
  args: {
    /** Salted digest of the normalized recipient address. */
    addressKey: v.string(),
    /** Salted digest of the coarsened client address; absent when unknown. */
    originKey: v.optional(v.string()),
  },
  returns: v.object({
    isAllowed: v.boolean(),
    /** Empty when allowed; otherwise the exact words to show the person. */
    refusalMessage: v.string(),
  }),
  handler: async (ctx, args) => {
    const nowMs = Date.now();
    const cooldownMs =
      readPositiveInt({
        name: "FLOCK_MAGIC_LINK_COOLDOWN_SECONDS",
        fallback: DEFAULT_COOLDOWN_SECONDS,
      }) * 1000;
    const sendsPerHour = readPositiveInt({
      name: "FLOCK_MAGIC_LINK_SENDS_PER_HOUR",
      fallback: DEFAULT_SENDS_PER_ORIGIN_PER_HOUR,
    });

    const addressRow = await readBucket(ctx, args.addressKey);
    if (addressRow !== null && nowMs - addressRow.lastSentAtMs < cooldownMs) {
      return { isAllowed: false, refusalMessage: MAGIC_LINK_COOLDOWN_MESSAGE };
    }

    const originRow =
      args.originKey === undefined ? null : await readBucket(ctx, args.originKey);
    // Expiry is LAZY, as in authCredits: a window that elapsed simply starts
    // again on the next send, so there is no cron and an idle origin costs
    // nothing.
    const isOriginWindowLive =
      originRow !== null && nowMs - originRow.windowStartMs < ORIGIN_WINDOW_MS;
    const sentThisWindow = isOriginWindowLive ? (originRow?.sentCount ?? 0) : 0;
    if (args.originKey !== undefined && sentThisWindow >= sendsPerHour) {
      return { isAllowed: false, refusalMessage: MAGIC_LINK_ORIGIN_LIMIT_MESSAGE };
    }

    await writeBucket(ctx, {
      key: args.addressKey,
      existingId: addressRow?._id ?? null,
      windowStartMs: nowMs,
      sentCount: 1,
      nowMs,
    });
    if (args.originKey !== undefined) {
      await writeBucket(ctx, {
        key: args.originKey,
        existingId: originRow?._id ?? null,
        windowStartMs: isOriginWindowLive ? (originRow?.windowStartMs ?? nowMs) : nowMs,
        sentCount: sentThisWindow + 1,
        nowMs,
      });
    }

    return { isAllowed: true, refusalMessage: "" };
  },
});

/**
 * Hand back the address cooldown after a send that never actually went out.
 *
 * Without this, a failing mail provider reads to the person as "a link is
 * already on its way" — the most misleading copy we could show, because it
 * says the thing that just failed succeeded, and it locks them out of
 * retrying for the whole cooldown. That is not hypothetical: the first real
 * sign-in attempt in production hit exactly this, because RESEND_API_KEY was
 * set on Vercel while `sendMagicLinkEmail` runs inside Convex.
 *
 * THE ORIGIN ALLOWANCE IS NOT REFUNDED, on purpose. The address cooldown
 * exists to protect one inbox, and a mail that never arrived did not bury
 * anyone — so returning it costs nothing and spares a real user. The origin
 * allowance exists to stop a client walking a list of strangers, and an
 * attacker who can make sends fail (bad addresses, a provider they have
 * poisoned) would otherwise get infinite free attempts. Refunding only the
 * half that protects the victim keeps the honest retry cheap and the abusive
 * one expensive.
 *
 * Deleting rather than back-dating: the row's whole meaning is "a link went
 * out at lastSentAtMs", and none did.
 */
export const releaseMagicLinkAddressCooldown = internalMutation({
  args: { addressKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await readBucket(ctx, args.addressKey);
    if (row !== null) {
      await ctx.db.delete(row._id);
    }
    return null;
  },
});

async function readBucket(
  ctx: MutationCtx,
  bucketKey: string,
): Promise<Doc<"authMagicLinkSends"> | null> {
  return await ctx.db
    .query("authMagicLinkSends")
    .withIndex("by_bucketKey", (q) => q.eq("bucketKey", bucketKey))
    .first();
}

async function writeBucket(
  ctx: MutationCtx,
  args: {
    key: string;
    existingId: Id<"authMagicLinkSends"> | null;
    windowStartMs: number;
    sentCount: number;
    nowMs: number;
  },
): Promise<void> {
  const fields = {
    bucketKey: args.key,
    windowStartMs: args.windowStartMs,
    sentCount: args.sentCount,
    lastSentAtMs: args.nowMs,
  };
  if (args.existingId === null) {
    await ctx.db.insert("authMagicLinkSends", fields);
    return;
  }
  await ctx.db.patch(args.existingId, fields);
}
