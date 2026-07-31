"use client";

/**
 * The composer handoff seam: lets far-away surfaces (persona finding cards,
 * the recommendations modal) INSERT a ready-to-send prompt into the chat
 * composer — focused and editable, never auto-sent. The user stays in
 * charge: they read, tweak, and send (or don't).
 *
 * Shape: a module-level single-handler registry, not a store. ChatPanel — the
 * one owner of the composer's draft state — registers its handler on mount;
 * callers fire {@link handOffPromptToComposer} from anywhere in the tree
 * (the recommendations modal mounts OUTSIDE ChatPanel, so a callback prop
 * can't reach it; module scope is the same seam the suggestions tray's
 * collapsed-state store already uses). No DOM lookups, no custom events.
 */

type ComposerHandoffHandler = (prompt: string) => void;

let activeHandler: ComposerHandoffHandler | null = null;

/**
 * ChatPanel's registration (one composer per studio — last registration
 * wins, and unregistering only clears its own handler on unmount races).
 */
export function registerComposerHandoffHandler(handler: ComposerHandoffHandler): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) {
      activeHandler = null;
    }
  };
}

/**
 * Insert `prompt` into the chat composer (expanding/focusing it), replacing
 * the current draft. Returns whether a composer was mounted to receive it.
 */
export function handOffPromptToComposer(prompt: string): boolean {
  if (activeHandler === null) {
    return false;
  }
  activeHandler(prompt);
  return true;
}
