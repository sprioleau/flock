"use client";

/**
 * The composer handoff seam: lets far-away surfaces reach the chat composer
 * without a second chat pipeline. Four modes, one registry:
 *
 * - INSERT ({@link handOffPromptToComposer}): persona finding cards and the
 *   recommendations modal insert a ready-to-send prompt — focused and
 *   editable, never auto-sent. The user stays in charge.
 * - SEND ({@link sendPromptThroughComposer}): the slash-summon quick prompt
 *   submits its text as a NORMAL chat message through the panel's own send
 *   path (queueing behind a busy agent exactly like a composer submit); the
 *   panel expands so the user sees their prompt land in the thread.
 * - FOCUS ({@link focusChatComposer}): the focus-chat shortcut expands the
 *   panel and puts the caret in the composer, leaving the draft untouched.
 * - SEND + SETTLEMENT ({@link sendPromptForSettledTurn}): comments-mode fix
 *   dispatch sends like SEND and additionally hears back when the turn (and
 *   anything queued behind it) settles, to append the "agent responded"
 *   thread entry.
 *
 * Shape: a module-level single-handler registry, not a store. ChatPanel — the
 * one owner of the composer's draft state and send machinery — registers its
 * handlers on mount; callers fire from anywhere in the tree (the
 * recommendations modal and the shortcut layer mount OUTSIDE ChatPanel, so a
 * callback prop can't reach them; module scope is the same seam the
 * suggestions tray's collapsed-state store already uses). No DOM lookups, no
 * custom events.
 */

export interface ComposerHandoffHandlers {
  /*
    Replace the draft with `prompt`, expand, and focus — never auto-send.
  */
  insertPrompt: (prompt: string) => void;
  /*
    Submit `prompt` through the composer's send path (queues while busy).
  */
  sendPrompt: (prompt: string) => void;
  /*
    Expand the panel and focus the composer, keeping the current draft.
  */
  focusComposer: () => void;
  /*
    SEND + SETTLEMENT (comments-mode fix dispatch): submit `prompt` exactly
    like sendPrompt, then invoke `onTurnSettled` once the agent NEXT returns
    to full idle (turn finished, queue drained, no pending approval). An
    error-paused turn does NOT settle — the callback is dropped, so nothing
    downstream records a response that never happened.
  */
  sendPromptWithSettlement: (input: { prompt: string; onTurnSettled: () => void }) => void;
}

let activeHandlers: ComposerHandoffHandlers | null = null;

/*
  ChatPanel's registration (one composer per studio — last registration
  wins, and unregistering only clears its own handlers on unmount races).
*/
export function registerComposerHandoffHandlers(handlers: ComposerHandoffHandlers): () => void {
  activeHandlers = handlers;
  return () => {
    if (activeHandlers === handlers) {
      activeHandlers = null;
    }
  };
}

/*
  Insert `prompt` into the chat composer (expanding/focusing it), replacing
  the current draft. Returns whether a composer was mounted to receive it.
*/
export function handOffPromptToComposer(prompt: string): boolean {
  if (activeHandlers === null) {
    return false;
  }
  activeHandlers.insertPrompt(prompt);
  return true;
}

/*
  Send `prompt` as a normal chat message via the composer's own send path
  (the panel expands so the message is seen landing in the thread). Returns
  whether a composer was mounted to receive it.
*/
export function sendPromptThroughComposer(prompt: string): boolean {
  if (activeHandlers === null) {
    return false;
  }
  activeHandlers.sendPrompt(prompt);
  return true;
}

/*
  Expand the chat panel and focus the composer (draft preserved).
*/
export function focusChatComposer(): boolean {
  if (activeHandlers === null) {
    return false;
  }
  activeHandlers.focusComposer();
  return true;
}

/*
  Send `prompt` as a normal chat message AND get `onTurnSettled` back once
  the agent next reaches full idle (see the handler doc). Comments-mode fix
  dispatch uses this to append the "agent responded" thread entry after the
  fix turn ran. Returns whether a composer was mounted to receive it.
*/
export function sendPromptForSettledTurn(input: {
  prompt: string;
  onTurnSettled: () => void;
}): boolean {
  if (activeHandlers === null) {
    return false;
  }
  activeHandlers.sendPromptWithSettlement(input);
  return true;
}
