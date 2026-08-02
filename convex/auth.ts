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
        /** Tighter than the plugin default (5/60s) — one person needs one link. */
        rateLimit: { window: 60, max: 3 },
        sendMagicLink: async ({ email, url }) => {
          await sendMagicLinkEmail({ email, url });
        },
      }),
      convex({ authConfig }),
    ],

    hooks: {
      /**
       * DON'T LET US BE USED TO MAIL STRANGERS.
       *
       * `/sign-in/magic-link` sends real email to any address handed to it. A
       * signed-out caller scripting that endpoint turns this deployment into a
       * way to drop mail into someone else's inbox from our verified domain —
       * which costs us the domain's reputation, not just the send.
       *
       * `disableSignUp: true` would stop it and is the WRONG fix: it also
       * blocks the claim flow, because claiming means creating a durable user
       * for an address this deployment has never seen.
       *
       * So the policy is stated directly. A magic link may be requested by:
       *   - anyone holding a session (the claim flow — they are naming an
       *     account they are already using);
       *   - anyone whose email already belongs to a user (a returning person
       *     on a new device, the entire point of the feature).
       * Everyone else is refused, before any mail is sent.
       *
       * Note what this does NOT do: it is not an invite gate. Anonymous entry
       * is one click, so anyone can obtain a session and then claim an
       * address. That is deliberate (see apps/web/src/app/page.tsx) — this
       * hook protects the mail channel, not the front door.
       *
       * The refusal is a fixed message that does not reveal whether the
       * address is known, so it is not an account-enumeration oracle.
       */
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/magic-link") {
          return;
        }
        const hasSession = ctx.context.session !== null;
        if (hasSession) {
          return;
        }
        const requestedEmail = String(
          (ctx.body as { email?: unknown } | undefined)?.email ?? "",
        )
          .trim()
          .toLowerCase();
        if (requestedEmail.length === 0) {
          throw new APIError("BAD_REQUEST", {
            message: "Add an email address and we'll send you a link.",
          });
        }
        const existingUser = await ctx.context.internalAdapter.findUserByEmail(
          requestedEmail,
        );
        if (existingUser === null) {
          throw new APIError("FORBIDDEN", {
            message:
              "We don't have an account for that address yet. Start building first, then save your work to this email from inside the editor.",
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
