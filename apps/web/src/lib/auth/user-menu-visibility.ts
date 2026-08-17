import type { FlockIdentity } from "./use-flock-auth";

/*
  IS THERE A USER MENU ON SCREEN RIGHT NOW?

  One predicate, two callers, and that is the whole point of it existing.

  `UserButton` carries the only link back out of the studio ("Your emails"),
  and it renders NOTHING in two states:

    1. auth is disabled — NEXT_PUBLIC_FLOCK_AUTH_ENABLED is not "true", which
       is the default and the state of most deploys (see ./config.ts); and
    2. the identity query has not answered yet — `identity` is `undefined` on
       every first paint, even on a deploy where auth is on and the user is
       signed in.

  In both, the editor is a one-way door: no header, no nav, no link home. The
  dashboard is still there at /dashboard, just unreachable without typing a
  URL. So `DashboardLinkFallback` stands in — and it must appear EXACTLY when
  the menu does not, never alongside it. Two "Your emails" affordances two
  pixels apart is a different bug, not a fix.

  Hence: both components ask this one function, and the fallback takes the
  negation. There is no way for them to disagree, and no second copy of the
  gate to drift when `UserButton`'s early return is next edited. If you change
  what `UserButton` returns null on, change it HERE.

  The type predicate is what lets `UserButton` keep reading `identity.email`
  after the guard without a cast.
*/
export function willRenderUserMenu(args: {
  isEnabled: boolean;
  identity: FlockIdentity | null | undefined;
}): args is { isEnabled: true; identity: FlockIdentity } {
  return args.isEnabled && args.identity !== undefined && args.identity !== null;
}
