import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockId } from "@flock/email-sdk";

/*
  The logo block's brand row, checked the way this app checks components:
  there is no DOM here (vitest.config.ts pins `environment: "node"`), so the
  component is called as a plain function over stubbed hooks and the element
  tree it returns is walked. Layout is CSS and belongs to the browser pass.

  What this suite is actually defending — the unconfirmed state, where the
  security property lives:

  - the suggestion is SHOWN, so "confirm this logo" is a judgement the user
    can actually make rather than a leap of faith;
  - a suggestion that 404s (third-party address, no promises) degrades to a
    placeholder instead of a broken-image glyph next to the ask;
  - confirming goes through the brand kit panel's own route wrapper, naming
    ONLY the asset kind — the route re-reads the URL from the kit row, and a
    client that could name a URL would be an SSRF hole;
  - confirming is in-flight-guarded, so the rehost cannot be double-fired;
  - a FAILED confirm says what failed, in the route's own words;
  - and across every one of those paths NOTHING is dispatched into the
    document. The only value that ever reaches a dispatch is the CONFIRMED
    durable URL, after the kit row says so (owner decision 4).
*/

/*
  A three-line stand-in for React's hook state: index-keyed cells, reset at
  the top of each render. Enough to press a button, re-render, and see what
  changed — which is the whole point of the in-flight and error assertions.
*/
const reactHooks = vi.hoisted(() => {
  const cells: unknown[] = [];
  let cursor = 0;
  return {
    clear(): void {
      cells.length = 0;
      cursor = 0;
    },
    startRender(): void {
      cursor = 0;
    },
    useState<T>(initialValue: T): [T, (nextValue: T) => void] {
      const index = cursor;
      cursor += 1;
      if (cells.length <= index) {
        cells.push(initialValue);
      }
      /* The one assertion in this file: a hook store is index-keyed by nature. */
      return [
        cells[index] as T,
        (nextValue: T) => {
          cells[index] = nextValue;
        },
      ];
    },
  };
});

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, useState: reactHooks.useState };
});

/* Two logo blocks, so "apply to all" has something to count. */
const editorStore = vi.hoisted(() => ({
  authorId: "session_me",
  doc: {
    root: { id: "root", type: "root", parentId: null, childrenIds: ["sec"], properties: {} },
    sec: {
      id: "sec",
      type: "section",
      parentId: "root",
      childrenIds: ["img_head", "img_foot"],
      properties: {},
    },
    img_head: {
      id: "img_head",
      type: "image",
      parentId: "sec",
      childrenIds: [],
      properties: { src: "https://placehold.co/200x60", alt: "", role: "logo" },
    },
    img_foot: {
      id: "img_foot",
      type: "image",
      parentId: "sec",
      childrenIds: [],
      properties: { src: "https://placehold.co/120x40", alt: "", role: "logo" },
    },
  },
  dispatch: vi.fn(),
  endCoalescing: vi.fn(),
}));

vi.mock("@/lib/editor-store", () => ({
  useEditorStore: (selector: (state: typeof editorStore) => unknown) => selector(editorStore),
}));

const SUGGESTED_LOGO_URL = "https://acme.com/logo.svg";
const DURABLE_LOGO_URL = "https://storage.convex.cloud/acme-logo.png";

/*
  The kit as the reactive query would hand it over. `logoConfirmedAtMs: 0`
  stands for "still only a suggestion"; flipping it is how a test replays the
  live update that lands after a successful confirm.
*/
const brandKit = vi.hoisted(() => ({
  name: "Acme",
  logoUrl: "https://acme.com/logo.svg",
  logoConfirmedAtMs: 0,
  canvasKitId: "kit_mine",
  sessionKitId: "kit_mine",
}));

vi.mock("../brand-kit/useActiveBrandKit", () => ({
  useActiveBrandKit: () => ({
    brandKit: {
      name: brandKit.name,
      fonts: { heading: "Inter", body: "Inter" },
      variations: [],
      logoUrl: brandKit.logoUrl,
      ...(brandKit.logoConfirmedAtMs === 0
        ? {}
        : { logoConfirmedAtMs: brandKit.logoConfirmedAtMs }),
    },
    hasSavedKit: true,
    isBoundToCanvas: true,
    kitId: brandKit.canvasKitId,
  }),
  useSessionBrandKit: () => ({
    brandKit: { name: brandKit.name, fonts: { heading: "Inter", body: "Inter" }, variations: [] },
    hasSavedKit: true,
    kitId: brandKit.sessionKitId,
  }),
}));

