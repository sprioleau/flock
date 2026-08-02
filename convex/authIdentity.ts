import { ConvexError } from "convex/values";
import type { Auth } from "convex/server";

/**
 * THE OWNERSHIP KEY — one function, every session-scoped table.
 *
 * The problem this exists to solve (better-auth-evaluation.md §2.4 item 4):
 * every session-scoped Convex function took `sessionId` as a plain CLIENT-
 * SUPPLIED string and trusted it. That would be tolerable if the id were a
 * secret, but the app hands it out — the presence roster publishes every
 * collaborator's `userId` (= their session id) to everyone in the room
 * (apps/web/src/lib/presence.tsx:295, convex/presence.ts:86–93) and comment
 * rows return author session ids to every capability holder
 * (convex/comments.ts:73). Anyone who opened a shared link with you could
 * therefore read and MUTATE your brand kit, asset library, saved sections and
 * persona copies.
 *
 * The fix is not to hide the id. It is to stop it being a credential:
 *
 *   identity present  →  the owner is `identity.subject`, the Better Auth user
 *                        id carried by a signed JWT that Convex verified. The
 *                        client's `sessionId` argument is IGNORED for
 *                        ownership. Spoofing it buys nothing.
 *   identity absent   →  fall back to the claimed id (today's behavior), or
 *                        refuse outright in strict mode (see below).
 *
 * WHY A FALLBACK AT ALL. Flock is live. Every browser out there owns rows
 * keyed to a localStorage UUID, and auth roll-out is gated behind
 * NEXT_PUBLIC_FLOCK_AUTH_ENABLED (apps/web/src/lib/auth/config.ts). Until that
 * flag is on in production, no caller has an identity and this function must
 * behave exactly as the old code did or the app breaks for everyone.
 *
 * CLOSING THE HOLE COMPLETELY is one env var: set FLOCK_REQUIRE_AUTH_IDENTITY
 * to "true" on the Convex deployment and the fallback disappears — an
 * unauthenticated caller can no longer name an owner at all, so a leaked
 * session id is inert. Flip it once anonymous sign-in has been verified live;
 * see docs/proposals/better-auth-implementation-notes.md for the exact order.
 *
 * WHAT THIS IS DELIBERATELY NOT USED FOR: documents and canvases. The doc URL
 * is the capability (convex/documents.ts:36–40) and the multiplayer demo
 * requires zero accounts. Adding identity to document read/write would break
 * share-by-link, which is the product. Ownership ≠ access.
 */

/** Convex ctx shapes that carry a verified identity (query, mutation, action). */
type AuthedCtx = { auth: Auth };

/**
 * True once the deployment refuses to accept client-supplied ownership keys.
 * Read per call rather than at module scope so flipping the env var takes
 * effect on the next function invocation, with no redeploy.
 */
function isStrictIdentityRequired(): boolean {
  return process.env.FLOCK_REQUIRE_AUTH_IDENTITY === "true";
}

/**
 * The authoritative owner id for the calling user.
 *
 * Pass the client's `sessionId` argument as `claimedSessionId`; it is used ONLY
 * as the pre-auth fallback and never overrides a verified identity.
 */
export async function resolveOwnerId(
  ctx: AuthedCtx,
  args: { claimedSessionId: string },
): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity !== null) {
    return identity.subject;
  }
  if (isStrictIdentityRequired()) {
    throw new ConvexError(
      "You're signed out, so we can't tell whose library this is. Reload the page and try again.",
    );
  }
  return args.claimedSessionId;
}

/**
 * Same resolution, but for callers that have no claimed id to fall back on
 * (server routes, background work). Returns null instead of guessing.
 */
export async function resolveOwnerIdOrNull(ctx: AuthedCtx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  return identity === null ? null : identity.subject;
}

/**
 * Every owner id a caller may legitimately read under, newest key first.
 *
 * READS are widened where WRITES are narrowed: during the roll-out window an
 * authenticated browser still has un-migrated rows under its old localStorage
 * id, and a "your brand kit vanished" regression is worse than a read of data
 * the caller could already read a moment ago. Reads of another user's rows via
 * a guessed id were always possible and remain no worse; writes are what this
 * change locks down. In strict mode the claimed id is dropped here too.
 */
export async function resolveReadableOwnerIds(
  ctx: AuthedCtx,
  args: { claimedSessionId: string },
): Promise<string[]> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    return isStrictIdentityRequired() ? [] : [args.claimedSessionId];
  }
  if (isStrictIdentityRequired() || identity.subject === args.claimedSessionId) {
    return [identity.subject];
  }
  return [identity.subject, args.claimedSessionId];
}
