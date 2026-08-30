"use client";

/*
  The time-travel replay handoff seam — the composer-handoff.ts shape, for the
  one other surface that needs to reach a panel it does not own.

  Why it exists: the replay drawer's only entry point is its own toolbar
  button, which is right where a returning user looks for it and nowhere near
  where a first-time visitor is looking. The /demo narration's closing beat is
  "rewind the last two minutes and watch it happen again" — pointing at an icon
  in the header and hoping is not that beat, and a second replay panel to own
  the demo's copy of it would be a second thing to keep correct.

  Shape: a module-level single-handler registry, not a store. ReplayPanel
  registers on mount (it is a toolbar child; the demo panel is mounted over the
  canvas, so a callback prop cannot reach it), callers fire from anywhere, and
  a caller with no panel mounted gets `false` rather than a thrown error — the
  panel only mounts when the time-travel setting is on, which the demo preset
  turns on but a normal studio does not.
*/

let openReplayPanel: (() => void) | null = null;

/*
  ReplayPanel's registration (one replay drawer per studio).
*/
export function registerReplayPanelOpener(open: () => void): () => void {
  openReplayPanel = open;
  return () => {
    if (openReplayPanel === open) {
      openReplayPanel = null;
    }
  };
}

/*
  Open the time-travel replay drawer. Returns whether a panel was mounted to
  receive it, so a caller can hide its own affordance rather than offering a
  button that does nothing.
*/
export function openTimeTravelReplay(): boolean {
  if (openReplayPanel === null) {
    return false;
  }
  openReplayPanel();
  return true;
}
