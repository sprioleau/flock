"use client";

import { MinusIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export const MIN_CANVAS_ZOOM_PERCENT = 2;
export const MAX_CANVAS_ZOOM_PERCENT = 200;
export const CANVAS_ZOOM_STEP_PERCENT = 10;
export const DEFAULT_CANVAS_ZOOM_PERCENT = 70;

export function clampZoomPercent(zoomPercent: number): number {
  return Math.min(
    MAX_CANVAS_ZOOM_PERCENT,
    Math.max(MIN_CANVAS_ZOOM_PERCENT, Math.round(zoomPercent)),
  );
}

export function getNextZoomPercent(zoomPercent: number, direction: "in" | "out"): number {
  const delta = direction === "in" ? CANVAS_ZOOM_STEP_PERCENT : -CANVAS_ZOOM_STEP_PERCENT;
  return clampZoomPercent(zoomPercent + delta);
}

export interface FitCanvasLayout {
  zoomPercent: number;
  gapPx: number;
  sidePaddingPx: number;
  leftPaddingPx: number;
  rightPaddingPx: number;
}

export function calculateFitCanvasLayout({
  viewportWidthPx,
  draftWidthsPx,
  gapPx,
}: {
  viewportWidthPx: number;
  draftWidthsPx: number[];
  gapPx: number;
}): FitCanvasLayout {
  const naturalWidthPx = draftWidthsPx.reduce((total, width) => total + width, 0);
  const edgeAndGapCount = draftWidthsPx.length > 0 ? draftWidthsPx.length + 1 : 0;
  const availableForDrafts = viewportWidthPx - edgeAndGapCount * gapPx;
  const zoomPercent =
    naturalWidthPx > 0 && availableForDrafts > 0
      ? clampZoomPercent(Math.floor((availableForDrafts / naturalWidthPx) * 100))
      : MIN_CANVAS_ZOOM_PERCENT;
  return {
    zoomPercent,
    gapPx,
    sidePaddingPx: gapPx,
    leftPaddingPx: gapPx,
    rightPaddingPx: gapPx,
  };
}

export interface CanvasContentBounds {
  leftPx: number;
  topPx: number;
  rightPx: number;
  bottomPx: number;
}

export interface FitCanvasViewportLayout {
  zoomPercent: number;
  paddingPx: number;
  leftPaddingPx: number;
  rightPaddingPx: number;
  topPaddingPx: number;
  bottomPaddingPx: number;
  contentWidthPx: number;
  contentHeightPx: number;
}

function getPositiveFiniteValue(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function getCanvasContentDimension(startPx: number, endPx: number): number {
  if (!Number.isFinite(startPx) || !Number.isFinite(endPx)) {
    return 0;
  }
  return Math.abs(endPx - startPx);
}

/*
  Fit both axes using the same edge padding. Bounds can be offset or extend
  into negative canvas coordinates; only their measured dimensions determine
  the scale, so this function is safe for a translated 2D canvas.
*/
export function calculateFitCanvasViewport({
  viewportWidthPx,
  viewportHeightPx,
  contentBounds,
  paddingPx,
}: {
  viewportWidthPx: number;
  viewportHeightPx: number;
  contentBounds: CanvasContentBounds;
  paddingPx: number;
}): FitCanvasViewportLayout {
  const safeViewportWidthPx = getPositiveFiniteValue(viewportWidthPx);
  const safeViewportHeightPx = getPositiveFiniteValue(viewportHeightPx);
  const safePaddingPx = getPositiveFiniteValue(paddingPx);
  const contentWidthPx = getCanvasContentDimension(contentBounds.leftPx, contentBounds.rightPx);
  const contentHeightPx = getCanvasContentDimension(contentBounds.topPx, contentBounds.bottomPx);
  const availableWidthPx = Math.max(0, safeViewportWidthPx - 2 * safePaddingPx);
  const availableHeightPx = Math.max(0, safeViewportHeightPx - 2 * safePaddingPx);
  const widthZoomPercent = contentWidthPx > 0 ? (availableWidthPx / contentWidthPx) * 100 : Infinity;
  const heightZoomPercent =
    contentHeightPx > 0 ? (availableHeightPx / contentHeightPx) * 100 : Infinity;
  const fitZoomPercent = Math.min(widthZoomPercent, heightZoomPercent);
  const zoomPercent = Number.isFinite(fitZoomPercent)
    ? clampZoomPercent(Math.floor(fitZoomPercent))
    : MIN_CANVAS_ZOOM_PERCENT;

  return {
    zoomPercent,
    paddingPx: safePaddingPx,
    leftPaddingPx: safePaddingPx,
    rightPaddingPx: safePaddingPx,
    topPaddingPx: safePaddingPx,
    bottomPaddingPx: safePaddingPx,
    contentWidthPx,
    contentHeightPx,
  };
}

export interface CanvasScrollTarget {
  scrollLeftPx: number;
  scrollTopPx: number;
}

export interface CanvasPoint {
  xPx: number;
  yPx: number;
}

/*
  Return the scroll offsets that keep a canvas point under the same viewport
  focal point while changing scale. Scroll offsets are clamped because DOM
  scrollers cannot represent negative positions.
*/
export function getFocalPointPreservingScrollTarget({
  focalPointPx,
  previousZoomPercent,
  nextZoomPercent,
  scrollLeftPx,
  scrollTopPx,
}: {
  focalPointPx: CanvasPoint;
  previousZoomPercent: number;
  nextZoomPercent: number;
  scrollLeftPx: number;
  scrollTopPx: number;
}): CanvasScrollTarget {
  const previousScale = clampZoomPercent(previousZoomPercent) / 100;
  const nextScale = clampZoomPercent(nextZoomPercent) / 100;
  const scaleRatio = nextScale / previousScale;

  return {
    scrollLeftPx: Math.max(
      0,
      (scrollLeftPx + focalPointPx.xPx) * scaleRatio - focalPointPx.xPx,
    ),
    scrollTopPx: Math.max(0, (scrollTopPx + focalPointPx.yPx) * scaleRatio - focalPointPx.yPx),
  };
}

/*
  Center a group in the visible viewport after applying the requested zoom.
  The returned target is intentionally independent of DOM state so callers
  can apply it after a zoom render in requestAnimationFrame.
*/
export function getGroupFocusScrollTarget({
  groupBounds,
  viewportWidthPx,
  viewportHeightPx,
  zoomPercent,
}: {
  groupBounds: CanvasContentBounds;
  viewportWidthPx: number;
  viewportHeightPx: number;
  zoomPercent: number;
}): CanvasScrollTarget {
  const scale = clampZoomPercent(zoomPercent) / 100;
  const safeLeftPx = getPositiveFiniteValue(groupBounds.leftPx);
  const safeTopPx = getPositiveFiniteValue(groupBounds.topPx);
  const safeRightPx = getPositiveFiniteValue(groupBounds.rightPx);
  const safeBottomPx = getPositiveFiniteValue(groupBounds.bottomPx);
  const groupCenterX = ((safeLeftPx + safeRightPx) / 2) * scale;
  const groupCenterY = ((safeTopPx + safeBottomPx) / 2) * scale;

  return {
    scrollLeftPx: Math.max(0, groupCenterX - getPositiveFiniteValue(viewportWidthPx) / 2),
    scrollTopPx: Math.max(0, groupCenterY - getPositiveFiniteValue(viewportHeightPx) / 2),
  };
}

export function CanvasZoomControls({
  zoomPercent,
  onZoomChange,
  onFitToView,
  onResetZoom,
}: {
  zoomPercent: number;
  onZoomChange: (direction: "in" | "out") => void;
  onFitToView: () => void;
  onResetZoom?: () => void;
}) {
  const isZoomOutDisabled = zoomPercent <= MIN_CANVAS_ZOOM_PERCENT;
  const isZoomInDisabled = zoomPercent >= MAX_CANVAS_ZOOM_PERCENT;
  return (
    <div
      className="absolute bottom-4 right-4 z-30 flex items-center rounded-lg border bg-background/95 p-1 shadow-lg backdrop-blur"
      data-testid="canvas-zoom-controls"
    >
      <TooltipProvider delay={250}>
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom out"
              title="Zoom out"
              disabled={isZoomOutDisabled}
              onClick={() => onZoomChange("out")}
              data-testid="canvas-zoom-out"
            >
              <MinusIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom out</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Zoom percentage: ${zoomPercent}%`}
              title="Double-click to fit view"
              onDoubleClick={onFitToView}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onFitToView();
                }
              }}
              className="min-w-16 justify-center px-2 font-mono tabular-nums"
              data-testid="canvas-zoom-indicator"
            >
              {zoomPercent}%
            </Button>
          </TooltipTrigger>
          <TooltipContent>Double-click to fit view</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Reset zoom to ${DEFAULT_CANVAS_ZOOM_PERCENT}%`}
              title={`Reset zoom to ${DEFAULT_CANVAS_ZOOM_PERCENT}%`}
              onClick={onResetZoom}
              data-testid="canvas-zoom-reset"
            >
              <RotateCcwIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset zoom to {DEFAULT_CANVAS_ZOOM_PERCENT}%</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom in"
              title="Zoom in"
              disabled={isZoomInDisabled}
              onClick={() => onZoomChange("in")}
              data-testid="canvas-zoom-in"
            >
              <PlusIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom in</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
