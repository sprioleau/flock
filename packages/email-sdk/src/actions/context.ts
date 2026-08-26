import { z } from "zod";
import type { OperationAuthor } from "../operations/log";

/**
 * Caller provenance — who invoked an action, through which surface.
 *
 * Adopted from agent-native's `ctx.caller` (plan §9.4 item 3): every action
 * invocation is tagged with the surface it arrived through, so op-log history
 * and AI-batch revert can attribute changes precisely ("the agent did this via
 * a tool call in thread X" vs "a human clicked a button").
 */

/** Every surface an email action can be invoked through. */
export const ACTION_CALLERS = ["tool", "http", "frontend", "cli", "mcp"] as const;

export const actionCallerSchema = z
  .enum(ACTION_CALLERS)
  .describe(
    'Surface the action was invoked through: "tool" (AI SDK tool call), "http" (HTTP route), "frontend" (typed client dispatcher / UI control), "cli", or "mcp".',
  );

export type ActionCaller = z.infer<typeof actionCallerSchema>;

/**
 * Provenance for one action invocation. Flows into the op log via
 * `createLogEntry` when a content action is dispatched, and into
 * `needsApproval` predicates so approval can depend on who is asking.
 */
export interface ActionContext {
  /** Which surface issued this invocation. */
  caller: ActionCaller;
  /** Stable identifier of the author: a user id, or an agent/thread id for AI edits. */
  authorId: string;
  /**
   * Whose undo stack this invocation belongs to, when that is not `authorId`.
   *
   * `authorId` answers "who should this be attributed to" and an AI edit
   * answers it with an agent/thread id. Undo asks a different question: which
   * human is entitled to step this change back. A person who prompts the
   * agent — or applies a suggestion — owns the result even though the agent
   * authored it, so surfaces acting on someone's behalf set this to that
   * person's id. Omit when the author IS the owner.
   */
  undoOwnerId?: string;
  /** Whether a human or an AI agent authored the invocation. */
  author: OperationAuthor;
  /** Groups operations applied atomically as one batch (e.g. one AI turn). */
  batchId?: string;
  /** Chat/agent thread this invocation belongs to, for attribution. */
  threadId?: string;
}
