import type { CreatePersonaCommand } from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import { fetchAuthMutation } from "@/lib/auth/auth-server";
import { hashIdentifier, logFailure, summarizeError } from "@/lib/observability/log";

/*
  Agent-parity createPersona executor (server-only, imported by the /api/chat
  editor-action seam — the generateImage pattern: the tool's `run` produced
  the UNFULFILLED intent command; this module performs the effect and returns
  the fulfilled command carrying the new slug).

  The persona row is created through the SAME session-owned Convex mutation
  the picker's create form uses (`api.personas.createPersona`), so every
  server-side guarantee applies unchanged: markdown validation, the
  per-session quota, slug namespacing, and capabilityMode pinned to
  "advisory" — an agent-created persona can never edit the document.

  Intent-level args → schema translation happens HERE, deterministically
  (the LLM tool interface principle): the model gives { name, description,
  behavior? }; this module derives the markdown (built-in-shaped frontmatter
  + body), picks an accent color from the picker's palette by name hash, and
  uses the create form's default cooldown.
*/

/*
  The picker's swatch palette (PersonaPickerDialog PERSONA_COLOR_PALETTE).
*/
const PERSONA_COLOR_PALETTE = [
  "#e11d48", /* rose */
  "#0d9488", /* teal */
  "#d97706", /* amber */
  "#16a34a", /* green */
  "#c026d3", /* fuchsia */
  "#475569", /* slate */
] as const;

/*
  The create form's default eagerness ("Balanced" on the slider).
*/
const DEFAULT_COOLDOWN_SECONDS = 60;

/*
  Deterministic palette pick: same name → same color, distinct names spread.
*/
export function pickPersonaColor(name: string): string {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  return PERSONA_COLOR_PALETTE[hash % PERSONA_COLOR_PALETTE.length]!;
}

/*
  Serialize the intent into the built-ins' markdown shape: frontmatter with
  the one-line description, then the behavior text as the body (falling back
  to the description — the mutation requires a non-empty body).
*/
export function buildPersonaMarkdown({
  name,
  description,
  behavior,
}: {
  name: string;
  description: string;
  behavior?: string;
}): string {
  const singleLineDescription = description.replace(/\s+/g, " ").trim();
  return [
    "---",
    `name: ${name.trim()}`,
    `description: ${singleLineDescription}`,
    "---",
    "",
    (behavior ?? description).trim(),
    "",
  ].join("\n");
}

export type CreatePersonaOutcome =
  | { isOk: true; command: CreatePersonaCommand }
  | { isOk: false; message: string };

export interface CreatePersonaForSessionInput {
  /*
    The unfulfilled command from the action's `run` (intent-level args).
  */
  command: CreatePersonaCommand;
  /*
    The calling browser's anonymous session id (session cookie), or null.
  */
  sessionId: string | null;
}

/*
  Create the session-owned persona row and return the FULFILLED command
  (slug present). Failures return a clean human sentence — the Convex
  mutation's own errors (quota, validation) are already user-facing copy.
*/
export async function createPersonaForSession({
  command,
  sessionId,
}: CreatePersonaForSessionInput): Promise<CreatePersonaOutcome> {
  if (sessionId === null) {
    return {
      isOk: false,
      message:
        "This browser has no active session yet, so the persona couldn't be saved — reload the editor and try again.",
    };
  }
  try {
    /*
      Authenticated: personas are keyed by resolveOwnerId, and the copy slug
      embeds the owner id. See api/chat/list-assets.ts for the full rationale.
    */
    const { slug } = await fetchAuthMutation(api.personas.createPersona, {
      sessionId,
      name: command.name.trim(),
      color: pickPersonaColor(command.name.trim()),
      cooldownSeconds: DEFAULT_COOLDOWN_SECONDS,
      personaMarkdown: buildPersonaMarkdown({
        name: command.name,
        description: command.description,
        behavior: command.behavior,
      }),
    });
    return { isOk: true, command: { ...command, slug } };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    /*
      No model call happens in this module — the persona row comes from a
      Convex mutation — so this is a plain failure record, not a model record.
    */
    const summary = summarizeError(error);
    logFailure({
      tag: "flock.chat.createPersonaFailed",
      errorCode: summary.code,
      errorName: summary.name,
      sessionHash: hashIdentifier(sessionId),
      message: summary.message,
    });
    /*
      Convex surfaces the mutation's thrown Error message inside a longer
      envelope; extract the human sentence when present.
    */
    const humanMessage = rawMessage.match(/Uncaught Error: ([^\n]+)/)?.[1] ?? null;
    return {
      isOk: false,
      message: humanMessage ?? "The persona couldn't be created right now — try again shortly.",
    };
  }
}
