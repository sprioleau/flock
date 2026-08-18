"use client";

import {
  ConvexBetterAuthProvider,
  type AuthClient,
} from "@convex-dev/better-auth/react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { useEffect, type ReactNode } from "react";
import { authClient } from "./auth-client";
import { isAuthEnabled } from "./config";

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
      <ShareLinkSignIn />
      {children}
    </ConvexBetterAuthProvider>
  );
}

/**
 * The one place anonymous sign-in still happens automatically: someone who
 * arrived on a SHARE LINK.
 *
 * Anonymous sign-in is otherwise an explicit choice on the login page
 * ("Continue without an account"), because a silent sign-in on every page load
 * would make that choice meaningless — the visitor would already have a
 * session before they were asked. But a share link must not route through a
 * login page at all: the document id is the capability, the multiplayer demo
 * requires zero accounts, and asking a collaborator to sign in before they can
 * see the draft you sent them would break the product's core trick.
 *
 * So a link-holder gets an identity quietly, for the things identity is FOR
 * (their own brand kit, their own image library, their own undo lane) — while
 * their access to the document came from the URL and never from the session.
 *
 * THE OTHER FRONT DOOR IS /demo, AND THIS EFFECT DOES NOT COVER IT. A demo
 * visitor is in exactly the same category — a stranger who must reach a
 * working editor without ever meeting a login page — but they cannot be served
 * from here. This effect reads `window.location.search` ONCE, at the mount of
 * the root provider, and /demo is mounted at a URL carrying neither `doc` nor
 * `canvas`; DemoBootstrap's handover to `/studio?doc=…` is a SOFT navigation,
 * so the provider never remounts and this effect never gets a second look at
 * the URL. /demo therefore establishes its own identity at provisioning time
 * instead — see `ensureDemoIdentity` in lib/demo/demo-identity.ts, called from
 * DemoBootstrap before it creates the document. If you widen or narrow the
 * rule below, that is the other half to keep in step.
 *
 * Failure is survivable ON PURPOSE. If sign-in fails (auth misconfigured,
 * Convex unreachable, a rate limit), the app keeps working: session-scoped
 * functions fall back to the client-supplied id (convex/authIdentity.ts) and
 * document access never consulted identity. A broken auth flow degrades
 * libraries, never the editor.
 */
function ShareLinkSignIn() {
  useEffect(() => {
    const hasCapabilityLink =
      new URLSearchParams(window.location.search).has("doc") ||
      new URLSearchParams(window.location.search).has("canvas");
    if (!hasCapabilityLink) {
      return;
    }
    let isCancelled = false;
    void (async () => {
      try {
        const { data } = await authClient.getSession();
        if (isCancelled || data !== null) {
          return;
        }
        await authClient.signIn.anonymous();
      } catch (error) {
        console.warn("[auth] anonymous sign-in did not complete", error);
      }
    })();
    return () => {
      isCancelled = true;
    };
  }, []);
  return null;
}
