import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { requireRunMutationCtx } from "@convex-dev/better-auth/utils";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { anonymous } from "better-auth/plugins/anonymous";
import { magicLink } from "better-auth/plugins/magic-link";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { query } from "./_generated/server";
import authConfig from "./auth.config";
import { sendMagicLinkEmail } from "./authEmail";
import {
  deriveMagicLinkBucketKeys,
  MAGIC_LINK_EMPTY_EMAIL_MESSAGE,
  MAGIC_LINK_UNAVAILABLE_MESSAGE,
  normalizeMagicLinkEmail,
} from "./authMagicLink";

/**
 * Flock identity: the anonymous → magic-link pair
 * (docs/proposals/better-auth-evaluation.md §5, owner decision: adopt the PAIR,
 * never the anonymous plugin alone).
 *
 * - First touch costs nothing: `signIn.anonymous()` mints a real user + server
 *   session behind an httpOnly cookie. No email, no form, no interruption.
 * - "Keep my work" costs one email tap: `signIn.magicLink()` links that
 *   anonymous user to a durable identity, and `onLinkAccount` carries the
 *   user's canvases, drafts, brand kit, assets, saved sections, personas and
 *   comment authorship across (convex/authMigration.ts). From then on the same
 *   human is the same user on every device.
 *
 * WHAT THIS IS NOT: document access control. Share-by-link is the product
 * (eval §2.3/§4.4) — `documents.ts` never consults identity, and nothing here
 * changes that. A broken auth flow degrades LIBRARIES (kit/assets/sections),
 * never the editor or a shared link. Auth is the ownership key only.
 *
 * Roll-out is opt-in: the web app only signs anyone in when
 * NEXT_PUBLIC_FLOCK_AUTH_ENABLED is true (apps/web/src/lib/auth/config.ts).
 * With it off, no identity exists, `ctx.auth.getUserIdentity()` stays null, and
 * every session-scoped function behaves exactly as it did before this landed.
 */

/** Public site origin — the base for magic-link URLs and cookie/CSRF checks. */
const siteUrl = process.env.SITE_URL ?? "http://localhost:3000";

/**
 * Extra origins allowed to drive auth (Vercel previews, the apex domain).
 * Comma-separated; `siteUrl` itself is always trusted by Better Auth.
 */
const extraTrustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

