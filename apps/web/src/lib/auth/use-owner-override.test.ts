import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OWNER_OVERRIDE_STATUS_PATH,
  getOwnerOverrideStatus,
  readOwnerOverrideStatus,
  refreshOwnerOverride,
  setOwnerOverrideUnlocked,
} from "./use-owner-override";

/**
 * The shared "does this browser hold an override?" signal.
 *
 * The property under test is FAILING CLOSED. Every consumer of this hook uses
 * it to decide whether to show an owner-only control, so a hopeful default
 * would put that control in front of people who cannot use it the first time
 * the network hiccups. Every failure shape below must land on `false`.
 *
 * The React binding itself (useSyncExternalStore) is not covered — there is no
 * DOM environment in this suite — but the store it reads from is, and that is
 * where the decisions live.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readOwnerOverrideStatus", () => {
  it("is unlocked only for an explicit isUnlocked: true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ isUnlocked: true })),
    );
    await expect(readOwnerOverrideStatus()).resolves.toBe(true);
  });

  it("asks the status endpoint without a cache, with cookies attached", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ isUnlocked: true }));
    vi.stubGlobal("fetch", fetchMock);

    await readOwnerOverrideStatus();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(OWNER_OVERRIDE_STATUS_PATH);
    expect(init?.method).toBe("GET");
    // A cached "true" would show an owner-only control to the next visitor.
    expect(init?.cache).toBe("no-store");
    expect(init?.credentials).toBe("same-origin");
  });

  it("is locked for isUnlocked: false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ isUnlocked: false })),
    );
    await expect(readOwnerOverrideStatus()).resolves.toBe(false);
  });

  it("is locked for a truthy-but-not-true value", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ isUnlocked: "yes" })),
    );
    await expect(readOwnerOverrideStatus()).resolves.toBe(false);
  });

  it("is locked when the endpoint errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("nope", { status: 500 })),
    );
    await expect(readOwnerOverrideStatus()).resolves.toBe(false);
  });

  it("is locked when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("<html/>", { status: 200 })),
    );
    await expect(readOwnerOverrideStatus()).resolves.toBe(false);
  });

  it("is locked when the network is down, rather than rejecting", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));
    await expect(readOwnerOverrideStatus()).resolves.toBe(false);
  });
});

describe("the shared override store", () => {
  it("starts out checking, which is not the same as locked", () => {
    expect(getOwnerOverrideStatus()).toEqual({ isChecking: true, isUnlocked: false });
  });

  it("publishes the answer once a refresh lands", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ isUnlocked: true })),
    );
    await refreshOwnerOverride();
    expect(getOwnerOverrideStatus()).toEqual({ isChecking: false, isUnlocked: true });
  });

  it("shares one request between concurrent callers", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ isUnlocked: true }));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([refreshOwnerOverride(), refreshOwnerOverride(), refreshOwnerOverride()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("applies a known answer without a round trip (instant feedback)", () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    setOwnerOverrideUnlocked(true);
    expect(getOwnerOverrideStatus()).toEqual({ isChecking: false, isUnlocked: true });

    setOwnerOverrideUnlocked(false);
    expect(getOwnerOverrideStatus()).toEqual({ isChecking: false, isUnlocked: false });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