const requestUiSurfaceOpen = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ui-surfaces", () => ({ requestUiSurfaceOpen }));

const confirmBrandAsset = vi.hoisted(() => vi.fn());
vi.mock("@/lib/brand-asset-confirm", () => ({ confirmBrandAsset }));

import { BrandLogoPromptRow } from "./BrandLogoPromptRow";

interface ElementWithProps extends ReactElement {
  props: Record<string, unknown>;
}

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
  };
  visit(node);
  return found;
}

function findByTestId(node: ReactNode, testId: string): ElementWithProps | undefined {
  return collectElements(node).find((element) => element.props["data-testid"] === testId);
}

function visibleText(node: ReactNode): string {
  const parts: string[] = [];
  const visit = (current: ReactNode): void => {
    if (typeof current === "string") {
      parts.push(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child as ReactNode);
      }
      return;
    }
    if (!isValidElement(current)) {
      return;
    }
    visit((current as ElementWithProps).props.children as ReactNode);
  };
  visit(node);
  return parts.join(" ");
}

const blockId = "img_head" as BlockId;

function renderRow(): ReactNode {
  reactHooks.startRender();
  return BrandLogoPromptRow({ blockId });
}

function press(node: ReactNode, testId: string): void {
  const element = findByTestId(node, testId);
  expect(element, `no element with testid ${testId}`).toBeDefined();
  (element!.props.onClick as () => void)();
}

/* Let the confirm promise and its continuations run before re-rendering. */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  reactHooks.clear();
  brandKit.logoUrl = SUGGESTED_LOGO_URL;
  brandKit.logoConfirmedAtMs = 0;
  brandKit.canvasKitId = "kit_mine";
  brandKit.sessionKitId = "kit_mine";
  editorStore.dispatch.mockReset();
  editorStore.endCoalescing.mockReset();
  requestUiSurfaceOpen.mockReset();
  confirmBrandAsset.mockReset();
  confirmBrandAsset.mockResolvedValue({ isOk: true, url: DURABLE_LOGO_URL });
});

describe("the unconfirmed state", () => {
  it("shows the suggested logo itself, described, not a generic icon", () => {
    const image = findByTestId(renderRow(), "brand-logo-prompt-suggested-image");
    expect(image).toBeDefined();
    expect(image!.props.src).toBe(SUGGESTED_LOGO_URL);
    expect(image!.props.alt).toBe("Suggested logo for Acme");
  });

  it("offers a confirm control and no way to apply the suggestion", () => {
    const tree = renderRow();
    expect(findByTestId(tree, "brand-logo-prompt-confirm-logo")).toBeDefined();
    /* Applying an unconfirmed hotlink is the thing decision 4 forbids. */
    expect(findByTestId(tree, "brand-logo-prompt-apply-one")).toBeUndefined();
    expect(findByTestId(tree, "brand-logo-prompt-apply-all")).toBeUndefined();
  });

  it("keeps the full brand kit reachable, demoted", () => {
    press(renderRow(), "brand-logo-prompt-open-brand-kit");
    expect(requestUiSurfaceOpen).toHaveBeenCalledWith("brand-kit");
  });

  it("falls back to a placeholder when the third-party image doesn't load", () => {
    const image = findByTestId(renderRow(), "brand-logo-prompt-suggested-image");
    (image!.props.onError as () => void)();
    const afterFailure = renderRow();
    /* No broken-image glyph left sitting in the panel... */
    expect(findByTestId(afterFailure, "brand-logo-prompt-suggested-image")).toBeUndefined();
    expect(findByTestId(afterFailure, "brand-logo-prompt-preview-failed")).toBeDefined();
    /* ...and the ask survives: a dead preview is a warning, not a dead end. */
    expect(findByTestId(afterFailure, "brand-logo-prompt-confirm-logo")).toBeDefined();
    expect(visibleText(afterFailure)).toContain("didn't load from its original address");
  });
});

