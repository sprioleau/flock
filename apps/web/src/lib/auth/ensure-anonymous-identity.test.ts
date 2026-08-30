import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureAnonymousIdentity,
  resetAnonymousIdentityForTests,
} from "./ensure-anonymous-identity";

/*
  The rules that decide whether a stranger on a public entrance to the editor
  reaches the writes that verify an owner with an identity — and, just as
  importantly, whether they reach the editor at all.

  Nothing here touches the Better Auth client: `ensureAnonymousIdentity` takes
  its collaborators as arguments precisely so these can be stubs, which is what
  lets the rules be checked in a node environment with no DOM and no network.
*/

function createSignedOutLookup() {
  return vi.fn(async () => ({ data: null }));
}

/*
  The in-flight slot is module state shared by every case in this file, and the
  concurrency cases below deliberately leave an attempt pending mid-assertion.
*/
beforeEach(() => {
  resetAnonymousIdentityForTests();
});

describe("ensureAnonymousIdentity", () => {
  it("does nothing at all when auth is switched off", async () => {
    /*
      The pre-auth world: ownership already falls back to the client-supplied
      session id, so signing in would buy nothing and cost a round trip.
    */
    const getSession = createSignedOutLookup();
    const signInAnonymously = vi.fn(async () => {});

    const outcome = await ensureAnonymousIdentity({
      isAuthEnabled: false,
      getSession,
      signInAnonymously,
    });

    expect(outcome).toBe("disabled");
    expect(getSession).not.toHaveBeenCalled();
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it("leaves an existing session alone rather than minting a second identity", async () => {
    /*
      The anti-clobber invariant. Anonymous sign-in creates a NEW identity, so
      doing it over a session that already exists would strand whatever that
      visitor already owned behind an unreachable key.
    */
    const getSession = vi.fn(async () => ({ data: { user: { id: "user-1" } } }));
    const signInAnonymously = vi.fn(async () => {});

    const outcome = await ensureAnonymousIdentity({
      isAuthEnabled: true,
      getSession,
      signInAnonymously,
    });

    expect(outcome).toBe("existing");
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it("signs a signed-out visitor in exactly once", async () => {
    const getSession = createSignedOutLookup();
    const signInAnonymously = vi.fn(async () => {});

    const outcome = await ensureAnonymousIdentity({
      isAuthEnabled: true,
      getSession,
      signInAnonymously,
    });

    expect(outcome).toBe("created");
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it("reports a failed session lookup instead of rejecting", async () => {
    /*
      Never block the caller: DemoBootstrap awaits this before provisioning,
      so a rejection here would take out the whole run — including the beats
      that need no identity whatsoever.
    */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const signInAnonymously = vi.fn(async () => {});

    const outcome = await ensureAnonymousIdentity({
      isAuthEnabled: true,
      getSession: async () => {
        throw new Error("auth endpoint unreachable");
      },
      signInAnonymously,
    });

    expect(outcome).toBe("unavailable");
    expect(signInAnonymously).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reports a failed sign-in instead of rejecting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await ensureAnonymousIdentity({
      isAuthEnabled: true,
      getSession: createSignedOutLookup(),
      signInAnonymously: async () => {
        throw new Error("rate limited");
      },
    });

    expect(outcome).toBe("unavailable");
    warn.mockRestore();
  });

  it("mints one identity when two callers arrive while the session lookup is still open", async () => {
    /*
      The double-mint hazard, staged: the /demo mount fires DemoBootstrap and
      the provider effect in the same tick, and the session lookup is a
      network round trip, so both would otherwise be told "signed out" and
      both would mint a user — stranding whatever the first one owned.
    */
    let releaseSessionLookup = () => {};
    const isSessionLookupOpen = new Promise<void>((resolve) => {
      releaseSessionLookup = resolve;
    });
    const getSession = vi.fn(async () => {
      await isSessionLookupOpen;
      return { data: null };
    });
    const signInAnonymously = vi.fn(async () => {});
    const collaborators = { isAuthEnabled: true, getSession, signInAnonymously };

    const firstCaller = ensureAnonymousIdentity(collaborators);
    const secondCaller = ensureAnonymousIdentity(collaborators);
    releaseSessionLookup();

    expect(await firstCaller).toBe("created");
    /*
      The second caller gets the FIRST attempt's outcome, not an early return:
      DemoBootstrap sequences provisioning behind this await, so resolving
      before the identity exists would put /demo back where it started.
    */
    expect(await secondCaller).toBe("created");
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it("asks again once an attempt has settled, so a later visit is not answered by a stale result", async () => {
    /*
      The slot is a de-duplicator, not a cache. A visitor who signed out, or
      who reaches a qualifying route long afterwards, must get a fresh look at
      the session rather than the answer from page load.
    */
    let isSignedIn = false;
    const getSession = vi.fn(async () => ({
      data: isSignedIn ? { user: { id: "user-1" } } : null,
    }));
    const signInAnonymously = vi.fn(async () => {
      isSignedIn = true;
    });
    const collaborators = { isAuthEnabled: true, getSession, signInAnonymously };

    expect(await ensureAnonymousIdentity(collaborators)).toBe("created");
    /*
      The soft navigation from /demo to /studio?doc=… re-runs the rule, and it
      must see the session the first attempt established.
    */
    expect(await ensureAnonymousIdentity(collaborators)).toBe("existing");
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
  });
});
