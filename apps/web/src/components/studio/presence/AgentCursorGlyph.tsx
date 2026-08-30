/*
  The agent cursor glyph — the bird pointer the owner added as
  `components/ui/agent-cursor.svg`, inlined here for two reasons the loose
  asset cannot serve:

  1. the asset hardcodes `fill="black"`; a persona cursor has to take the
     persona's presence color, so the fill is a prop;
  2. the hover name chip has to be a real DOM sibling of the glyph (see
     pointer-presence.css) rather than the fixed-width chip baked into
     `agent-cursor-with-label.svg`.

  This is deliberately NOT PointerPresenceOverlay's PointerCursorArrow. That
  glyph is shared with HUMAN remote cursors and keeps its 15px arrow grammar
  (owner decision 2026-07-30) — only simulated agents get the bird.
*/

/*
  Rendered size. The human arrow is 15x15; agents render at 24x30 so it is
  obvious at a glance that something is working on the document. The
  beak/pointer portion alone comes out ~16x18, so the thing still reads as a
  cursor rather than as an icon parked on the canvas.
*/
const GLYPH_WIDTH_PX = 24;
const GLYPH_HEIGHT_PX = 30;

/*
  Same tip contract as the human arrow: the glyph's TIP sits at the element
  origin, exactly on the resolved point.

  The supplied artwork floats inside a 185x212 canvas — the beak's tip vertex
  is at (40.75, 32.26) and, with the authored 5.687 miter stroke, its outer
  point lands at ~(36.68, 26.65). This viewBox is re-based on that outer
  point and cropped to the artwork's stroked bounds, so viewBox-min IS the
  tip. `preserveAspectRatio="xMinYMin meet"` then pins viewBox-min to the
  element's top-left corner, which keeps the tip on the point even when the
  width/height box does not divide exactly into the viewBox's aspect.
*/
const GLYPH_VIEW_BOX = "36.68 26.65 147.49 184.99";

/*
  The head/body, with the eye punched out as a reverse-wound subpath.
*/
const GLYPH_BODY_PATH =
  "M122.293 101.463C140.37 101.463 155.393 114.521 158.173 131.665L174.505 143.7L178.587 146.708L173.732 148.172L159.688 152.408L158.635 206.617L158.586 209.105H70.9131L71.5107 206.076L85.8564 133.394C88.5173 115.626 103.522 101.463 122.293 101.463ZM131.951 120.85C127.989 120.85 124.83 124.014 124.83 127.853C124.83 131.691 127.989 134.856 131.951 134.856C135.913 134.856 139.072 131.691 139.072 127.853C139.072 124.014 135.913 120.85 131.951 120.85Z";

/*
  The beak — the arrowhead that carries the cursor tip. Drawn last, on top.
*/
const GLYPH_BEAK_PATH =
  "M125.579 80.875L84.4076 93.5393C83.1327 93.9315 82.0367 94.76 81.3104 95.8788L60.7049 127.62L40.7521 32.2597L125.579 80.875Z";

export function AgentCursorGlyph({ color }: { color: string }) {
  return (
    <svg
      className="flock-persona-cursor__glyph"
      width={GLYPH_WIDTH_PX}
      height={GLYPH_HEIGHT_PX}
      viewBox={GLYPH_VIEW_BOX}
      preserveAspectRatio="xMinYMin meet"
      fill="none"
    >
      <path d={GLYPH_BODY_PATH} fill={color} stroke="white" strokeWidth="5.07486" />
      <path d={GLYPH_BEAK_PATH} fill={color} stroke="white" strokeWidth="5.687" />
    </svg>
  );
}
