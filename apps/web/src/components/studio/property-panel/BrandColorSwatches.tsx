"use client";

import { useBrandColorPalette } from "../brand-kit/useBrandColorPalette";

/**
 * The "Brand colors" swatch row under every color picker (owner ask, item
 * 23): the ACTIVE brand kit's distinct palette as clickable chips. Clicking
 * hands the color to the host field's normal commit path via `onPick` —
 * this component never dispatches anything itself, so instant apply and
 * undo coalescing behave exactly like typing the hex would.
 *
 * Renders nothing when the session has no saved kit. Colors are inline
 * styles by necessity (they ARE the data); everything else uses semantic
 * tokens so the row reads correctly in dark mode.
 */
export function BrandColorSwatches({ onPick }: { onPick: (color: string) => void }) {
  const palette = useBrandColorPalette();
  if (palette.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1" data-testid="brand-color-swatches">
      <span className="text-[10px] font-medium text-muted-foreground">Brand colors</span>
      <div className="flex flex-wrap items-center gap-1">
        {palette.map(({ color, label }) => (
          <button
            key={color}
            type="button"
            title={`${label} (${color})`}
            aria-label={`Apply brand color: ${label}`}
            className="size-5 shrink-0 cursor-pointer rounded border border-input transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            style={{ backgroundColor: color }}
            onClick={() => onPick(color)}
            data-testid={`brand-color-swatch-${color.slice(1)}`}
          />
        ))}
      </div>
    </div>
  );
}
