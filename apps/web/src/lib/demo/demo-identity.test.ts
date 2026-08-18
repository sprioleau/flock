import { describe, expect, it, vi } from "vitest";
import { ensureDemoIdentity } from "./demo-identity";

/*
  The four rules that decide whether a /demo visitor reaches the comment beat
  with an identity — and, just as importantly, whether they reach it at all.

  Nothing here touches the Better Auth client: `ensureDemoIdentity` takes its
  collaborators as arguments precisely so these can be stubs, which is what
  lets the rules be checked in a node environment with no DOM and no network.
*/

function createSignedOutLookup() {
  return vi.fn(async () => ({ data: null }));
}

describe("ensureDemoIdentity", () => {
  it("does nothing at all when auth is switched off", async () => {
    /* The pre-auth world: ownership already falls back to the client-supplied
       session id, so signing in would buy nothing and cost a round trip. */
    const getSession = createSignedOutLookup();
    const signInAnonymously = vi.fn(async () => {});

    const outcome = await ensureDemoIdentity({
      isAuthEnabled: false,
      getSession,
      signInAnonymously,
    });

    expect(outcome).toBe("disabled");
    expect(getSession).not.toHaveBeenCalled();
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it("leaves an existing session alone rather than minting a second identity", async () => {
    /* The anti-clobber invariant. Anonymous sign-in creates a NEW identity, so
       doing it over a session that already exists would strand whatever that
       visitor already owned behind an unreachable key. */
    const getSession = vi.fn(async () => ({ data: { user: { id: "user-1" } } }));
    const signInAnonymously = vi.fn(async () => {});

    const outcome = await ensureDemoIdentity({
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

    const outcome = await ensureDemoIdentity({
      isAuthEnabled: true,
      getSession,
      signInAnonymously,
    });

    expect(outcome).toBe("created");
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it("reports a failed session lookup instead of rejecting", async () => {
    /* Never block the demo: the caller awaits this before provisioning, so a
       rejection here would take out the whole run — including the two beats
       that need no identity whatsoever. */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const signInAnonymously = vi.fn(async () => {});

    const outcome = await ensureDemoIdentity({
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

    const outcome = await ensureDemoIdentity({
      isAuthEnabled: true,
      getSession: createSignedOutLookup(),
      signInAnonymously: async () => {
        throw new Error("rate limited");
      },
    });

    expect(outcome).toBe("unavailable");
    warn.mockRestore();
  });
});
