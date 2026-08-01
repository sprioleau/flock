import {
  DEFAULT_GLOBAL_STYLES,
  ROOT_BLOCK_ID,
  type EmailDocument,
  type GlobalStyles,
} from "@flock/email-sdk";
import { getContrastRatio } from "@/lib/brand-kit";

/**
 * Derive a complete `applyTheme` globals payload from one user-picked accent
 * color (the re-theme rung of the escalation ladder).
 *
 * The derivation is deliberately conservative and honest: it starts from the
 * document's CURRENT effective globals (renderer defaults + root globals, so
 * a re-theme never silently reverts unrelated settings — `applyTheme`
 * replaces the globals object wholesale) and re-points only the accent
 * surfaces at the picked color:
 *
 * - buttons: fill + border take the accent; the label color is picked by
 *   WCAG contrast (white vs near-black, whichever reads better on the accent
 *   — same contrast math as the brand-kit theme selector).
 * - links: take the accent only when it stays AA-legible (≥ 4.5:1) on the
 *   content background; otherwise the current link color is kept.
 *
 * Fonts, heading/paragraph colors, and layout keys are untouched — a
 * re-theme recolors, it never reflows. Returns null when the accent is not
 * parseable hex (no re-theme rung is offered in that case).
 */

const LIGHT_LABEL_COLOR = "#ffffff";
const DARK_LABEL_COLOR = "#111111";
const MIN_LINK_CONTRAST_RATIO = 4.5;

export function deriveAccentTheme({
  doc,
  accentColor,
}: {
  doc: EmailDocument;
  accentColor: string;
}): GlobalStyles | null {
  const lightLabelRatio = getContrastRatio({
    foreground: LIGHT_LABEL_COLOR,
    background: accentColor,
  });
  const darkLabelRatio = getContrastRatio({
    foreground: DARK_LABEL_COLOR,
    background: accentColor,
  });
  if (lightLabelRatio === null || darkLabelRatio === null) {
    return null;
  }

  const rootBlock = doc[ROOT_BLOCK_ID];
  const currentGlobals = rootBlock?.type === "root" ? (rootBlock.properties.globals ?? {}) : {};
  // Drop undefined-valued keys so they can't shadow the renderer defaults.
  const definedGlobals = Object.fromEntries(
    Object.entries(currentGlobals).filter(([, value]) => value !== undefined),
  );
  const base: Required<GlobalStyles> = { ...DEFAULT_GLOBAL_STYLES, ...definedGlobals };

  const buttonTextColor =
    lightLabelRatio >= darkLabelRatio ? LIGHT_LABEL_COLOR : DARK_LABEL_COLOR;
  const linkRatio = getContrastRatio({
    foreground: accentColor,
    background: base.contentBackgroundColor,
  });
  const canLinkUseAccent = linkRatio !== null && linkRatio >= MIN_LINK_CONTRAST_RATIO;

  return {
    ...base,
    buttonBackgroundColor: accentColor,
    buttonBorderColor: accentColor,
    buttonTextColor,
    linkTextColor: canLinkUseAccent ? accentColor : base.linkTextColor,
  };
}
