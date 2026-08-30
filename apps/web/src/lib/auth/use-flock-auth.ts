"use client";

import { api } from "@convex/_generated/api";
import { useQuery } from "convex/react";
import { useCallback, useState } from "react";
import { getOrCreateSessionId } from "@/lib/session";
import { authClient } from "./auth-client";
import { AUTH_CALLBACK_PATH, isAuthEnabled } from "./config";

/*
  The one seam any UI needs to offer "keep my work".

  Identity comes from the Convex query rather than the Better Auth client
  session on purpose: `api.auth.getCurrentUser` runs behind
  `ctx.auth.getUserIdentity()`, so what this returns is what the SERVER
  believes about the caller — the same thing every ownership check uses. A
  client-side session object could be stale or, in the worst case, wrong.

  The whole hook is inert when the roll-out flag is off: `identity` is null,
  `isEnabled` is false, and a UI can hide the affordance with one boolean.
*/

export type MagicLinkRequestState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent"; email: string }
  | { status: "failed"; message: string };

export type FlockIdentity = {
  id: string;
  email: string;
  isAnonymous: boolean;
};

export type CreditBalance = {
  limit: number;
  spent: number;
  remaining: number;
  resetsAtMs: number;
  /*
    False for anonymous sessions, which get the stricter tier.
  */
  isClaimedTier: boolean;
};

export function useFlockAuth(): {
  isEnabled: boolean;
  /*
    Undefined while the identity query is in flight; null when signed out.
  */
  identity: FlockIdentity | null | undefined;
  /*
    True when there is an identity that has not yet been claimed by email.
  */
  isUnclaimed: boolean;
  /*
    Undefined until the allowance query resolves; null when the server can
    attribute no allowance to this caller at all — a signed-out visitor on a
    strict deployment, whose claimed session id names nobody
    (convex/authCredits.ts). Callers must render nothing rather than a number:
    there is no honest number to show.
  */
  credits: CreditBalance | null | undefined;
  magicLinkRequest: MagicLinkRequestState;
  sendMagicLink: (args: { email: string }) => Promise<void>;
  resetMagicLinkRequest: () => void;
  signOut: () => Promise<void>;
} {
  const isEnabled = isAuthEnabled();
  const identity = useQuery(api.auth.getCurrentUser, isEnabled ? {} : "skip");
  /*
    The legacy id is still passed as the pre-roll-out fallback key; a verified
    identity always wins server-side (convex/authIdentity.ts). Read once and
    lazily — client components also render on the server, where there is no
    localStorage to read.
  */
  const [claimedSessionId] = useState(() =>
    typeof window === "undefined" ? "" : getOrCreateSessionId(),
  );
  /*
    DELIBERATELY NOT GATED ON `identity`. It is tempting, since on a strict
    deployment a signed-out caller can only ever be told null — but with strict
    mode OFF the claimed id IS the ownership key, so a signed-out caller has a
    real, meaningful balance and skipping the query would hide it. The server
    decides what it can attribute and answers null when it cannot
    (convex/authCredits.ts); asking is always safe and never throws.
  */
  const credits = useQuery(
    api.authCredits.getBalance,
    isEnabled && claimedSessionId.length > 0 ? { sessionId: claimedSessionId } : "skip",
  );
  const [magicLinkRequest, setMagicLinkRequest] = useState<MagicLinkRequestState>({
    status: "idle",
  });

  const sendMagicLink = useCallback(async ({ email }: { email: string }) => {
    const trimmedEmail = email.trim();
    if (trimmedEmail.length === 0) {
      setMagicLinkRequest({
        status: "failed",
        message: "Add an email address and we'll send you a link.",
      });
      return;
    }
    setMagicLinkRequest({ status: "sending" });
    try {
      const { error } = await authClient.signIn.magicLink({
        email: trimmedEmail,
        callbackURL: AUTH_CALLBACK_PATH,
      });
      if (error) {
        setMagicLinkRequest({
          status: "failed",
          message:
            error.message ??
            "We couldn't send that link just now. Give it a moment and try again.",
        });
        return;
      }
      setMagicLinkRequest({ status: "sent", email: trimmedEmail });
    } catch {
      setMagicLinkRequest({
        status: "failed",
        message: "We couldn't reach the mail service. Check your connection and try again.",
      });
    }
  }, []);

  const resetMagicLinkRequest = useCallback(() => {
    setMagicLinkRequest({ status: "idle" });
  }, []);

  /*
    Signing out of an ANONYMOUS identity would strand that user's work behind
    a key nothing can reach again, so the UI only ever offers this to a
    claimed account. Landing on `/` rather than reloading in place makes the
    new state unambiguous.
  */
  const signOut = useCallback(async () => {
    await authClient.signOut();
    window.location.assign("/");
  }, []);

  return {
    isEnabled,
    identity: isEnabled ? identity : null,
    isUnclaimed: identity !== undefined && identity !== null && identity.isAnonymous,
    credits,
    magicLinkRequest,
    sendMagicLink,
    resetMagicLinkRequest,
    signOut,
  };
}
