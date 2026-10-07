export interface ManagedBrowserLike {
  connected: boolean;
  on(event: "disconnected", listener: () => void): void;
  off?(event: "disconnected", listener: () => void): void;
  createBrowserContext(): Promise<ManagedBrowserContextLike>;
  close(): Promise<void>;
}

export interface ManagedBrowserContextLike {
  newPage(): Promise<unknown>;
  close(): Promise<void>;
}

let browserPromise: Promise<ManagedBrowserLike> | null = null;
let activeBrowser: ManagedBrowserLike | null = null;
let disconnectListener: (() => void) | null = null;

function clearBrowser(browser: ManagedBrowserLike): void {
  if (activeBrowser !== browser) {
    return;
  }
  if (disconnectListener !== null) {
    browser.off?.("disconnected", disconnectListener);
  }
  activeBrowser = null;
  browserPromise = null;
  disconnectListener = null;
}

export async function getWarmBrowser(
  launchBrowser: () => Promise<ManagedBrowserLike>,
): Promise<ManagedBrowserLike> {
  if (activeBrowser !== null && activeBrowser.connected) {
    return activeBrowser;
  }
  if (browserPromise !== null) {
    return browserPromise;
  }

  const pendingBrowserHolder: { promise: Promise<ManagedBrowserLike> | null } = { promise: null };
  const pendingBrowser = Promise.resolve().then(async () => {
    const browser = await launchBrowser();
    if (browserPromise !== pendingBrowserHolder.promise) {
      await browser.close().catch(() => undefined);
      throw new Error("The browser was replaced while it was launching.");
    }
    activeBrowser = browser;
    disconnectListener = () => clearBrowser(browser);
    browser.on("disconnected", disconnectListener);
    if (!browser.connected || browserPromise !== pendingBrowserHolder.promise) {
      clearBrowser(browser);
      await browser.close().catch(() => undefined);
      throw new Error("The browser disconnected during launch.");
    }
    return browser;
  });
  pendingBrowserHolder.promise = pendingBrowser;
  browserPromise = pendingBrowser;
  try {
    return await pendingBrowser;
  } catch (error) {
    if (browserPromise === pendingBrowser) {
      browserPromise = null;
    }
    throw error;
  }
}

export function resetWarmBrowserForTests(): void {
  if (activeBrowser !== null) {
    clearBrowser(activeBrowser);
  } else {
    browserPromise = null;
  }
}

export async function discardWarmBrowser(browser: ManagedBrowserLike): Promise<void> {
  clearBrowser(browser);
  await browser.close().catch(() => undefined);
}
