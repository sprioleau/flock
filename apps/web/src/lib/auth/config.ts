/**
 * The roll-out switch for Better Auth.
 *
 * Flock is live and its identity model predates auth: every browser in the
 * wild owns a brand kit, an asset library and saved sections keyed to a
 * localStorage UUID. Turning server-side identity on flips which key those
 * rows are read under, so it is opt-in rather than automatic.
 *
 * OFF (default, and the state of every deploy until someone changes it):
 *   nobody is signed in, `ctx.auth.getUserIdentity()` stays null in every
 *   Convex function, and convex/authIdentity.ts falls through to the
 *   client-supplied session id — byte-for-byte the behavior that shipped
 *   before auth existed.
 *
 * ON:
 *   first load signs the browser in anonymously and every session-scoped
 *   mutation starts deriving its owner from a verified JWT instead of a
 *   string the client picked.
 *
 * Deliberately NEXT_PUBLIC_: the decision is made in the browser (whether to
 * sign in at all), so the value has to reach client bundles. It is a feature
 * flag, not a secret.
 */
export function isAuthEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FLOCK_AUTH_ENABLED === "true";
}

/** Where auth endpoints live on this origin. Matches convex/auth.ts basePath. */
export const AUTH_BASE_PATH = "/api/auth";

/** The front door. */
export const LOGIN_PATH = "/";

/**
 * The editor. Bare (no `?doc=`) mints a fresh draft — StudioShell creates one
 * when the URL names none — so this doubles as "start something new".
 */
export const STUDIO_PATH = "/studio";

/**
 * Where a magic link lands after it verifies: a route that confirms the
 * session server-side and forwards to a fresh studio draft, rather than
 * dropping a failed link into the editor as a stranger. See
 * apps/web/src/app/api/auth/welcome/route.ts.
 */
export const AUTH_CALLBACK_PATH = "/api/auth/welcome";
