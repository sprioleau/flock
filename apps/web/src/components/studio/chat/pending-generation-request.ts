"use client";

import type { GenerationRequestDataPart } from "@/lib/chat-contract";

/**
 * The machine-readable half of a drafts-menu AI send, held for exactly one
 * message.
 *
 * WHY A STASH AND NOT A PARAMETER. The send travels DraftSelector →
 * composer-handoff SEND → ChatPanel's submit → (possibly the per-document
 * message queue) → useFlockChat. Every hop in that chain is typed `(text:
 * string)`, and widening all of them — including the queue and its persistence
 * — to carry an optional payload would be a lot of surface for one optional
 * field. So the payload waits here and is picked up at the one place that
 * builds the message: `sendUserMessage`. The queue keeps working untouched,
 * because the stash outlives the wait rather than riding the queued item.
 *
 * ONE-SHOT, on purpose. {@link takeGenerationRequest} reads AND clears, so a
 * stashed request can attach to exactly one message and can never leak onto a
 * later one the person typed themselves. A generation that never reaches a
 * mounted composer clears the stash instead of leaving it armed
 * ({@link clearGenerationRequest}).
 *
 * Module scope is the seam this area already uses for the same reason — see
 * composer-handoff.ts's handler registry and agent-status.ts's generation
 * target publisher.
 */

let pendingRequest: GenerationRequestDataPart | null = null;

/** Arm the next message with `request`, replacing any unclaimed one. */
export function stashGenerationRequest(request: GenerationRequestDataPart): void {
  pendingRequest = request;
}

/** The armed request, cleared by the read. Null when there is none. */
export function takeGenerationRequest(): GenerationRequestDataPart | null {
  const request = pendingRequest;
  pendingRequest = null;
  return request;
}

/** Disarm without sending — the handoff found no composer mounted. */
export function clearGenerationRequest(): void {
  pendingRequest = null;
}
