import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { FlockIdentity } from "./use-flock-auth";

/*
  THE STUDIO MUST ALWAYS HAVE A WAY OUT.

  The "Your emails" link lives in the account menu, and the account menu is
  absent in two states that between them cover most of the product's life:
  every deploy with auth disabled, and the first paint of every deploy with it
  enabled. That is the bug this pair of components exists to close, so this
  suite checks the property rather than either component's internals:

    across ALL FOUR auth states, exactly ONE reachable link to /dashboard.

  One is the floor (the studio is never a one-way door) and one is also the
  ceiling (no pair of competing "Your emails" affordances side by side).

  There is no DOM here — vitest.config.ts pins `environment: "node"` — so the
  components are called as plain functions over a stubbed `useFlockAuth` and
  the element trees they return are walked. `href` sits on the <Link> handed
  to Base UI's `render` prop, so the walk follows `render` as well as
  `children`.
*/

const authState: { current: ReturnType<typeof makeAuth> } = {
  current: makeAuth({ isEnabled: false, identity: null }),
};

vi.mock("./use-flock-auth", () => ({
  useFlockAuth: () => authState.current,
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  /*
    UserButton parks the claim form's email in useState. Outside a renderer
    the real hook has no dispatcher to reach; the value never changes in these
    trees, so a constant stands in for it.
  */
  return {
    ...actual,
    useState: (initial: unknown) => [
      typeof initial === "function" ? (initial as () => unknown)() : initial,
      () => {},
    ],
  };
});

import { DASHBOARD_PATH } from "./config";
import { DashboardLinkFallback } from "./DashboardLinkFallback";
import { UserButton } from "./UserButton";

function makeAuth(args: { isEnabled: boolean; identity: FlockIdentity | null | undefined }) {
  return {
    isEnabled: args.isEnabled,
    identity: args.identity,
    isUnclaimed: args.identity !== undefined && args.identity !== null && args.identity.isAnonymous,
    credits: null,
    magicLinkRequest: { status: "idle" } as const,
    sendMagicLink: async () => {},
    resetMagicLinkRequest: () => {},
    signOut: async () => {},
  };
}

interface ElementWithProps extends ReactElement {
  props: Record<string, unknown>;
}

/* Every element in the tree, following `children` and Base UI's `render`. */
function collectElements(node: ReactNode): ElementWithProps[] {
  const found: ElementWithProps[] = [];
  const visit = (current: ReactNode): void => {
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child as ReactNode);
      }
      return;
    }
    if (!isValidElement(current)) {
      return;
    }
    const element = current as ElementWithProps;
    found.push(element);
    visit(element.props.children as ReactNode);
    visit(element.props.render as ReactNode);
  };
  visit(node);
  return found;
}

function findDashboardLinks(node: ReactNode): ElementWithProps[] {
  return collectElements(node).filter((element) => element.props.href === DASHBOARD_PATH);
}

/*
  What the studio's header actually offers in a given auth state: both
  components are mounted side by side in StudioToolbar, so the count that
  matters is the count across the pair.
*/
function countStudioDashboardLinks(): number {
  return (
    findDashboardLinks(UserButton()).length + findDashboardLinks(DashboardLinkFallback()).length
  );
}

const claimedIdentity: FlockIdentity = {
  id: "user_1",
  email: "person@example.com",
  isAnonymous: false,
};

const anonymousIdentity: FlockIdentity = {
  id: "user_2",
  email: "anon@flock.local",
  isAnonymous: true,
};

describe("the studio's way out", () => {
  it("is reachable when auth is disabled — the menu never mounts at all", () => {
    authState.current = makeAuth({ isEnabled: false, identity: null });
    expect(UserButton()).toBeNull();
    expect(findDashboardLinks(DashboardLinkFallback())).toHaveLength(1);
  });

  it("is reachable while the identity query is still in flight", () => {
    /*
      The gap this closes: a link that waits for identity leaves the first
      paint of an auth-enabled deploy with no exit either.
    */
    authState.current = makeAuth({ isEnabled: true, identity: undefined });
    expect(UserButton()).toBeNull();
    expect(findDashboardLinks(DashboardLinkFallback())).toHaveLength(1);
  });

  it("is reachable when auth is on and nobody is signed in", () => {
    authState.current = makeAuth({ isEnabled: true, identity: null });
    expect(UserButton()).toBeNull();
    expect(findDashboardLinks(DashboardLinkFallback())).toHaveLength(1);
  });

  it("names itself for anyone who cannot see the icon", () => {
    authState.current = makeAuth({ isEnabled: false, identity: null });
    const [link] = findDashboardLinks(DashboardLinkFallback());
    const trigger = collectElements(DashboardLinkFallback()).find(
      (element) => element.props["data-testid"] === "dashboard-link-fallback",
    );
    expect(link).toBeDefined();
    expect(trigger!.props["aria-label"]).toBe("Your emails");
  });
});

describe("exactly one exit, in every auth state", () => {
  it("does not double up once the account menu carries the link", () => {
    for (const identity of [claimedIdentity, anonymousIdentity]) {
      authState.current = makeAuth({ isEnabled: true, identity });
      /* The menu is on screen, so the standby must be off it. */
      expect(DashboardLinkFallback()).toBeNull();
      expect(findDashboardLinks(UserButton())).toHaveLength(1);
    }
  });

  it("holds the count at one across every state the header can be in", () => {
    const states = [
      makeAuth({ isEnabled: false, identity: null }),
      makeAuth({ isEnabled: false, identity: undefined }),
      makeAuth({ isEnabled: true, identity: undefined }),
      makeAuth({ isEnabled: true, identity: null }),
      makeAuth({ isEnabled: true, identity: claimedIdentity }),
      makeAuth({ isEnabled: true, identity: anonymousIdentity }),
    ];
    for (const state of states) {
      authState.current = state;
      expect(countStudioDashboardLinks()).toBe(1);
    }
  });
});
