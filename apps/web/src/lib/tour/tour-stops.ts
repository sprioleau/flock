import type { UiPanel } from "@flock/email-sdk";

/*
  The studio walkthrough's content and shape — the whole of WHAT the tour says
  and in what order, with no DOM and no React anywhere in this file.

  vitest.config.ts pins `environment: "node"` for all of src/**, so anything
  that touches an element cannot be unit-tested here. Everything decided in
  this module — which stops exist, what they say, what each one points at, what
  has to be true before it can point at it, and how they order — is therefore
  data, and StudioTour.tsx is a render over that data.

  THE DESIGN, and the reason it is this and not a conventional tour (owner
  decision, do not redesign):

    Each stop anchors its card to the CLOSED TRIGGER for a surface — the brand
    kit icon in the toolbar, the library icon, the agents icon — points an
    arrow at it, says what is behind it, and stops there. It never walks the
    user INTO the surface.

  That is not a stylistic preference, it is what makes the tour work at all.
  Four of the surfaces this tour is about (brand kit, library, the persona
  picker, the recommendations dialog) are Base UI `Dialog`s, and @base-ui/react
  defaults `modal` to `true` — "focus is trapped, document page scroll is
  locked, and pointer interactions on outside elements are disabled"
  (node_modules/@base-ui/react/dialog/root/DialogRoot.d.ts). A tour card lives
  in a body-level portal, which is an outside element by construction, so a
  card rendered while one of those dialogs is open has unclickable buttons.
  Anchoring to the closed trigger means the tour is NEVER interactive inside a
  modal, so `modal: true` never traps anything and not one dialog in this app
  is weakened for onboarding's benefit.

  The corollary, and the rule every stop below follows: an anchor is a TOOLBAR
  TRIGGER, which is mounted for the entire life of the studio. The single
  exception is the chat stop — see `prepare`.
*/

/*
  Stable ids, as a union rather than `string`, so the ordering helpers, the
  persisted resume point, and the component's switch are all checked by the
  compiler. Renaming one is a breaking change for anyone mid-tour; the parser
  in tour-progress.ts handles that by resuming them at the start rather than
  crashing.
*/
export type TourStopId = "chat" | "brand-kit" | "library" | "agents" | "comments";

/*
  A named thing the app must DO before a stop's anchor is worth pointing at.

  Declarative on purpose: the intent is data here (node-testable), and
  tour-intents.ts is the only place that knows how to perform it. This is the
  same discipline requestUiSurfaceOpen already establishes — a tour step names
  an intent the app supports; it never synthesizes a DOM click on a trigger it
  had to go and find first.
*/
export type TourStopPreparation = "expand-chat-panel";

/*
  A preview of what opens behind the trigger.

  NOT BUILT YET, and deliberately so: the images the owner's design calls for
  need somewhere to live, and that is a convex/schema.ts change owned by
  another workstream right now. The field exists so the step contract does not
  have to change when they land — a stop grows a `preview`, TourCard's existing
  `stop.preview !== undefined` branch renders it, and nothing else moves. Until
  then every stop below omits it and the cards are arrow-and-copy, which §3.2
  of the proposal recommends shipping first anyway.

  `alt` is required rather than optional because a preview is never decorative:
  it is the card's answer to "what is behind this icon", and a screen-reader
  user is owed that answer in words.
*/
export interface TourStopPreview {
  src: string;
  alt: string;
}

export interface TourStop {
  id: TourStopId;
  /* The card's heading. A promise in the user's terms, not a feature name. */
  title: string;
  /* Two sentences at most — what is behind the trigger, and why to care. */
  body: string;
  /*
    The element the card anchors to and the arrow points at, addressed by its
    existing `data-testid`. Every one of these is a toolbar control that is
    already in the DOM for the tour's benefit-free reasons, so nothing is
    marked up for onboarding's sake.
  */
  anchorTestId: string;
  /* Which side of the anchor the card sits on (Floating UI flips on collision). */
  side: "top" | "bottom" | "left" | "right";
  align: "start" | "center" | "end";
  /*
    The surface behind the trigger, when the app can open it by name
    (requestUiSurfaceOpen). Present => the card offers "Open it", which opens
    the real surface and ENDS the tour there.

    Ending rather than advancing is the point: the moment that surface opens it
    is a focus-trapping modal, and a tour card still on screen would be exactly
    the unclickable-Next-button failure this whole design exists to avoid. So
    the affordance is an EXIT — the user asked to stop being told about the
    thing and to go use it, and that is a completed tour, not an abandoned one.

    Absent => there is no such affordance, because there is no named surface to
    open: the chat panel is a layout region, and comments mode is a mode.
  */
  surface?: UiPanel;
  /* See TourStopPreparation. Absent for a stop whose anchor is always ready. */
  prepare?: TourStopPreparation;
  /* See TourStopPreview. Absent on every stop today. */
  preview?: TourStopPreview;
}

