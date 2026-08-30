"use client";

import { useState } from "react";
import { HexColorPicker } from "react-colorful";
import { PipetteIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BrandColorSwatches } from "./BrandColorSwatches";
import { useLiveDraft } from "./useLiveDraft";

/*
  The color-picker popover behind every ColorField swatch (item 24, owner
  rework of the per-field swatch rows): saturation/brightness area + hue
  slider (react-colorful), an eyedropper (native EyeDropper API,
  feature-detected), hex + R/G/B inputs, and the brand-kit palette at the
  bottom.

  Commit semantics mirror the panel's live-draft philosophy exactly:
  `onPick` fires continuously (dragging the picker repaints the canvas in
  real time — never debounced) and `onGestureEnd` marks undo-gesture
  boundaries (pointer release, eyedropper pick, brand-swatch click, popover
  close), so one drag = one undo step via the store's coalescing.
*/

/*
  Native EyeDropper API (Chromium); feature-detected, hidden elsewhere.
*/
interface EyeDropperResult {
  sRGBHex: string;
}
type EyeDropperConstructor = new () => { open: () => Promise<EyeDropperResult> };

function getEyeDropperConstructor(): EyeDropperConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const candidate = (window as { EyeDropper?: EyeDropperConstructor }).EyeDropper;
  return candidate ?? null;
}

/*
  Parse #rrggbb / #rgb into channels; null otherwise.
*/
function hexToRgb(hex: string): [number, number, number] | null {
  const bare = hex.trim().replace(/^#/, "");
  const isShort = /^[0-9a-f]{3}$/i.test(bare);
  if (!isShort && !/^[0-9a-f]{6}$/i.test(bare)) {
    return null;
  }
  const full = isShort ? [...bare].map((digit) => digit + digit).join("") : bare;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export interface ColorPickerPopoverProps {
  /*
    The effective #rrggbb the swatch shows and the picker starts from.
  */
  color: string;
  ariaLabel: string;
  /*
    Live commit — called continuously while dragging (instant apply).
  */
  onPick: (color: string) => void;
  /*
    Undo-gesture boundary (the field's endCoalescing).
  */
  onGestureEnd: () => void;
}

export function ColorPickerPopover({ color, ariaLabel, onPick, onGestureEnd }: ColorPickerPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const eyeDropperConstructor = getEyeDropperConstructor();

  /*
    Hex text drafting: live-commits valid hex, resyncs on blur (same hook as
    the panel's fields, so mid-typing invalid text never fights the input).
  */
  const hexDraft = useLiveDraft<string>({
    value: color,
    onCommit: (next) => {
      const rgb = hexToRgb(next);
      if (rgb !== null) {
        onPick(rgbToHex(rgb));
      }
    },
    onGestureEnd,
  });

  const rgb = hexToRgb(color) ?? [0, 0, 0];

  const commitChannel = (channelIndex: 0 | 1 | 2, rawValue: string): void => {
    if (rawValue.trim() === "") {
      return; /* mid-edit emptiness — keep the last committed value */
    }
    const channel = Math.min(255, Math.max(0, Math.round(Number(rawValue))));
    if (Number.isNaN(channel)) {
      return;
    }
    const next: [number, number, number] = [...rgb];
    next[channelIndex] = channel;
    onPick(rgbToHex(next));
  };

  const pickWithEyeDropper = async (): Promise<void> => {
    if (eyeDropperConstructor === null) {
      return;
    }
    try {
      const result = await new eyeDropperConstructor().open();
      const rgbFromDropper = hexToRgb(result.sRGBHex);
      if (rgbFromDropper !== null) {
        onPick(rgbToHex(rgbFromDropper));
        onGestureEnd(); /* an eyedropper pick is one complete gesture */
      }
    } catch {
      /*
        User dismissed the eyedropper — nothing to commit.
      */
    }
  };

  return (
    <Popover
      open={isOpen}
      onOpenChange={(nextIsOpen) => {
        setIsOpen(nextIsOpen);
        if (!nextIsOpen) {
          onGestureEnd(); /* closing (outside click/Escape) ends the gesture */
        }
      }}
    >
      <PopoverTrigger
        aria-label={ariaLabel}
        title="Pick a color"
        className="size-8 shrink-0 cursor-pointer rounded-md border border-input focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        style={{ backgroundColor: color }}
        data-testid="color-picker-trigger"
      />
      <PopoverContent className="flex w-60 flex-col gap-2.5" data-testid="color-picker-popover">
        {/*
          Pointer release on the picker area = the drag gesture's end.
        */}
        <div onPointerUp={onGestureEnd} className="[&_.react-colorful]:h-44 [&_.react-colorful]:w-full">
          <HexColorPicker color={color} onChange={onPick} />
        </div>
        <div className="flex items-center gap-1.5">
          {eyeDropperConstructor !== null && (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Pick a color from the screen"
              title="Pick a color from the screen"
              onClick={() => void pickWithEyeDropper()}
              data-testid="color-picker-eyedropper"
            >
              <PipetteIcon />
            </Button>
          )}
          <Input
            value={hexDraft.draft}
            onChange={(event) => hexDraft.setDraft(event.target.value)}
            onFocus={hexDraft.handleFocus}
            onBlur={hexDraft.handleBlur}
            aria-label="Hex color"
            spellCheck={false}
            className="h-8 flex-1 font-mono text-xs"
            data-testid="color-picker-hex-input"
          />
        </div>
        <div className="flex items-center gap-1.5">
          {(["R", "G", "B"] as const).map((channelLabel, channelIndex) => (
            <label key={channelLabel} className="flex min-w-0 flex-1 items-center gap-1">
              <span className="text-[10px] font-medium text-muted-foreground">{channelLabel}</span>
              <Input
                type="number"
                min={0}
                max={255}
                value={rgb[channelIndex]}
                onChange={(event) => commitChannel(channelIndex as 0 | 1 | 2, event.target.value)}
                onBlur={onGestureEnd}
                aria-label={`${channelLabel === "R" ? "Red" : channelLabel === "G" ? "Green" : "Blue"} channel`}
                className="h-8 px-1.5 text-xs"
                data-testid={`color-picker-channel-${channelLabel.toLowerCase()}`}
              />
            </label>
          ))}
        </div>
        {/*
          The brand palette lives HERE now (owner rework) — not under every
          field. A pick is one complete gesture.
        */}
        <BrandColorSwatches
          onPick={(brandColor) => {
            onPick(brandColor);
            onGestureEnd();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
