import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function installFakeBrowser(seed: Record<string, string>): Map<string, string> {
  const backingStore = new Map(Object.entries(seed));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string): string | null => backingStore.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        backingStore.set(key, value);
      },
      removeItem: (key: string): void => {
        backingStore.delete(key);
      },
    },
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    dispatchEvent: (): boolean => true,
  });
  return backingStore;
}

describe("the public demo session preset", () => {
  it("does not start, dismiss, or otherwise rewrite the optional walkthrough", async () => {
    const tourProgressRaw = '{"status":"unseen","resumeStopId":null}';
    const backingStore = installFakeBrowser({
      "flock:tour-progress": tourProgressRaw,
    });
    const session = await import("./demo-session");

    session.beginDemoSession({ documentId: "doc_demo" });
    expect(backingStore.get("flock:tour-progress")).toBe(tourProgressRaw);

    session.endDemoSession();
    expect(backingStore.get("flock:tour-progress")).toBe(tourProgressRaw);
  });
});
