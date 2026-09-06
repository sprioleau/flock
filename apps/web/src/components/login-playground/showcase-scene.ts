export type ShowcaseAgentId = "iris" | "mica" | "sable";
export type ShowcaseBeatKind = "inspect" | "select" | "edit" | "propose";
export type ShowcaseTarget = "headline" | "supporting-copy" | "cta";

export interface ShowcaseAgent {
  id: ShowcaseAgentId;
  name: string;
  role: string;
  color: string;
  glyph: string;
  initialWaypoint: { xPercent: number; yPercent: number };
}

export interface ShowcaseBeat {
  actorId: ShowcaseAgentId;
  kind: ShowcaseBeatKind;
  target: ShowcaseTarget;
  waypoint: { xPercent: number; yPercent: number };
  activity: string;
  durationMs: number;
  emailPatch?: Partial<ShowcaseEmail>;
}

export interface ShowcaseEmail {
  headline: string;
  supportingCopy: string;
  cta: string;
}

export interface ShowcaseCursorState extends ShowcaseAgent {
  waypoint: { xPercent: number; yPercent: number };
  status: string;
  isActive: boolean;
}

export interface ShowcaseSceneState {
  activeBeatIndex: number;
  activeBeat: ShowcaseBeat;
  email: ShowcaseEmail;
  cursors: ShowcaseCursorState[];
  completedActivities: string[];
  selectedTarget: ShowcaseTarget | null;
}

export const SHOWCASE_AGENTS: readonly ShowcaseAgent[] = [
  {
    id: "iris",
    name: "Iris",
    role: "Clarity agent",
    color: "#5643c9",
    glyph: "I",
    initialWaypoint: { xPercent: 82, yPercent: 18 },
  },
  {
    id: "mica",
    name: "Mica",
    role: "Voice agent",
    color: "#a82862",
    glyph: "M",
    initialWaypoint: { xPercent: 86, yPercent: 48 },
  },
  {
    id: "sable",
    name: "Sable",
    role: "Conversion agent",
    color: "#087064",
    glyph: "S",
    initialWaypoint: { xPercent: 80, yPercent: 78 },
  },
] as const;

export const SHOWCASE_BEATS: readonly ShowcaseBeat[] = [
  {
    actorId: "iris",
    kind: "inspect",
    target: "headline",
    waypoint: { xPercent: 40, yPercent: 30 },
    activity: "Iris is checking whether the headline names a clear benefit.",
    durationMs: 2_000,
  },
  {
    actorId: "iris",
    kind: "select",
    target: "headline",
    waypoint: { xPercent: 48, yPercent: 35 },
    activity: "Iris selected the headline and prepared a clearer version.",
    durationMs: 1_600,
  },
  {
    actorId: "iris",
    kind: "edit",
    target: "headline",
    waypoint: { xPercent: 58, yPercent: 31 },
    activity: "Iris changed the headline to name the faster outcome.",
    durationMs: 2_800,
    emailPatch: { headline: "Meet the faster way to ship email" },
  },
  {
    actorId: "mica",
    kind: "inspect",
    target: "supporting-copy",
    waypoint: { xPercent: 58, yPercent: 52 },
    activity: "Mica is checking that the supporting copy sounds like the team.",
    durationMs: 1_800,
  },
  {
    actorId: "mica",
    kind: "propose",
    target: "supporting-copy",
    waypoint: { xPercent: 66, yPercent: 55 },
    activity: "Mica proposed copy that makes human and agent teamwork explicit.",
    durationMs: 2_800,
    emailPatch: {
      supportingCopy:
        "Shape the message together while your agents refine clarity, voice, and conversion in real time.",
    },
  },
  {
    actorId: "sable",
    kind: "inspect",
    target: "cta",
    waypoint: { xPercent: 45, yPercent: 72 },
    activity: "Sable is checking whether the call to action sets a clear expectation.",
    durationMs: 1_800,
  },
  {
    actorId: "sable",
    kind: "select",
    target: "cta",
    waypoint: { xPercent: 55, yPercent: 74 },
    activity: "Sable selected the call to action and compared two alternatives.",
    durationMs: 1_600,
  },
  {
    actorId: "sable",
    kind: "edit",
    target: "cta",
    waypoint: { xPercent: 64, yPercent: 72 },
    activity: "Sable changed the call to action to describe what opens next.",
    durationMs: 3_200,
    emailPatch: { cta: "See what changed" },
  },
] as const;

const INITIAL_EMAIL: ShowcaseEmail = {
  headline: "A launch update worth opening",
  supportingCopy:
    "A quick look at the new way your team can build, review, and improve every campaign together.",
  cta: "Read the update",
};

function normalizeBeatIndex(beatIndex: number): number {
  if (!Number.isFinite(beatIndex)) {
    return 0;
  }
  const integerIndex = Math.floor(beatIndex);
  return ((integerIndex % SHOWCASE_BEATS.length) + SHOWCASE_BEATS.length) % SHOWCASE_BEATS.length;
}

export function getShowcaseSceneState({
  beatIndex,
  isReducedMotion,
}: {
  beatIndex: number;
  isReducedMotion: boolean;
}): ShowcaseSceneState {
  const activeBeatIndex = isReducedMotion
    ? SHOWCASE_BEATS.length - 1
    : normalizeBeatIndex(beatIndex);
  const completedBeats = SHOWCASE_BEATS.slice(0, activeBeatIndex + 1);
  const email = completedBeats.reduce<ShowcaseEmail>(
    (currentEmail, beat) => ({ ...currentEmail, ...beat.emailPatch }),
    INITIAL_EMAIL,
  );
  const activeBeat = SHOWCASE_BEATS[activeBeatIndex]!;
  const cursors = SHOWCASE_AGENTS.map((agent) => {
    const latestBeat = completedBeats.findLast((beat) => beat.actorId === agent.id);
    return {
      ...agent,
      waypoint: latestBeat?.waypoint ?? agent.initialWaypoint,
      status: latestBeat?.activity ?? `${agent.name} is ready to collaborate.`,
      isActive: activeBeat.actorId === agent.id,
    };
  });

  return {
    activeBeatIndex,
    activeBeat,
    email,
    cursors,
    completedActivities: completedBeats.map((beat) => beat.activity),
    selectedTarget:
      activeBeat.kind === "select" || activeBeat.kind === "edit" || activeBeat.kind === "propose"
        ? activeBeat.target
        : null,
  };
}
