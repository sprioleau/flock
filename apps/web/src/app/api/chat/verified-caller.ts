import "server-only";
import { api } from "@convex/_generated/api";
import type { VerifiedCaller } from "@flock/email-sdk";
import { fetchAuthQuery } from "@/lib/auth/auth-server";
import { isAuthEnabled } from "@/lib/auth/config";

/**
 * WHO IS ASKING, on the agent path — the answer the envelope can trust.
 *
 * `ActionContext.authorId` is self-asserted: pipeline.ts writes
 * `threadId ?? "flock-agent"` into it and nothing checks. That is fine for
 * attribution and useless as authorization, so an action that requires a
 * VERIFIED caller (today: sendTestEmail) reads `context.verifiedCaller`
 * instead, and this is the only thing in the chat route that produces one.
 *
 * The check is the SAME one /api/send-test-email's `resolveCaller` runs, for
 * the same reason and against the same source of truth: the caller's signed
 * Convex token, verified by Convex behind `ctx.auth.getUserIdentity()`. It is
 * deliberately NOT the mirrored session cookie, which is JS-writable and
 * client-chosen — any caller can mint one, so treating it as a credential
 * would buy the appearance of a gate with none of the substance.
 *
 * Duplicated rather than shared with that route for now: it lives under
 * `lib/auth/`, which is being rewritten by other work in flight. Both call
 * sites make the same Convex query and would collapse into one helper cleanly.
 */
export async function resolveVerifiedCaller(): Promise<VerifiedCaller> {
  /*
    Auth off means the identity system does not exist on this deployment:
    nothing signs anyone in, `getUserIdentity()` is null in every Convex
    function, and ownership falls back to the client-supplied session id. This
    is reported as its own distinct state rather than as a failed check, so an
    action can decide what to do about it — `sendTestEmail` declares
    `whenNoIdentitySystem: "allow"`, which is exactly how the HTTP send route
    already reads the same flag. One surface inventing a stricter reading of it
    is how two surfaces end up disagreeing about who may send.
  */
  if (!isAuthEnabled()) {
    return { isVerified: false, reason: "no_identity_system" };
  }

  try {
    const identity = await fetchAuthQuery(api.auth.getCurrentUser, {});
    if (identity === null) {
      return { isVerified: false, reason: "no_verified_session" };
    }
    return { isVerified: true, ownerId: identity.id };
  } catch (error) {
    /*
      FAILS CLOSED, and closed in the strict direction specifically.

      The reported reason is `no_verified_session`, never
      `no_identity_system` — an outage must not be able to claim the
      deployment has no identity system, because that is the one state actions
      are allowed to wave through. A broken check therefore costs a refused
      send (recoverable: the model relays a terminal refusal, the user can
      still send from the header button) rather than restoring the very hole
      the requirement exists to close.
    */
    console.warn("[chat] verified-caller check failed; reporting no verified session", error);
    return { isVerified: false, reason: "no_verified_session" };
  }
}
