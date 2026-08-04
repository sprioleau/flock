import type { CreditBalance, FlockIdentity } from "@/lib/auth/use-flock-auth";

/**
 * WHOSE LIST IS THIS? — the one question the dashboard must answer before it
 * puts words on an empty page.
 *
 * `canvases.listMyCanvases` returns `[]` for two completely different reasons
 * and the array cannot tell them apart:
 *
 *   1. The server knows who you are and you have made nothing yet.
 *   2. The server can name NO owner for you at all, so it has nothing to look
 *      up. On a strict deployment (FLOCK_REQUIRE_AUTH_IDENTITY=true, which is
 *      how production is configured) that is every signed-out visitor: the
 *      `sessionId` their browser sends is a scraped, published string and is
 *      deliberately inert (convex/authIdentity.ts).
 *
 * Case 2 rendered as case 1 is a lie with consequences. "Nothing here yet —
 * everything you make shows up here" is false twice over: work they already
 * made is not being listed, and work they make next will not be listed either,
 * because `recordCanvasOwner` writes no ownership row for a caller who names
 * nobody (convex/canvases.ts). They would keep writing emails into a dashboard
 * that keeps telling them it is empty.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW WE KNOW, without inventing a new query
 *
 * `authCredits.getBalance` already answers exactly this question as a side
 * effect of answering its own. It resolves the caller through the SAME
 * `resolveOwnerIdOrNull` that `listMyCanvases` uses, and returns `null` when no
 * bucket applies. From the browser that is precisely "the server could not name
 * an owner for me", because:
 *
 *   - an identity always produces an `owner:` bucket, so a signed-in caller is
 *     never null; and
 *   - the only other bucket is the per-ORIGIN one, and the browser can never
 *     produce an `originKey` — it is an HMAC of the client address derived from
 *     request headers with the server secret (apps/web/src/lib/auth/origin-key.ts,
 *     `node:crypto`, server-only). That is not an accident of the current code
 *     and must not become one: an origin key is a RATE-LIMIT bucket key, so a
 *     client that could choose its own could rotate it freely and walk straight
 *     out of the shared allowance.
 *
 * So `credits === null` ⟺ strict mode is on and this visitor is signed out.
 * If anyone ever plumbs an origin key into the client's `getBalance` call, this
 * inference breaks silently — hence the test file next to this one, which pins
 * every arm of the table below.
 *
 * WITH AUTH OFF the credits query is skipped entirely and stays `undefined`
 * forever, so it can never be waited on: the pre-auth deployment resolves
 * straight to "attributed", which is the truth there (the localStorage id IS
 * the ownership key, byte-for-byte the behavior that shipped before auth).
 */
export type DashboardAttribution =
  /** Still asking. Show the skeleton rather than guess at the copy. */
  | "resolving"
  /** The server can name an owner for this caller; an empty list is genuine. */
  | "attributed"
  /** The server can name nobody; an empty list means nothing about this person. */
  | "unattributed";

export function resolveDashboardAttribution(args: {
  isAuthEnabled: boolean;
  identity: FlockIdentity | null | undefined;
  credits: CreditBalance | null | undefined;
}): DashboardAttribution {
  // No identity system running, so there is nothing to be signed out OF and
  // nothing to wait for. Must be checked first: `credits` is permanently
  // undefined here because the query is skipped, and treating that as
  // "resolving" would freeze the page on a skeleton forever.
  if (!args.isAuthEnabled) {
    return "attributed";
  }
  if (args.identity === undefined) {
    return "resolving";
  }
  if (args.identity !== null) {
    return "attributed";
  }
  // Signed out. Which of the two postures we are in is only visible through
  // the balance the server just computed for us (see the note above).
  if (args.credits === undefined) {
    return "resolving";
  }
  return args.credits === null ? "unattributed" : "attributed";
}