describe("confirming from the block panel", () => {
  it("names only the asset kind — the route re-reads the URL itself", async () => {
    press(renderRow(), "brand-logo-prompt-confirm-logo");
    await flushAsync();
    expect(confirmBrandAsset).toHaveBeenCalledTimes(1);
    const [request] = confirmBrandAsset.mock.calls[0] as [Record<string, unknown>];
    expect(request).toEqual({ sessionId: "session_me", kind: "logo" });
    /* A client-supplied URL would turn confirm into an SSRF fetch. */
    expect(Object.keys(request)).not.toContain("url");
    expect(JSON.stringify(request)).not.toContain(SUGGESTED_LOGO_URL);
  });

  it("cannot be double-fired while the rehost is in flight", async () => {
    confirmBrandAsset.mockImplementation(() => new Promise(() => {}));
    press(renderRow(), "brand-logo-prompt-confirm-logo");
    const inFlight = renderRow();
    const button = findByTestId(inFlight, "brand-logo-prompt-confirm-logo");
    expect(button!.props.disabled).toBe(true);
    press(inFlight, "brand-logo-prompt-confirm-logo");
    await flushAsync();
    expect(confirmBrandAsset).toHaveBeenCalledTimes(1);
  });

  it("writes nothing into the document — confirming makes the logo durable, that's all", async () => {
    press(renderRow(), "brand-logo-prompt-confirm-logo");
    await flushAsync();
    expect(editorStore.dispatch).not.toHaveBeenCalled();
  });

  it("becomes usable once the kit row reports the logo confirmed", async () => {
    press(renderRow(), "brand-logo-prompt-confirm-logo");
    await flushAsync();
    /* What the reactive kit query delivers after the rehost: the durable URL. */
    brandKit.logoUrl = DURABLE_LOGO_URL;
    brandKit.logoConfirmedAtMs = 1_700_000_000_000;
    const ready = renderRow();
    expect(findByTestId(ready, "brand-logo-prompt-confirm-logo")).toBeUndefined();
    press(ready, "brand-logo-prompt-apply-one");
    expect(editorStore.dispatch).toHaveBeenCalledTimes(1);
    expect(editorStore.dispatch).toHaveBeenCalledWith({
      name: "updateBlockProperties",
      blockId: "img_head",
      properties: { src: DURABLE_LOGO_URL, alt: "Acme logo" },
    });
  });
});

describe("when confirming fails", () => {
  it("shows the route's own reason and leaves the document untouched", async () => {
    confirmBrandAsset.mockResolvedValue({
      isOk: false,
      message: "That address didn't give us an image we can save.",
    });
    press(renderRow(), "brand-logo-prompt-confirm-logo");
    await flushAsync();
    const afterFailure = renderRow();
    expect(visibleText(findByTestId(afterFailure, "brand-logo-prompt-confirm-error"))).toBe(
      "That address didn't give us an image we can save.",
    );
    expect(editorStore.dispatch).not.toHaveBeenCalled();
    /* Still a suggestion, so still no apply — a failure must not "fall open". */
    expect(findByTestId(afterFailure, "brand-logo-prompt-apply-one")).toBeUndefined();
    expect(findByTestId(afterFailure, "brand-logo-prompt-apply-all")).toBeUndefined();
  });

  it("clears its in-flight state so the user can try again", async () => {
    confirmBrandAsset.mockResolvedValue({ isOk: false, message: "We couldn't reach that image." });
    press(renderRow(), "brand-logo-prompt-confirm-logo");
    await flushAsync();
    const retryable = renderRow();
    expect(findByTestId(retryable, "brand-logo-prompt-confirm-logo")!.props.disabled).toBe(false);
    press(retryable, "brand-logo-prompt-confirm-logo");
    await flushAsync();
    expect(confirmBrandAsset).toHaveBeenCalledTimes(2);
  });
});

describe("when the canvas is showing somebody else's kit", () => {
  it("points at the brand kit instead of confirming the wrong row", () => {
    brandKit.canvasKitId = "kit_theirs";
    const tree = renderRow();
    /* The suggestion is still worth seeing — it just cannot be confirmed here. */
    expect(findByTestId(tree, "brand-logo-prompt-suggested-image")).toBeDefined();
    expect(findByTestId(tree, "brand-logo-prompt-confirm-logo")).toBeUndefined();
    press(tree, "brand-logo-prompt-confirm-logo-in-kit");
    expect(confirmBrandAsset).not.toHaveBeenCalled();
    expect(requestUiSurfaceOpen).toHaveBeenCalledWith("brand-kit");
  });
});
