"use client";

import {
  ConvexBetterAuthProvider,
  type AuthClient,
} from "@convex-dev/better-auth/react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { authClient } from "./auth-client";
import { isAuthEnabled, STUDIO_PATH } from "./config";
import { ensureAnonymousIdentity } from "./ensure-anonymous-identity";

/**
 * The component's `AuthClient` type is a union of two fully-instantiated
 * client shapes, so a client built with a different plugin tuple never
 * structurally matches it (its `useSession().data` collapses to `never`).
 * The runtime contract — the plugin set in auth-client.ts mirroring
 * convex/auth.ts — is what actually matters here, and it is asserted by the
 * server. Narrow, named, and confined to this one boundary rather than
 * loosening the exported client's type for every consumer.
 */
const providerAuthClient = authClient as unknown as AuthClient;

/**
 * Wires Convex to Better Auth, and gives every first-time visitor an identity
 * without asking them for anything.
 *
 * When the roll-out flag is off this is a pass-through to the plain
 * ConvexProvider — no auth client, no network calls, no behavior change. That
 * is the whole reason the branch exists: shipping this file must be a no-op
 * until someone deliberately turns identity on.
 */
export function FlockAuthProvider({
  client,
  children,
}: {
  client: ConvexReactClient;
  children: ReactNode;
}) {
  if (!isAuthEnabled()) {
    return <ConvexProvider client={client}>{children}</ConvexProvider>;
  }
  return (
    <ConvexBetterAuthProvider client={client} authClient={providerAuthClient}>
      <EditorEntrySignIn />
      {children}
    </ConvexBetterAuthProvider>
  );
}

/**
 * The routes that hand a stranger a working editor without a login page in
 * between, and therefore have to hand them an identity too.
 *
 * /studio because a bare `/studio` — a bookmark, a typed address, a link from
 * anywhere — mints a fresh draft on the spot (StudioShell creates one when the
 * URL names none). The visitor is editing within a second and has met nothing
 * that could have asked them to sign in.
 *
 * /demo for the same reason one step earlier: it provisions a document and
 * hands over to the studio, and a stranger is exactly who it is for.
 *
 * NOT `/` — see the effect below for why that exclusion is the whole design.
 * NOT /dashboard: an identity minted on arrival there just shows an empty
 * library, which is a worse answer than the sign-in prompt that page already
 * gives. The list is a whitelist rather than a "not the login page" test so
 * that a route added later is opted in deliberately, by someone who has
 * decided whether it is a public entrance.
 */
const EDITOR_ENTRY_PATHS: ReadonlySet<string> = new Set([STUDIO_PATH, "/demo"]);

/**
 * The one place anonymous sign-in happens without anybody being asked: a
 * stranger who has landed somewhere that is already a working editor.
 *
 * WHY THIS IS NOT EVERY PAGE, and specifically why it is never the login page
 * (`/`). Anonymous sign-in is an explicit choice there — "Continue without an
 * account" — and a silent sign-in on page load would make that choice
 * meaningless, because the visitor would already be holding a session before
 * anyone offered them the option. LoginPanel.handleAnonymousEntry is what mints
 * an identity on that route, when the visitor presses the button and not
 * before. Everything here is scoped so that it cannot reach `/`.
 *
 * The routes it DOES reach could not route through that page even if we wanted
 * them to. A share link's document id is the capability, the multiplayer trick
 * requires zero accounts, and asking a collaborator to sign in before they can
 * see the draft you sent them would break the product. /demo and a bare
 * /studio are the same bargain: the editor opens immediately, so the identity
 * has to arrive without a conversation. A visitor gets one quietly, for the
 * things identity is FOR (their own brand kit, their own image library, their
 * own undo lane) — while their access to a shared document still came from the
 * URL and never from the session.
 *
 * WHY IT REACTS TO `pathname` RATHER THAN RUNNING ONCE. This effect used to
 * have an empty dependency array, which read `window.location.search` exactly
 * once at the mount of the root provider — and the root provider does not
 * remount on a client-side navigation. That is not a detail, it is the bug
 * this route rule was widened to fix: a /demo visitor was carried to
 * `/studio?doc=…` by a SOFT navigation, the effect never got a second look at
 * the URL, and they reached the comment beat with no session at all — where
 * `createComment`, which derives its owner from a verified identity
 * (convex/authIdentity.ts), refused them. Depending on `usePathname()` means
 * every soft navigation re-evaluates the rule, which is also what makes
 * reading `window.location.search` in the body correct: the read happens again
 * whenever the route changes. `useSearchParams()` would be the tidier hook and
 * is deliberately NOT used — subscribing to it here, in a component mounted by
 * the root provider, would force dynamic rendering on every page in the app.
 *
 * The capability-link test is kept ALONGSIDE the route list, not folded into
 * it, because a share link can land on a route nobody enumerated. The id in
 * the URL is the thing that says "a stranger was invited here", wherever here
 * turns out to be.
 *
 * Failure is survivable ON PURPOSE, and the helper's contract is that it never
 * rejects. If sign-in fails (auth misconfigured, Convex unreachable, a rate
 * limit), the app keeps working: session-scoped functions fall back to the
 * client-supplied id (convex/authIdentity.ts) and document access never
 * consulted identity. A broken auth flow degrades libraries, never the editor.
 */
function EditorEntrySignIn() {
  const pathname = usePathname();
  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const hasCapabilityLink = searchParams.has("doc") || searchParams.has("canvas");
    if (!EDITOR_ENTRY_PATHS.has(pathname) && !hasCapabilityLink) {
      return;
    }
    /* Not cancelled on unmount, unlike the version this replaced. An attempt
       that outlives a navigation is the CORRECT outcome now — the visitor is
       still the same visitor, still in the editor, and still about to need the
       identity. The double-mint that cancellation used to be standing in for
       is handled properly, in the helper, by callers sharing one attempt. */
    void ensureAnonymousIdentity({
      isAuthEnabled: isAuthEnabled(),
      getSession: () => authClient.getSession(),
      signInAnonymously: async () => {
        await authClient.signIn.anonymous();
      },
    });
  }, [pathname]);
  return null;
}
