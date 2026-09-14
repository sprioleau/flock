const HEX_COLOR_PATTERN = /#[0-9a-fA-F]{6}(?![0-9a-zA-Z])/g;

export function sanitizeGuidanceColors({
  markdown,
  allowedHexes,
}: {
  markdown: string;
  allowedHexes: readonly string[];
}): string {
  const allowed = new Set(allowedHexes.map((hex) => hex.toLowerCase()));
  return markdown.replace(HEX_COLOR_PATTERN, (hex) => {
    const normalized = hex.toLowerCase();
    return allowed.has(normalized) ? normalized : "a saved brand color";
  });
}
