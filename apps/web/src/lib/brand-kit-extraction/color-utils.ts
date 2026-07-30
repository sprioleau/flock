/**
 * Small deterministic color helpers for the brand-kit extraction pipeline:
 * normalization of scraped CSS colors and luminance-aware mixing used by the
 * contrast repair pass.
 */

/**
 * Parse "#rgb" / "#rrggbb" into [r, g, b] (0–255), or null.
 *
 * DUPLICATED from src/lib/brand-kit.ts (`parseHexColor` there is
 * module-private and that file is owned by the theme-panel workstream —
 * import-only for us). Keep the two byte-compatible.
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

/**
 * WCAG relative luminance (0–1) of a hex color, or null when unparseable.
 *
 * DUPLICATED from src/lib/brand-kit.ts (`getRelativeLuminance` there is
 * module-private). Same formula — keep in sync.
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

/** [r, g, b] → "#rrggbb". */
export function rgbToHex(rgb: [number, number, number]): string {
  return `#${toHexByte(rgb[0])}${toHexByte(rgb[1])}${toHexByte(rgb[2])}`;
}

/**
 * Normalize a scraped CSS color token to lowercase "#rrggbb".
 * Accepts #rgb, #rrggbb, rgb(r, g, b) and rgba(r, g, b, a); rgba with
 * alpha < 0.5 is treated as noise (overlays/shadows) and rejected.
 * Anything else (named colors, hsl, var()) returns null — the harvester
 * only reports colors it can represent exactly.
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
  if (rgbMatch === null) {
    return null;
  }
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

/** Mix `base` toward `target` by `amount` (0 = base, 1 = target). */
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

/**
 * Near-white GRAY noise (#fff, #fafafa…) — filtered from ranked candidates.
 * Tinted lights (creams, pale brand washes) are kept: only low-saturation
 * (small channel spread) colors count as noise.
 */
export function isNearWhite(color: string): boolean {
  const luminance = getRelativeLuminance(color);
  const spread = getChannelSpread(color);
  return luminance !== null && spread !== null && luminance > 0.92 && spread < 16;
}

/**
 * Near-black GRAY noise (#000, #111…) — filtered from ranked candidates.
 * Very dark BRAND colors (deep purples/navies) are kept via the spread check.
 */
export function isNearBlack(color: string): boolean {
  const luminance = getRelativeLuminance(color);
  const spread = getChannelSpread(color);
  return luminance !== null && spread !== null && luminance < 0.008 && spread < 16;
}
