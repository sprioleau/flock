import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  CanvasZoomControls,
  DEFAULT_CANVAS_ZOOM_PERCENT,
  calculateFitCanvasLayout,
  clampZoomPercent,
  getNextZoomPercent,
} from "./canvas-zoom";

interface ElementWithProps extends ReactElement {
  props: Record<string, unknown>;
}

function collectElements(node: ReactNode): ElementWithProps[] {
  const found: ElementWithProps[] = [];
  function visit(current: ReactNode): void {
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
  }
  visit(node);
  return found;
}

function findButton(node: ReactNode, label: string): ElementWithProps {
  const button = collectElements(node).find(
    (element) => element.props["aria-label"] === label,
  );
  if (button === undefined) {
    throw new Error(`Could not find button ${label}`);
  }
  return button;
}

function visibleText(node: ReactNode): string {
  const parts: string[] = [];
  function visit(current: ReactNode): void {
    if (typeof current === "string" || typeof current === "number") {
      parts.push(String(current));
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
  }
  visit(node);
  return parts.join("");
}

describe("canvas zoom math", () => {
  it("uses the existing 70% canvas scale as the default user-visible zoom", () => {
    expect(DEFAULT_CANVAS_ZOOM_PERCENT).toBe(70);
  });

  it("clamps zoom to the supported 2% through 200% range", () => {
    expect(clampZoomPercent(-10)).toBe(2);
    expect(clampZoomPercent(2)).toBe(2);
    expect(clampZoomPercent(61)).toBe(61);
    expect(clampZoomPercent(200)).toBe(200);
    expect(clampZoomPercent(240)).toBe(200);
  });

  it("changes zoom in sensible ten-point steps without escaping the bounds", () => {
    expect(getNextZoomPercent(61, "in")).toBe(71);
    expect(getNextZoomPercent(61, "out")).toBe(51);
    expect(getNextZoomPercent(196, "in")).toBe(200);
    expect(getNextZoomPercent(6, "out")).toBe(2);
  });

  it("fits every draft while keeping inter-frame gaps and edge padding equal", () => {
    const layout = calculateFitCanvasLayout({
      viewportWidthPx: 1200,
      draftWidthsPx: [680, 680, 375],
      gapPx: 24,
    });

    const naturalWidthPx = 680 + 680 + 375;
    const occupiedWidthPx =
      (naturalWidthPx * layout.zoomPercent) / 100 + 2 * layout.gapPx + 2 * layout.sidePaddingPx;

    expect(layout.zoomPercent).toBe(Math.floor(((1200 - 4 * 24) / naturalWidthPx) * 100));
    expect(layout.gapPx).toBe(24);
    expect(layout.sidePaddingPx).toBe(layout.gapPx);
    expect(layout.leftPaddingPx).toBe(layout.rightPaddingPx);
    expect(occupiedWidthPx).toBeLessThanOrEqual(1200);
    expect(1200 - occupiedWidthPx).toBeLessThanOrEqual(naturalWidthPx / 100);
  });
});

describe("canvas zoom controls", () => {
  it("disables only the control that would cross a zoom bound", () => {
    const minimumTree = CanvasZoomControls({
      zoomPercent: 2,
      onZoomChange: vi.fn(),
      onFitToView: vi.fn(),
    });
    const maximumTree = CanvasZoomControls({
      zoomPercent: 200,
      onZoomChange: vi.fn(),
      onFitToView: vi.fn(),
    });

    expect(findButton(minimumTree, "Zoom out").props.disabled).toBe(true);
    expect(findButton(minimumTree, "Zoom in").props.disabled).toBe(false);
    expect(findButton(maximumTree, "Zoom out").props.disabled).toBe(false);
    expect(findButton(maximumTree, "Zoom in").props.disabled).toBe(true);
  });

  it("exposes labelled controls and double-clicking the percentage fits the canvas", () => {
    const onZoomChange = vi.fn();
    const onFitToView = vi.fn();

    const tree = CanvasZoomControls({
      zoomPercent: 61,
      onZoomChange,
      onFitToView,
    });
    const zoomOut = findButton(tree, "Zoom out");
    const zoomIn = findButton(tree, "Zoom in");
    const percentage = findButton(tree, "Zoom percentage: 61%");

    expect(zoomOut.props.title).toBe("Zoom out");
    expect(zoomIn.props.title).toBe("Zoom in");
    expect(percentage.props.title).toBe("Double-click to fit view");
    expect(visibleText(percentage.props.children as ReactNode)).toBe("61%");

    (zoomOut.props.onClick as () => void)();
    (zoomIn.props.onClick as () => void)();
    (percentage.props.onDoubleClick as () => void)();

    expect(onZoomChange).toHaveBeenNthCalledWith(1, "out");
    expect(onZoomChange).toHaveBeenNthCalledWith(2, "in");
    expect(onFitToView).toHaveBeenCalledTimes(1);
  });

  it("makes the fit action keyboard-accessible with Enter and Space", () => {
    const onFitToView = vi.fn();
    const tree = CanvasZoomControls({
      zoomPercent: 61,
      onZoomChange: vi.fn(),
      onFitToView,
    });
    const percentage = findButton(tree, "Zoom percentage: 61%");
    const preventDefault = vi.fn();
    const onKeyDown = percentage.props.onKeyDown as
      | ((event: { key: string; preventDefault: () => void }) => void)
      | undefined;

    if (onKeyDown === undefined) {
      throw new Error("The zoom percentage button must handle keyboard input");
    }
    onKeyDown({ key: "Enter", preventDefault });
    onKeyDown({ key: " ", preventDefault });

    expect(onFitToView).toHaveBeenCalledTimes(2);
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });
});
