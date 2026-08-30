/*
  Small deterministic color helpers for the brand-kit extraction pipeline:
  normalization of scraped CSS colors and luminance-aware mixing used by the
  contrast repair pass.
*/

/**
 * Parse "#rgb" / "#rrggbb" into [r, g, b] (0–255), or null. Leading "#" is
 * optional and surrounding whitespace is trimmed; anything else (named colors,
 * `rgb()`, `oklch()`) is null — callers that need those go through
 * {@link normalizeCssColor} first.
 *
 * THE ONLY hex parser in the app. src/lib/brand-kit.ts imports it rather than
 * keeping the second copy it used to have.
 */
export function parseHexColor(color: string): [number, number, number] | null {
  const hex = color.trim().replace(/^#/, "");
  const isShort = /^[0-9a-f]{3}$/i.test(hex);
  const isLong = /^[0-9a-f]{6}$/i.test(hex);
  if (!isShort && !isLong) {
    return null;
  }
  const full = isShort ? [...hex].map((c) => c + c).join("") : hex;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/*
  WCAG relative luminance (0–1) of a hex color, or null when unparseable.

  THE SINGLE SOURCE OF TRUTH for the WCAG formula. `getContrastRatio` in
  src/lib/brand-kit.ts is built on this, which puts all three contrast
  consumers — brand kit validation, the theme contrast repair pass, and the
  `low-contrast-edit` critique — on one implementation. It was duplicated
  once; changing the coefficients or the 0.03928 knee in a copy moved some
  consumers and silently left the rest behind, so there is deliberately no
  second copy to keep in sync.
*/
export function getRelativeLuminance(color: string): number | null {
  const rgb = parseHexColor(color);
  if (rgb === null) {
    return null;
  }
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function toHexByte(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, "0");
}

/*
  [r, g, b] → "#rrggbb".
*/
export function rgbToHex(rgb: [number, number, number]): string {
  return `#${toHexByte(rgb[0])}${toHexByte(rgb[1])}${toHexByte(rgb[2])}`;
}

/*
  hsl → rgb (h in degrees, s/l in 0–1). Standard CSS algorithm.
*/
function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - chroma / 2;
  const sextant = Math.floor(hue / 60);
  const [r, g, b] = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x],
  ][sextant] ?? [0, 0, 0];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/*
  Normalize a scraped CSS color token to lowercase "#rrggbb".
  Accepts #rgb, #rrggbb, rgb()/rgba() and hsl()/hsla() (comma or space
  syntax); an alpha < 0.5 is treated as noise (overlays/shadows) and
  rejected. Anything else (named colors, oklch, var()) returns null — the
  harvester only reports colors it can represent exactly.
*/
export function normalizeCssColor(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const hexRgb = parseHexColor(value);
  if (value.startsWith("#") && hexRgb !== null) {
    return rgbToHex(hexRgb);
  }
  const rgbMatch = value.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/,
  );
  if (rgbMatch !== null) {
    const [, r, g, b, alpha] = rgbMatch;
    if (alpha !== undefined && Number.parseFloat(alpha) < 0.5) {
      return null;
    }
    const channels = [r, g, b].map(Number) as [number, number, number];
    if (channels.some((channel) => channel > 255)) {
      return null;
    }
    return rgbToHex(channels);
  }
  const hslMatch = value.match(
    /^hsla?\(\s*([\d.]+)(?:deg)?\s*[,\s]\s*([\d.]+)%\s*[,\s]\s*([\d.]+)%\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/,
  );
  if (hslMatch !== null) {
    const [, h, s, l, alphaRaw] = hslMatch;
    if (alphaRaw !== undefined) {
      const alpha = alphaRaw.endsWith("%")
        ? Number.parseFloat(alphaRaw) / 100
        : Number.parseFloat(alphaRaw);
      if (alpha < 0.5) {
        return null;
      }
    }
    const saturation = Number.parseFloat(s) / 100;
    const lightness = Number.parseFloat(l) / 100;
    if (saturation > 1 || lightness > 1) {
      return null;
    }
    return rgbToHex(hslToRgb({ h: Number.parseFloat(h), s: saturation, l: lightness }));
  }
  return null;
}

/*
  Normalized chroma (0–1): max minus min RGB channel. High-chroma colors are
  vivid/saturated; grays are 0. Used by the harvester's vibrancy-aware
  ranking — brand accents are typically LOW-frequency HIGH-chroma colors.
*/
export function getChroma(color: string): number | null {
  const rgb = parseHexColor(color);
  return rgb === null ? null : (Math.max(...rgb) - Math.min(...rgb)) / 255;
}

/*
  Mix `base` toward `target` by `amount` (0 = base, 1 = target).
*/
export function mixHexColors({
  base,
  target,
  amount,
}: {
  base: string;
  target: string;
  amount: number;
}): string {
  const from = parseHexColor(base);
  const to = parseHexColor(target);
  if (from === null || to === null) {
    return base;
  }
  return rgbToHex([
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ]);
}

function getChannelSpread(color: string): number | null {
  const rgb = parseHexColor(color);
  return rgb === null ? null : Math.max(...rgb) - Math.min(...rgb);
}

/*
  Near-white GRAY noise (#fff, #fafafa…) — filtered from ranked candidates.
  Tinted lights (creams, pale brand washes) are kept: only low-saturation
  (small channel spread) colors count as noise.
*/
export function isNearWhite(color: string): boolean {
  const luminance = getRelativeLuminance(color);
  const spread = getChannelSpread(color);
  return luminance !== null && spread !== null && luminance > 0.92 && spread < 16;
}

/*
  Near-black GRAY noise (#000, #111…) — filtered from ranked candidates.
  Very dark BRAND colors (deep purples/navies) are kept via the spread check.
*/
export function isNearBlack(color: string): boolean {
  const luminance = getRelativeLuminance(color);
  const spread = getChannelSpread(color);
  return luminance !== null && spread !== null && luminance < 0.008 && spread < 16;
}
