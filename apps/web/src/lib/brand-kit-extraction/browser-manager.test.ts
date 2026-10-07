import { describe, expect, it, vi } from "vitest";

import { getWarmBrowser, resetWarmBrowserForTests, type ManagedBrowserLike } from "./browser-manager";

function createBrowser() {
  let disconnectListener: (() => void) | undefined;
  let isConnected = true;
  const browser: ManagedBrowserLike = {
    get connected() { return isConnected; },
    on: vi.fn((_event, listener) => {
      disconnectListener = listener;
    }),
    off: vi.fn(),
    createBrowserContext: vi.fn(async () => ({ newPage: vi.fn(), close: vi.fn() })),
    close: vi.fn(async () => undefined),
  };
  return {
    browser,
    disconnect() {
      isConnected = false;
      disconnectListener?.();
    },
  };
}

describe("warm browser manager", () => {
  it("reuses one connected Chromium process while callers create their own contexts", async () => {
    resetWarmBrowserForTests();
    const first = createBrowser();
    const launchBrowser = vi.fn(async () => first.browser);

    const firstBrowser = await getWarmBrowser(launchBrowser);
    const firstContext = await firstBrowser.createBrowserContext();
    const secondBrowser = await getWarmBrowser(launchBrowser);
    const secondContext = await secondBrowser.createBrowserContext();

    expect(launchBrowser).toHaveBeenCalledOnce();
    expect(firstBrowser).toBe(secondBrowser);
    expect(firstContext).not.toBe(secondContext);
    resetWarmBrowserForTests();
  });

  it("relaunches after Chromium disconnects", async () => {
    resetWarmBrowserForTests();
    const first = createBrowser();
    const second = createBrowser();
    const launchBrowser = vi.fn().mockResolvedValueOnce(first.browser).mockResolvedValueOnce(second.browser);

    await getWarmBrowser(launchBrowser);
    first.disconnect();
    const recoveredBrowser = await getWarmBrowser(launchBrowser);

    expect(launchBrowser).toHaveBeenCalledTimes(2);
    expect(recoveredBrowser).toBe(second.browser);
    resetWarmBrowserForTests();
  });

  it("shares an in-flight launch across concurrent renders and retries a failed launch", async () => {
    resetWarmBrowserForTests();
    const browser = createBrowser();
    const launchBrowser = vi.fn().mockRejectedValueOnce(new Error("launch failed"));

    await expect(Promise.all([
      getWarmBrowser(launchBrowser),
      getWarmBrowser(launchBrowser),
    ])).rejects.toThrow("launch failed");
    expect(launchBrowser).toHaveBeenCalledOnce();

    launchBrowser.mockResolvedValueOnce(browser.browser);
    await expect(getWarmBrowser(launchBrowser)).resolves.toBe(browser.browser);
    expect(launchBrowser).toHaveBeenCalledTimes(2);
    resetWarmBrowserForTests();
  });
});