/*
  The five stops, in the order they run.

  ORDERING RATIONALE. Chat leads, and the four surfaces follow in the order a
  person actually uses them: make it yours (brand, then your own images), then
  get it reviewed (an agent, then your own comments). Leading with the chrome
  instead would be a tour of the toolbar; leading with chat makes the first
  beat the thing the product IS.

  It also settles the "does this compete with the starter document" question in
  the tour's favour. A new draft opens on a Welcome email whose "Three moves to
  make it yours" section reads set the theme -> drop in a section -> send
  yourself a test, and lib/prompt-starters.ts deliberately follows that same
  spine. Notice that NOT ONE of the five stops below is one of those three
  moves. They cannot compete because they answer a different question: the
  canvas and the chips teach WHAT TO MAKE, and this tour teaches WHERE THE
  DOORS ARE — the five things §0 of the proposal says a first-time visitor
  cannot discover on their own. The chat stop is where they meet: it points at
  the composer and names the starter chips sitting right above it, which hands
  the user straight into the starter document's three moves rather than
  proposing a fourth story.
*/
export const TOUR_STOPS: readonly TourStop[] = [
  {
    /*
      The core loop, and the only stop that teaches a behaviour rather than a
      location. Anchored to the composer and pointing right, so the card sits
      over the canvas and leaves the chips it is talking about visible.
    */
    id: "chat",
    title: "Ask for it, watch it land",
    body: "Describe a change in plain language and the agent edits the draft on the canvas. The chips above the box are ready-made prompts — pick one, edit it, send it.",
    anchorTestId: "chat-composer",
    side: "right",
    align: "end",
    /*
      THE ONE STOP WHOSE ANCHOR IS NOT ALREADY THERE, and the single most
      likely way this whole feature breaks. panel-preferences.ts defaults
      `isChatPanelExpanded: false` — an owner decision, not an oversight — so
      on a first visit the chat panel is a 48px rail. The composer is
      technically still mounted (the panel cross-fades rather than unmounting),
      which is worse than it being absent: querying for it SUCCEEDS and returns
      an element clipped to a hidden 48px column, and a card anchored to that
      is pinned to nothing in the user's eyes while every selector-based check
      reports success. Expanding first is what makes the anchor mean what it
      looks like it means.
    */
    prepare: "expand-chat-panel",
  },
  {
    id: "brand-kit",
    title: "Bring in your brand",
    body: "Paste your website address here and Flock reads your colors, fonts and logo straight off it, then turns them into a theme any draft can wear.",
    anchorTestId: "brand-kit-open-button",
    side: "bottom",
    align: "start",
    surface: "brand-kit",
  },
  {
    id: "library",
    title: "Keep your own images here",
    body: "Upload or import an image once and drop it into any draft from here. Renaming and deleting live in the same place.",
    anchorTestId: "library-open-button",
    side: "bottom",
    align: "start",
    surface: "library",
  },
  {
    id: "agents",
    title: "Put a reviewer on the draft",
    body: "Switch on an agent and it reads every edit you make, then leaves findings in the chat panel. They only ever advise — nothing changes until you apply it.",
    anchorTestId: "agent-collaborators-button",
    side: "bottom",
    align: "end",
    surface: "agents",
  },
  {
    /*
      No `surface`: comments is a MODE on the canvas, not a panel the openPanel
      command knows about, so there is nothing for "Open it" to open. Nor does
      this stop arm the mode itself — doing that would turn the canvas cursor
      into a crosshair and make the next click drop a pin, behind a card that
      never warned the user it had changed what clicking does.
    */
    id: "comments",
    title: "Comment, then hand it over",
    body: "Turn this on and click anywhere on the email to leave a comment. The panel beside it collects them, and an agent can go and fix what you flagged.",
    anchorTestId: "comments-mode-toggle",
    side: "bottom",
    align: "end",
  },
];

/*
  Where a tour with no stored progress begins. Written out rather than read off
  TOUR_STOPS[0] so that reordering the array is a deliberate two-line edit and
  the test below notices a one-line one.
*/
export const FIRST_TOUR_STOP_ID: TourStopId = "chat";

/** How many stops there are — the "2 of 5" denominator on every card. */
export const TOUR_STOP_COUNT = TOUR_STOPS.length;

/** Narrow an unknown (a parsed localStorage value) to a live stop id. */
export function isTourStopId(value: unknown): value is TourStopId {
  return TOUR_STOPS.some((stop) => stop.id === value);
}

/** The stop with this id, or undefined for `null` and for retired ids. */
export function findTourStop(stopId: TourStopId | null): TourStop | undefined {
  if (stopId === null) {
    return undefined;
  }
  return TOUR_STOPS.find((stop) => stop.id === stopId);
}

/** The stop's 1-based position, for "3 of 5". Zero for an id that is not here. */
export function getTourStopNumber(stopId: TourStopId): number {
  return TOUR_STOPS.findIndex((stop) => stop.id === stopId) + 1;
}

/** The next stop, or `null` at the last one — which means the tour is done. */
export function getNextTourStopId(stopId: TourStopId): TourStopId | null {
  const index = TOUR_STOPS.findIndex((stop) => stop.id === stopId);
  if (index === -1) {
    return null;
  }
  return TOUR_STOPS[index + 1]?.id ?? null;
}

/** The previous stop, or `null` at the first one — which hides "Back". */
export function getPreviousTourStopId(stopId: TourStopId): TourStopId | null {
  const index = TOUR_STOPS.findIndex((stop) => stop.id === stopId);
  if (index <= 0) {
    return null;
  }
  return TOUR_STOPS[index - 1]?.id ?? null;
}
