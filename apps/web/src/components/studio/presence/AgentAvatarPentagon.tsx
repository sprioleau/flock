/*
  The AGENT avatar shape (owner spec 2026-07-31): non-human collaborators —
  advisory personas and the chat agent — render as a point-up, slightly
  rounded PENTAGON in the presence facepile, while humans keep the circle,
  so concurrent agent vs human collaborators are instantly distinguishable.

  Drawn as a real SVG (owner: no clip-path hacks): a back pentagon filled
  with the page background plays the role of the circles' `ring-2
  ring-background` separator in the overlapping stack, and the front
  pentagon carries the member's presence color. Corners are rounded with
  quadratic curves so the shape doesn't read spiky at facepile size (~24px).
*/

interface PolygonPoint {
  x: number;
  y: number;
}

/*
  `distance` along the segment from `from` toward `toward`.
*/
function movePointToward({
  from,
  toward,
  distance,
}: {
  from: PolygonPoint;
  toward: PolygonPoint;
  distance: number;
}): PolygonPoint {
  const deltaX = toward.x - from.x;
  const deltaY = toward.y - from.y;
  const length = Math.hypot(deltaX, deltaY);
  return {
    x: from.x + (deltaX / length) * distance,
    y: from.y + (deltaY / length) * distance,
  };
}

const formatCoordinate = (value: number): string => value.toFixed(2);

/*
  SVG path for a point-up regular pentagon with rounded corners: each vertex
  is trimmed by `cornerTrim` along both edges and bridged with a quadratic
  curve through the vertex.
*/
export function buildRoundedPentagonPath({
  centerX,
  centerY,
  radius,
  cornerTrim,
}: {
  centerX: number;
  centerY: number;
  radius: number;
  cornerTrim: number;
}): string {
  const vertices: PolygonPoint[] = Array.from({ length: 5 }, (_, index) => {
    const angleRadians = ((-90 + index * 72) * Math.PI) / 180;
    return {
      x: centerX + radius * Math.cos(angleRadians),
      y: centerY + radius * Math.sin(angleRadians),
    };
  });
  const segments = vertices.map((vertex, index) => {
    const previous = vertices[(index + vertices.length - 1) % vertices.length] as PolygonPoint;
    const next = vertices[(index + 1) % vertices.length] as PolygonPoint;
    const arcStart = movePointToward({ from: vertex, toward: previous, distance: cornerTrim });
    const arcEnd = movePointToward({ from: vertex, toward: next, distance: cornerTrim });
    const moveOrLine = index === 0 ? "M" : "L";
    return (
      `${moveOrLine} ${formatCoordinate(arcStart.x)} ${formatCoordinate(arcStart.y)} ` +
      `Q ${formatCoordinate(vertex.x)} ${formatCoordinate(vertex.y)} ` +
      `${formatCoordinate(arcEnd.x)} ${formatCoordinate(arcEnd.y)}`
    );
  });
  return `${segments.join(" ")} Z`;
}

/*
  Geometry, in a 28×28 viewBox rendered at `-inset-0.5` over the 24px avatar
  box — the extra 2px on every side is where the background-colored ring
  pentagon lives, exactly like the circles' ring-2 overhang. The center sits
  a hair below geometric center so the point-up shape looks optically
  balanced, and the ring radius offsets the front pentagon's EDGES by ~2px
  (circumradius scaled by (inradius + 2) / inradius).
*/
const PENTAGON_CENTER_X = 14;
const PENTAGON_CENTER_Y = 14.6;
const FRONT_PENTAGON_RADIUS = 12.2;
const RING_EDGE_OFFSET = 2;
const FRONT_PENTAGON_INRADIUS = FRONT_PENTAGON_RADIUS * Math.cos(Math.PI / 5);
const RING_PENTAGON_RADIUS =
  (FRONT_PENTAGON_RADIUS * (FRONT_PENTAGON_INRADIUS + RING_EDGE_OFFSET)) /
  FRONT_PENTAGON_INRADIUS;

const FRONT_PENTAGON_PATH = buildRoundedPentagonPath({
  centerX: PENTAGON_CENTER_X,
  centerY: PENTAGON_CENTER_Y,
  radius: FRONT_PENTAGON_RADIUS,
  cornerTrim: 3,
});

const RING_PENTAGON_PATH = buildRoundedPentagonPath({
  centerX: PENTAGON_CENTER_X,
  centerY: PENTAGON_CENTER_Y,
  radius: RING_PENTAGON_RADIUS,
  cornerTrim: 3.6,
});

/*
  The pentagon badge itself — absolutely positioned to overflow its 24px
  (`size-6`) relative parent by 2px on each side. Render it as the FIRST
  child so the glyph/status-dot siblings paint on top.
*/
export function AgentAvatarPentagon({ color }: { color: string }) {
  return (
    <svg
      viewBox="0 0 28 28"
      className="absolute -inset-0.5 size-7"
      aria-hidden
      data-testid="agent-avatar-pentagon"
    >
      <path d={RING_PENTAGON_PATH} className="fill-background" />
      <path d={FRONT_PENTAGON_PATH} fill={color} />
    </svg>
  );
}
