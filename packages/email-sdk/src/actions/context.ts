import { z } from "zod";
import type { OperationAuthor } from "../operations/log";

/*
  Caller provenance — who invoked an action, through which surface.

  Adopted from agent-native's `ctx.caller` (plan §9.4 item 3): every action
  invocation is tagged with the surface it arrived through, so op-log history
  and AI-batch revert can attribute changes precisely ("the agent did this via
  a tool call in thread X" vs "a human clicked a button").
*/

/*
  Every surface an email action can be invoked through.
*/
export const ACTION_CALLERS = ["tool", "http", "frontend", "cli", "mcp"] as const;

export const actionCallerSchema = z
  .enum(ACTION_CALLERS)
  .describe(
    'Surface the action was invoked through: "tool" (AI SDK tool call), "http" (HTTP route), "frontend" (typed client dispatcher / UI control), "cli", or "mcp".',
  );

export type ActionCaller = z.infer<typeof actionCallerSchema>;

/*
  WHY THERE IS A SECOND IDENTITY FIELD AT ALL.

  `authorId` is SELF-ASSERTED. A surface writes whatever string it likes into
  it and nothing checks: the agent path stamps `threadId ?? "flock-agent"`, the
  chat panel stamps a chat id, a suggestion surface stamps its own label. That
  is exactly right for what `authorId` is FOR — it is the display author, the
  name the History panel prints — and exactly wrong as an answer to "may this
  caller do this".

  Attribution and verification are different questions. Conflating them has
  already cost this codebase twice: `authorId` doubled as undo ownership until
  `undoOwnerId` split it out, and it doubled as the send gate's only bar until
  this field split THAT out. So a verified caller is its own field, written
  only by a surface that actually established one, and never by a caller that
  merely claims one.
*/

/*
  Why an invocation has no verified caller, when a surface established that as
  a fact rather than simply never asking.

  - `no_identity_system`: this DEPLOYMENT has no identity at all — Flock's
    auth flag is off, nobody is signed in anywhere, `getUserIdentity()` is
    null in every Convex function. Nothing is missing; there is nothing to
    miss. An action may reasonably decide to run anyway, but it has to decide
    that explicitly (see `requiresVerifiedCaller` in ./define).
  - `no_verified_session`: the deployment HAS identity and this caller has
    none — an expired session, or a bare request from outside a browser.
*/
export const VERIFIED_CALLER_ABSENCE_REASONS = ["no_identity_system", "no_verified_session"] as const;

export type VerifiedCallerAbsenceReason = (typeof VERIFIED_CALLER_ABSENCE_REASONS)[number];

/*
  A caller identity the SERVER established, not one the caller asserted.

  Deliberately a discriminated union rather than `string | undefined`, so
  "verified as user X" can never be confused with "no answer" by forgetting a
  null check — reading `ownerId` requires narrowing on `isVerified` first.
*/
export type VerifiedCaller =
  | { isVerified: true; ownerId: string }
  | { isVerified: false; reason: VerifiedCallerAbsenceReason };

/*
  Provenance for one action invocation. Flows into the op log via
  `createLogEntry` when a content action is dispatched, and into
  `needsApproval` predicates so approval can depend on who is asking.
*/
export interface ActionContext {
  /*
    Which surface issued this invocation.
  */
  caller: ActionCaller;
  /*
    Stable identifier of the author: a user id, or an agent/thread id for AI edits.
  */
  authorId: string;
  /*
    Whose undo stack this invocation belongs to, when that is not `authorId`.

    `authorId` answers "who should this be attributed to" and an AI edit
    answers it with an agent/thread id. Undo asks a different question: which
    human is entitled to step this change back. A person who prompts the
    agent — or applies a suggestion — owns the result even though the agent
    authored it, so surfaces acting on someone's behalf set this to that
    person's id. Omit when the author IS the owner.
  */
  undoOwnerId?: string;
  /*
    Whether a human or an AI agent authored the invocation.
  */
  author: OperationAuthor;
  /*
    Groups operations applied atomically as one batch (e.g. one AI turn).
  */
  batchId?: string;
  /*
    Chat/agent thread this invocation belongs to, for attribution.
  */
  threadId?: string;
  /*
    The caller's VERIFIED identity, established by the surface before dispatch.

    OPTIONAL, and absence is meaningful in its own right: omitted means this
    surface never established anything — a browser dispatch, a CLI run, a test.
    That is a THIRD state, distinct from both `{ isVerified: true }` and an
    explicit `{ isVerified: false, reason }`, and it is the one state that must
    never be mistaken for verification. Nothing defaults this field: a surface
    that wants an action's verified-caller requirement satisfied has to go and
    find out who is asking.

    Only a surface that can actually verify may write it — in practice a
    server that resolved a signed token. A browser cannot, and
    `buildDispatchContext` strips the field off caller-supplied provenance
    precisely so browser code cannot assert it by accident or otherwise.
  */
  verifiedCaller?: VerifiedCaller;
}
