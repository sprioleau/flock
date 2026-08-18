/**
 * Gives a /demo visitor an identity, before the demo ever needs one.
 *
 * WHY /demo NEEDS ITS OWN SIGN-IN. Silent anonymous sign-in on every page load
 * is deliberately NOT what this app does — it would make the login page's
 * explicit "Continue without an account" meaningless, since the visitor would
 * already hold a session before anyone asked them. The exception is a PUBLIC
 * FRONT DOOR that must not route through a login page at all, and there are
 * exactly two of them: a share link (handled by ShareLinkSignIn in
 * lib/auth/FlockAuthProvider.tsx) and this route. Both hand a stranger a
 * working editor with zero accounts; both therefore have to hand them an
 * identity quietly, for the things identity is FOR.
 *
 * WHY ShareLinkSignIn DOES NOT ALREADY COVER IT. That effect reads the URL
 * once, at the mount of the root provider, and returns unless the address
 * carries `?doc=` or `?canvas=`. /demo is mounted at neither, and its handover
 * to `/studio?doc=…` is a SOFT navigation — the root provider never remounts,
 * so the effect never runs a second time. A /demo visitor consequently reached
 * the studio with no session at all, and the first write that derives its
 * owner from a verified identity (`createComment`, on a deployment with
 * FLOCK_REQUIRE_AUTH_IDENTITY on) threw in their face at the comment beat.
 *
 * EVERY COLLABORATOR IS INJECTED. The real ones are the Better Auth client and
 * the roll-out flag, wired in at the one call site (DemoBootstrap). Keeping
 * them out of this module is what lets the rules below be tested as rules, in
 * a node environment with no DOM, no cookie jar and no network.
 */

export type DemoIdentityOutcome = "disabled" | "existing" | "created" | "unavailable";

export async function ensureDemoIdentity({
  isAuthEnabled,
  getSession,
  signInAnonymously,
}: {
  isAuthEnabled: boolean;
  getSession: () => Promise<{ data: object | null }>;
  signInAnonymously: () => Promise<void>;
}): Promise<DemoIdentityOutcome> {
  /* Auth off is the pre-auth world: nobody is signed in anywhere, and every
     session-scoped Convex function falls back to the client-supplied session
     id (convex/authIdentity.ts). There is nothing to establish, and reaching
     for the auth endpoints on a deploy that has them switched off would be a
     network round trip in exchange for nothing. */
  if (!isAuthEnabled) {
    return "disabled";
  }
  try {
    const { data } = await getSession();
    /* NEVER sign in over an existing session. Anonymous sign-in mints a NEW
       identity, so doing it to someone who already had one — a returning
       visitor, or an account holder who clicked through to see the demo —
       would strand their brand kit, their image library and their drafts
       behind a key nothing reaches again. */
    if (data !== null) {
      return "existing";
    }
    await signInAnonymously();
    return "created";
  } catch (error) {
    /* Failure is survivable ON PURPOSE, exactly as it is for a share link. The
       demo's first two beats — the seeded email and the agents' findings —
       need no identity at all, so a misconfigured auth flow, an unreachable
       Convex or a rate limit must cost the visitor the comment beat and
       nothing more. It must never stop the demo from provisioning. */
    console.warn("[auth] demo anonymous sign-in did not complete", error);
    return "unavailable";
  }
}
