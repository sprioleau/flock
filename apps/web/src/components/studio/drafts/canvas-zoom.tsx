"use client";

import { MinusIcon, PlusIcon } from "lucide-react";
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

export function CanvasZoomControls({
  zoomPercent,
  onZoomChange,
  onFitToView,
}: {
  zoomPercent: number;
  onZoomChange: (direction: "in" | "out") => void;
  onFitToView: () => void;
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