export const authComponent = createClient<DataModel>(components.betterAuth);

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth({
    baseURL: siteUrl,
    trustedOrigins: extraTrustedOrigins,
    database: authComponent.adapter(ctx),

    /**
     * Deliberately absent: `emailAndPassword`, `socialProviders`. Passwords are
     * an account-recovery surface we would then owe the user; OAuth is a
     * third-party consent screen in a zero-friction demo. Magic link is the
     * lowest-friction DURABLE method that exists, and Resend already ships.
     */
    plugins: [
      anonymous({
        /**
         * Fires when an anonymous user signs in with a real method. This is
         * the entire reason Better Auth is here: the seam where a throwaway
         * identity becomes a durable one WITHOUT losing the work behind it.
         * Better Auth deletes the anonymous row right after this resolves, so
         * the re-key must complete inside the callback.
         */
        onLinkAccount: async ({ anonymousUser, newUser }) => {
          await requireRunMutationCtx(ctx).runMutation(
            internal.authMigration.reKeyOwnedRows,
            { fromOwnerId: anonymousUser.user.id, toOwnerId: newUser.user.id },
          );
        },
      }),
      magicLink({
        /** 15 minutes: long enough to switch to a phone, short enough to be a capability. */
        expiresIn: 60 * 15,
        /** Tokens are single-use already; hashing keeps a DB read from being a live credential. */
        storeToken: "hashed",
        /**
         * A backstop, not the real limit. `rateLimit.customRules` below
         * overrides this for the two paths that actually exist, because these
         * buckets turn out to be deployment-wide rather than per-caller (the
         * long note down there). This value only still covers hypothetical
         * sub-paths, so it stays tight.
         */
        rateLimit: { window: 60, max: 3 },
        sendMagicLink: async ({ email, url }) => {
          try {
            await sendMagicLinkEmail({ email, url });
          } catch (error) {
            // The `before` hook already charged the cooldown for this address,
            // on the assumption the mail would go out. It did not, so give it
            // back — otherwise the next attempt is told "a link is already on
            // its way", which is both false and a lockout. Only the address
            // half is refunded (convex/authMagicLink.ts explains why).
            //
            // Best-effort: if the release itself fails there is nothing useful
            // left to do, and the original send error is the one worth
            // surfacing, so it is rethrown either way.
            const { addressKey } = await deriveMagicLinkBucketKeys({
              email,
              headers: undefined,
            });
            await requireRunMutationCtx(ctx)
              .runMutation(internal.authMagicLink.releaseMagicLinkAddressCooldown, {
                addressKey,
              })
              .catch(() => undefined);
            throw error;
          }
        },
      }),
      convex({ authConfig }),
    ],

    hooks: {
      /**
       * THE FRONT DOOR, AND THE LOCK ON THE MAIL CHANNEL.
       *
       * Anyone may ask for a sign-in link — a first-time visitor typing their
       * own address, a returning person on a new device, or someone claiming
       * the anonymous session they are already using. All three are the same
       * request and all three are allowed. Nothing here consults the user
       * table, which is worth stating plainly: signing up and signing in are
       * INDISTINGUISHABLE from outside, so this endpoint cannot be used to ask
       * "does this person have an account?".
       *
       * That is safe because of WHEN Better Auth creates the user: at link
       * VERIFICATION, not at link request (the magic-link plugin only calls
       * `createUser` inside its verify handler). Requesting a link for an
       * address therefore creates nothing — an address that never opens its
       * link never becomes an account.
       *
       * WHAT IS STILL DANGEROUS is the mail itself. This endpoint sends real
       * email from our verified domain to whatever address it is handed, so an
       * open door here is an open door into other people's inboxes, and the
       * bill for that is the domain's reputation. Two limits price it, both in
       * convex/authMagicLink.ts: a per-address cooldown so one inbox cannot be
       * buried, and a per-origin hourly allowance so one client cannot walk a
       * list of strangers. Neither refusal says anything about whether the
       * address is registered.
       *
       * The limits apply to SESSION HOLDERS TOO. Anonymous entry is one click,
       * so "has a session" is not evidence of anything — exempting it would
       * hand the whole guard to anyone willing to click once.
       *
       * FAILS CLOSED, unlike the credit meter (apps/web/src/lib/auth/credits.ts
       * lets a metering outage through on purpose). The calculus is different
       * on the mail path: a credit that escapes costs one model call, whereas a
       * send that escapes a broken limiter costs deliverability we cannot buy
       * back — and the limiter runs on the same Convex deployment that is
       * serving this request, so if it is down, auth is down anyway and there
       * is no working product to keep alive by letting mail through.
       */
      // `requestCtx`, not `ctx`: the Convex context this factory closes over is
      // what runs the limiter mutation, and shadowing it here would silently
      // reach for the wrong one.
      before: createAuthMiddleware(async (requestCtx) => {
        if (requestCtx.path !== "/sign-in/magic-link") {
          return;
        }
        const requestedEmail = normalizeMagicLinkEmail(
          (requestCtx.body as { email?: unknown } | undefined)?.email,
        );
        if (requestedEmail.length === 0) {
          throw new APIError("BAD_REQUEST", {
            message: MAGIC_LINK_EMPTY_EMAIL_MESSAGE,
          });
        }

        // Derived here, not inside the mutation: the request headers are the
        // only place the client address exists, and Convex functions never see
        // them. The mutation only ever receives opaque digests.
        const keys = await deriveMagicLinkBucketKeys({
          email: requestedEmail,
          headers: requestCtx.headers,
        });

        let decision: { isAllowed: boolean; refusalMessage: string };
        try {
          decision = await requireRunMutationCtx(ctx).runMutation(
            internal.authMagicLink.reserveMagicLinkSend,
            {
              addressKey: keys.addressKey,
              ...(keys.originKey === undefined ? {} : { originKey: keys.originKey }),
            },
          );
        } catch {
          throw new APIError("SERVICE_UNAVAILABLE", {
            message: MAGIC_LINK_UNAVAILABLE_MESSAGE,
          });
        }
        if (!decision.isAllowed) {
          throw new APIError("TOO_MANY_REQUESTS", {
            message: decision.refusalMessage,
          });
        }
      }),
    },

    session: {
      /**
       * 30 days. An anonymous session that expires is a user who silently
       * loses their brand kit, so this is deliberately longer than the Better
       * Auth default of 7 days; magic-link users are re-linkable regardless.
       */
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },

    rateLimit: {
      enabled: true,
      /** Convex has no in-memory continuity across function calls. */
      storage: "database",
      window: 10,
      max: 100,

      /**
       * READ THIS BEFORE TIGHTENING ANYTHING HERE: these buckets are NOT
       * per-caller on this deployment. Better Auth keys its rate limiter on
       * the client IP, and behind Convex it cannot resolve one — the
       * `x-forwarded-for` that reaches the Convex HTTP action has more than one
       * hop in it (Vercel egress, then Convex's own edge) and Better Auth
       * refuses to trust a multi-hop header without a `trustedProxies` list,
       * which we cannot write because those hops are not ours and not stable.
       * Verified against a live deployment: three requests from one address
       * exhausted a rule, and a request from a completely different address was
       * refused immediately after. Every caller shares ONE bucket per path.
       *
       * So a "3 per hour" rule here would be three sign-in links per hour for
       * the ENTIRE product, not per person. These two rules are therefore sized
       * as flood brakes — high enough that real traffic never sees them, low
       * enough that a script cannot run unbounded. The genuinely per-person
       * limits live in the magic-link hook above, where the request headers are
       * readable (convex/authMagicLink.ts).
       *
       * Both paths also need an explicit rule because the magic-link plugin
       * defaults them to 3 per 60s — which, shared, is a deployment-wide cap of
       * three sign-ins a minute.
       */
      customRules: {
        /** Sends mail: the brake that matters, backed by the per-person guard. */
        "/sign-in/magic-link": { window: 60, max: 20 },
        /**
         * Sends nothing — it redeems a single-use, hashed, 15-minute token, so
         * the token IS the limit. Rate limiting it only risks turning a burst
         * of people opening their email into failed sign-ins.
         */
        "/magic-link/verify": { window: 60, max: 60 },
      },
    },

    advanced: {
      useSecureCookies: siteUrl.startsWith("https://"),
      /** Distinguishes Better Auth cookies from the gate/doc/canvas cookies. */
      cookiePrefix: "flock_auth",
      defaultCookieAttributes: { sameSite: "lax" },
    },
  });
};

/**
 * The signed-in user, or null. Reactive: every tab re-renders when the identity
 * changes (anonymous → linked), which is how the "keep my work" affordance
 * knows to disappear.
 */
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (user === undefined || user === null) {
      return null;
    }
    return {
      id: user._id,
      email: user.email,
      name: user.name,
      /** Booleans read as booleans: `isAnonymous` is the "not yet claimed" flag. */
      isAnonymous: user.isAnonymous === true,
    };
  },
});
