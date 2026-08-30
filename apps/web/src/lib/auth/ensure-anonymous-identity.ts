/*
  Gives a stranger an identity on the routes that hand them a working editor
  without ever routing them through a login page.

  WHY THIS IS NOT "SIGN EVERYONE IN". Silent anonymous sign-in on every page
  load is deliberately NOT what this app does — it would make the login page's
  explicit "Continue without an account" meaningless, since the visitor would
  already hold a session before anyone asked them. The exception is a route
  that is a PUBLIC ENTRANCE TO THE EDITOR: a share link, /demo, and a bare
  /studio reached by bookmark or typed URL. All three hand a stranger a
  working editor with zero accounts; all three therefore have to hand them an
  identity quietly, for the things identity is FOR (their own brand kit, their
  own image library, their own undo lane) — and for the writes that refuse
  without one. `createComment` derives its owner from a verified identity via
  `resolveOwnerId` (convex/authIdentity.ts), so on a deployment with
  FLOCK_REQUIRE_AUTH_IDENTITY on it throws in the face of a visitor who was
  never signed in. That is the failure this module exists to prevent.

  TWO CALLERS, ONE IDENTITY. The rule is applied from two places, on purpose:
  the provider effect (lib/auth/FlockAuthProvider.tsx) covers every qualifying
  route reactively, while DemoBootstrap awaits this BEFORE it provisions a
  document, because /demo needs the session to exist by the time the studio
  asks for a comment rather than merely to be under way. Those two overlap on
  /demo and they can fire in the same tick — see the in-flight guard below for
  why that is safe.

  EVERY COLLABORATOR IS INJECTED. The real ones are the Better Auth client and
  the roll-out flag, wired in at each call site. Keeping them out of this
  module is what lets the rules below be tested as rules, in a node
  environment with no DOM, no cookie jar and no network.
*/

export type AnonymousIdentityOutcome = "disabled" | "existing" | "created" | "unavailable";

type AnonymousIdentityCollaborators = {
  isAuthEnabled: boolean;
  getSession: () => Promise<{ data: object | null }>;
  signInAnonymously: () => Promise<void>;
};

/*
  The attempt currently running, shared by everyone who asks while it runs.

  THE HAZARD THIS EXISTS FOR, concretely: anonymous sign-in MINTS A NEW USER
  every time it is called. Two callers that both look up the session before
  either has finished signing in will both see "signed out" and both call
  `signIn.anonymous()` — two anonymous users, of which only the second one's
  cookie survives. Everything the first one owned (the document it just
  created, its brand kit, its library) is then stranded behind a key no
  browser holds any more. The session lookup is a NETWORK ROUND TRIP, so the
  window between "asked" and "answered" is wide, and /demo drives two callers
  straight through it: DemoBootstrap calls this at mount, and the provider
  effect calls it for the /demo route in the same tick — then again after the
  soft navigation to /studio?doc=… .

  Sharing the promise is what makes that safe: the second caller awaits the
  FIRST attempt instead of starting a rival one, and both get its outcome.
  Do not "simplify" this into a boolean that only suppresses the duplicate —
  DemoBootstrap awaits this call to sequence provisioning behind it, so a
  caller that returned early without the identity being established would put
  the demo back in exactly the state this whole module was written to fix.

  Cleared once the attempt settles, so a later legitimate call (a visitor who
  signed out, a route entered long afterwards) can try again rather than being
  answered forever by one stale result.
*/
let inFlightAttempt: Promise<AnonymousIdentityOutcome> | null = null;

export async function ensureAnonymousIdentity(
  collaborators: AnonymousIdentityCollaborators,
): Promise<AnonymousIdentityOutcome> {
  /*
    Auth off is the pre-auth world: nobody is signed in anywhere, and every
    session-scoped Convex function falls back to the client-supplied session
    id (convex/authIdentity.ts). There is nothing to establish, and reaching
    for the auth endpoints on a deploy that has them switched off would be a
    network round trip in exchange for nothing.
  */
  if (!collaborators.isAuthEnabled) {
    return "disabled";
  }
  if (inFlightAttempt !== null) {
    return inFlightAttempt;
  }
  const attempt = attemptAnonymousIdentity(collaborators);
  inFlightAttempt = attempt;
  try {
    return await attempt;
  } finally {
    /*
      Only the attempt that claimed the slot may release it.
    */
    if (inFlightAttempt === attempt) {
      inFlightAttempt = null;
    }
  }
}

/*
  Forgets any in-flight attempt.

  For tests only: the module-level slot above is shared by every case in a
  file, and a case that deliberately leaves an attempt pending would otherwise
  hand its half-finished promise to the next one.
*/
export function resetAnonymousIdentityForTests() {
  inFlightAttempt = null;
}

/*
  The rules themselves, with no bookkeeping in the way. Never rejects.
*/
async function attemptAnonymousIdentity({
  getSession,
  signInAnonymously,
}: AnonymousIdentityCollaborators): Promise<AnonymousIdentityOutcome> {
  try {
    const { data } = await getSession();
    /*
      NEVER sign in over an existing session. Anonymous sign-in mints a NEW
      identity, so doing it to someone who already had one — a returning
      visitor, or an account holder who clicked through to see the demo —
      would strand their brand kit, their image library and their drafts
      behind a key nothing reaches again.
    */
    if (data !== null) {
      return "existing";
    }
    await signInAnonymously();
    return "created";
  } catch (error) {
    /*
      Failure is survivable ON PURPOSE. Nothing a stranger sees first needs an
      identity — the demo's seeded email and the agents' findings, a share
      link's document, a fresh draft — so a misconfigured auth flow, an
      unreachable Convex or a rate limit must cost them the writes that verify
      an owner and nothing more. It must never stop the demo from provisioning
      or the studio from opening, which is why this resolves rather than
      throwing: the caller's own error handling stays about the caller's own
      work.
    */
    console.warn("[auth] anonymous sign-in did not complete", error);
    return "unavailable";
  }
}
