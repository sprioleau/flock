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
 * (apps/web/src/lib/presence.tsx:316, convex/presence.ts:50–56). Anyone who
 * opened a shared link with you could therefore read and MUTATE your brand
 * kit, asset library, saved sections and persona copies.
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
 * session id is inert.
 *
 * READ THE ORDER BEFORE FLIPPING ANYTHING. The two flags are not independent,
 * and there is a third prerequisite that is easy to miss:
 *
 *   1. Adopt this function everywhere (done — assets, brandKits, comments,
 *      personas, savedSections, authCredits). Safe with auth off: no caller
 *      has an identity, so every call takes the fallback and behaves exactly
 *      as before.
 *   2. TEACH THE SERVER ROUTES TO AUTHENTICATE. Several Next route handlers
 *      call Convex on the user's behalf through a bare `ConvexHttpClient` that
 *      carries no token (`/api/brand-kit/confirm-asset`, `/api/chat/*`,
 *      `/api/library/import-image`, `/api/generate-image`,
 *      `/api/saved-sections/enrich`, `lib/content-ingestion/rehost-image`).
 *      They forward the browser's `sessionId` as a plain argument. The moment
 *      identity exists, the browser writes under its user id while those
 *      routes write under the legacy UUID — generated images stop appearing in
 *      the library, the agent loses brand context, enrichment fails the
 *      ownership check. Each needs `client.setAuth(await getToken())`
 *      (apps/web/src/lib/auth/auth-server.ts) BEFORE step 3.
 *   3. NEXT_PUBLIC_FLOCK_AUTH_ENABLED=true. Identity starts existing.
 *   4. FLOCK_REQUIRE_AUTH_IDENTITY=true. The fallback is gone; the hole is
 *      shut. Rows still keyed to a pre-auth localStorage UUID become
 *      unreachable until an operator re-keys them with
 *      `authMigration:adoptLegacySessionData`.
 *
 * Step 4 without step 3 bricks the app: every session-scoped mutation would
 * refuse, because nobody is signed in. Step 3 without step 2 breaks every
 * server-mediated feature. There is NO setting in which the hole is shut while
 * auth is off — with auth off, the only thing distinguishing two users is a
 * string the server itself handed to both of them.
 *
 * WHAT THIS IS DELIBERATELY NOT USED FOR: documents and canvases. The doc URL
 * is the capability (convex/documents.ts:36–40) and the multiplayer demo
 * requires zero accounts. Adding identity to document read/write would break
 * share-by-link, which is the product. Ownership ≠ access. The same exemption
 * covers `operations.authorId` — that is undo-stack provenance scoped to a
 * browser, deliberately not migrated at link time (implementation notes §3.3),
 * so `brandKits.applyBrandToDocuments` still passes the client's own id there.
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
 * The authoritative owner id, or null when the caller cannot name one.
 *
 * For callers whose session id is optional (listings that degrade to a
 * built-in set) and for server-side work that has nothing to fall back on.
 * `resolveOwnerId` is the same resolution with a friendly refusal instead of
 * a null.
 */
export async function resolveOwnerIdOrNull(
  ctx: AuthedCtx,
  args?: { claimedSessionId?: string },
): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity !== null) {
    return identity.subject;
  }
  if (isStrictIdentityRequired()) {
    return null;
  }
  // Verbatim, including the empty string: `credits.ts` sends "" when a caller
  // has no mirrored session cookie, and pooling those into one bucket is the
  // pre-auth behavior. Only a caller with NO claim at all resolves to null.
  return args?.claimedSessionId ?? null;
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
  const ownerId = await resolveOwnerIdOrNull(ctx, args);
  if (ownerId === null) {
    throw new ConvexError(
      "You're signed out, so we can't tell whose library this is. Reload the page and try again.",
    );
  }
  return ownerId;
}
