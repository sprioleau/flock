/**
 * Property key → human phrase, shared by every op-log surface. Extracted from
 * op-author.ts (still the single source of truth for full op labels) so the
 * pure value-transition helper can reuse the exact same phrases without
 * pulling in the presence/identity imports op-author needs.
 */

/**
 * Property key → human phrase for "Updated {phrase} · {Block type}" labels.
 * Anything unmapped falls back to the camelCase splitter below, so an
 * internal-looking key can never leak verbatim.
 */
export const PROPERTY_PHRASES: Record<string, string> = {
  backgroundColor: "background color",
  color: "text color",
  textColor: "text color",
  borderColor: "border color",
  borderRadius: "corner radius",
  borderSize: "border size",
  borderWidth: "border width",
  borderStyle: "border style",
  paddingTop: "padding",
  paddingBottom: "padding",
  paddingLeft: "padding",
  paddingRight: "padding",
  horizontalPadding: "padding",
  verticalPadding: "padding",
  innerBackgroundColor: "inner background",
  outerBackgroundColor: "outer background",
  emailBackgroundColor: "email background",
  contentBackgroundColor: "content background",
  href: "link",
  src: "image source",
  alt: "alt text",
  label: "label",
  align: "alignment",
  textAlign: "text alignment",
  verticalAlign: "vertical alignment",
  fontFamily: "font",
  width: "width",
  widthPercent: "width",
  contentWidth: "content width",
  thickness: "thickness",
  linkTextColor: "link color",
  dividerColor: "divider color",
  baseSpacing: "spacing",
  buttonBackgroundColor: "button background",
  buttonTextColor: "button text color",
  buttonBorderColor: "button border color",
  buttonBorderRadius: "button corner radius",
  buttonBorderSize: "button border size",
  buttonHorizontalPadding: "button padding",
  buttonVerticalPadding: "button padding",
  buttonFontFamily: "button font",
  imageBorderRadius: "image corner radius",
};

/** "borderRadius" → "corner radius"; unmapped keys → "heading 1 text align". */
export function humanizePropertyKey(key: string): string {
  return (
    PROPERTY_PHRASES[key] ??
    key
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Za-z])(\d)/g, "$1 $2")
      .toLowerCase()
  );
}
