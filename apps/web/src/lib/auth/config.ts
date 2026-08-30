/*
  The roll-out switch for Better Auth.

  Flock is live and its identity model predates auth: every browser in the
  wild owns a brand kit, an asset library and saved sections keyed to a
  localStorage UUID. Turning server-side identity on flips which key those
  rows are read under, so it is opt-in rather than automatic.

  OFF (default, and the state of every deploy until someone changes it):
    nobody is signed in, `ctx.auth.getUserIdentity()` stays null in every
    Convex function, and convex/authIdentity.ts falls through to the
    client-supplied session id — byte-for-byte the behavior that shipped
    before auth existed.

  ON:
    first load signs the browser in anonymously and every session-scoped
    mutation starts deriving its owner from a verified JWT instead of a
    string the client picked.

  Deliberately NEXT_PUBLIC_: the decision is made in the browser (whether to
  sign in at all), so the value has to reach client bundles. It is a feature
  flag, not a secret.
*/
export function isAuthEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FLOCK_AUTH_ENABLED === "true";
}

/*
  Where auth endpoints live on this origin. Matches convex/auth.ts basePath.
*/
export const AUTH_BASE_PATH = "/api/auth";

/*
  The front door.
*/
export const LOGIN_PATH = "/";

/*
  The editor. Bare (no `?doc=`) mints a fresh draft — StudioShell creates one
  when the URL names none — so this doubles as "start something new".
*/
export const STUDIO_PATH = "/studio";

/*
  Home base: everything this identity owns. This is where an existing user
  belongs after signing in — dropping them straight into a NEW blank draft
  (which is what /studio does) hides the work they came back for.
*/
export const DASHBOARD_PATH = "/dashboard";

/*
  The immersive brand workspace (brand-memory §1): the brand kit promoted from
  a modal to a page, with its own section sub-nav. `/brand` lands on the
  default section; `/brand/<slug>` deep-links one.
*/
export const BRAND_PATH = "/brand";

/*
  The scripted stranger demo (docs/proposals/demo-mode.md).
*/
export const DEMO_PATH = "/demo";

/*
  Where a magic link lands after it verifies: a route that confirms the
  session server-side and forwards to a fresh studio draft, rather than
  dropping a failed link into the editor as a stranger. See
  apps/web/src/app/api/auth/welcome/route.ts.
*/
export const AUTH_CALLBACK_PATH = "/api/auth/welcome";
