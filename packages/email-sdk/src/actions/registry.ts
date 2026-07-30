import type { z } from "zod";
import type { OperationError } from "../operations/apply";
import { createLogEntry, type OperationLogEntry } from "../operations/log";
import type { Operation } from "../operations/ops";
import type { BlockId } from "../schema/ids";
import type { EmailDocument } from "../store/document";
import type { ActionContext } from "./context";
import { resolveNeedsApproval, type AnyEmailAction, type NeedsApprovalOption } from "./define";
import type { EditorCommand } from "./editor-commands";
import {
  classifyActionErrors,
  type ActionDispatchErrorCode,
  type ActionFailureKind,
} from "./taxonomy";

/**
 * The action registry and its generated surfaces — all PURE data/functions.
 *
 * Nothing here imports 'ai', Convex, or React. Phase 3 wires
 * `toAISDKToolDefinitions` output into AI SDK `tool()` calls (zod-to-tool glue
 * + streaming only); Phase 4 wraps `dispatchContentAction` in a Convex
 * mutation; Phase 8 mounts the same registry over HTTP/MCP.
 */

export interface EmailActionRegistry {
  /** Every registered action, in registration order. */
  readonly actions: readonly AnyEmailAction[];
  /** Name → action lookup. */
  readonly actionsByName: ReadonlyMap<string, AnyEmailAction>;
}

/** Build a registry from action definitions. Throws on duplicate names. */
export function createActionRegistry(actions: readonly AnyEmailAction[]): EmailActionRegistry {
  const actionsByName = new Map<string, AnyEmailAction>();
  for (const action of actions) {
    if (actionsByName.has(action.name)) {
      throw new Error(`createActionRegistry: duplicate action name "${action.name}".`);
    }
    actionsByName.set(action.name, action);
  }
  return { actions: [...actions], actionsByName };
}

/** Look up one action by name. */
export function getAction(
  registry: EmailActionRegistry,
  name: string,
): AnyEmailAction | undefined {
  return registry.actionsByName.get(name);
}

// ---------------------------------------------------------------------------
// Surface (a): AI SDK tool definitions
// ---------------------------------------------------------------------------

/**
 * One model-facing tool definition as plain data. Phase 3 maps each of these
 * through AI SDK v7's `tool()` — this package deliberately emits plain objects
 * + Zod schemas instead of importing 'ai'.
 */
export interface AISDKToolDefinition {
  /** Tool name the model calls (the action name). */
  name: string;
  description: string;
  /**
   * The COMPACT `agentInputSchema` — what the model sees. Dispatch always
   * re-validates the raw input against the action's FULL `schema`.
   */
  inputSchema: z.ZodType;
  /**
   * Boolean or `(input, context) => boolean` predicate. Phase 3 adapts the
   * predicate form by closing over the request's `ActionContext` (AI SDK's
   * own `needsApproval` callback only receives the input).
   */
  needsApproval: NeedsApprovalOption<unknown>;
}

/** Generate the model-facing tool definitions for every action in the registry. */
export function toAISDKToolDefinitions(registry: EmailActionRegistry): AISDKToolDefinition[] {
  return registry.actions.map((action) => ({
    name: action.name,
    description: action.description,
    inputSchema: action.agentInputSchema,
    needsApproval: action.needsApproval,
  }));
}

// ---------------------------------------------------------------------------
// Surface (b): content-action dispatcher
// ---------------------------------------------------------------------------

/** One structured dispatch failure — an OperationError, or a dispatch-level code. */
export interface ActionDispatchError {
  code: ActionDispatchErrorCode;
  /** Human-readable explanation, written to be fed back to the model as a repair hint. */
  message: string;
  blockId?: BlockId;
  relatedBlockId?: BlockId;
}

export type DispatchContentActionResult =
  | {
      isOk: true;
      /** The new document. The input document is never mutated. */
      doc: EmailDocument;
      /** The operation that exactly undoes this one. */
      inverse: Operation;
      /** Ready-to-persist op-log entry carrying the caller's provenance. */
      logEntry: OperationLogEntry;
    }
  | {
      isOk: false;
      /** "retryable" → one repair round-trip; "terminal" → stop the turn. */
      failureKind: ActionFailureKind;
      errors: ActionDispatchError[];
    };

const formatZodIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");

export interface DispatchContentActionInput {
  /** The registry to resolve the action from. */
  registry: EmailActionRegistry;
  /** The document to apply the action to. Never mutated. */
  doc: EmailDocument;
  /** The action name (the tool name the model called). */
  name: string;
  /** Raw, unvalidated input — re-validated here against the action's FULL schema. */
  input: unknown;
  /** Caller provenance stamped onto the op-log entry. */
  context: ActionContext;
}

/**
 * Dispatch one content action: validate the raw input against the action's
 * FULL schema (the model only saw the compact one), run the pure apply, and on
 * success return the new document, the inverse, and a ready-to-persist op-log
 * entry stamped with the caller's provenance.
 *
 * Pure — persistence (Convex mutation, Phase 4) and approval gating (the agent
 * loop halts BEFORE dispatch when `needsApproval` resolves true) live outside.
 */
export function dispatchContentAction({
  registry,
  doc,
  name,
  input,
  context,
}: DispatchContentActionInput): DispatchContentActionResult {
  const action = getAction(registry, name);
  if (action === undefined) {
    const knownContentActionNames = registry.actions
      .filter((candidate) => candidate.kind === "content")
      .map((candidate) => candidate.name);
    return {
      isOk: false,
      failureKind: classifyActionErrors([{ code: "unknown_action" }]),
      errors: [
        {
          code: "unknown_action",
          message: `No action named "${name}". Known content actions: ${knownContentActionNames.join(", ")}.`,
        },
      ],
    };
  }
  if (action.kind !== "content") {
    return {
      isOk: false,
      failureKind: classifyActionErrors([{ code: "wrong_action_kind" }]),
      errors: [
        {
          code: "wrong_action_kind",
          message: `Action "${name}" is a ${action.kind} action; dispatchContentAction only handles content actions.`,
        },
      ],
    };
  }
  const parsedInput = action.schema.safeParse(input);
  if (!parsedInput.success) {
    return {
      isOk: false,
      failureKind: classifyActionErrors([{ code: "op_validation_failed" }]),
      errors: [
        {
          code: "op_validation_failed",
          message: `Input for action "${name}" failed validation: ${formatZodIssues(parsedInput.error)}`,
        },
      ],
    };
  }
  // Intent-shaped actions (styleTextSpan) translate to a canonical operation
  // first — the op log only ever holds replayable email-sdk Operations. `run`
  // then receives the RESOLVED operation (the documented dispatch contract).
  let operation = parsedInput.data as Operation;
  if (action.resolveOperation !== undefined) {
    const resolved = action.resolveOperation(doc, parsedInput.data);
    if (!resolved.isOk) {
      return {
        isOk: false,
        failureKind: classifyActionErrors(resolved.errors),
        errors: resolved.errors.map((error): ActionDispatchError => ({ ...error })),
      };
    }
    operation = resolved.op;
  }
  const result = action.run(doc, operation);
  if (!result.isOk) {
    return {
      isOk: false,
      failureKind: classifyActionErrors(result.errors),
      errors: result.errors.map((error: OperationError): ActionDispatchError => ({ ...error })),
    };
  }
  const logEntry = createLogEntry({
    op: operation,
    inverse: result.inverse,
    authorId: context.authorId,
    author: context.author,
    batchId: context.batchId,
    caller: context.caller,
    threadId: context.threadId,
  });
  return { isOk: true, doc: result.doc, inverse: result.inverse, logEntry };
}

// ---------------------------------------------------------------------------
// Surface (c): editor-action dispatcher (typed client-command channel)
// ---------------------------------------------------------------------------

export type DispatchEditorActionResult =
  | {
      isOk: true;
      /** The typed client command to stream to the frontend as a data part. */
      command: EditorCommand;
      /** Resolved `needsApproval` gate — the loop must halt for approval when true. */
      isApprovalRequired: boolean;
    }
  | {
      isOk: false;
      failureKind: ActionFailureKind;
      errors: ActionDispatchError[];
    };

export interface DispatchEditorActionInput {
  /** The registry to resolve the action from. */
  registry: EmailActionRegistry;
  /** The action name (the tool name the model called). */
  name: string;
  /** Raw, unvalidated input — re-validated here against the action's FULL schema. */
  input: unknown;
  /** Caller context used to resolve the action's `needsApproval` gate. */
  context: ActionContext;
}

/**
 * Dispatch one editor action: validate against the FULL schema and produce the
 * typed `EditorCommand` payload for the streamed data-parts channel. No
 * document is involved — editor actions have no doc effect by definition.
 */
export function dispatchEditorAction({
  registry,
  name,
  input,
  context,
}: DispatchEditorActionInput): DispatchEditorActionResult {
  const action = getAction(registry, name);
  if (action === undefined) {
    const knownEditorActionNames = registry.actions
      .filter((candidate) => candidate.kind === "editor")
      .map((candidate) => candidate.name);
    return {
      isOk: false,
      failureKind: classifyActionErrors([{ code: "unknown_action" }]),
      errors: [
        {
          code: "unknown_action",
          message: `No action named "${name}". Known editor actions: ${knownEditorActionNames.join(", ")}.`,
        },
      ],
    };
  }
  if (action.kind !== "editor") {
    return {
      isOk: false,
      failureKind: classifyActionErrors([{ code: "wrong_action_kind" }]),
      errors: [
        {
          code: "wrong_action_kind",
          message: `Action "${name}" is a ${action.kind} action; dispatchEditorAction only handles editor actions.`,
        },
      ],
    };
  }
  const parsedInput = action.schema.safeParse(input);
  if (!parsedInput.success) {
    return {
      isOk: false,
      failureKind: classifyActionErrors([{ code: "op_validation_failed" }]),
      errors: [
        {
          code: "op_validation_failed",
          message: `Input for action "${name}" failed validation: ${formatZodIssues(parsedInput.error)}`,
        },
      ],
    };
  }
  return {
    isOk: true,
    command: action.run(parsedInput.data),
    isApprovalRequired: resolveNeedsApproval({ action, input: parsedInput.data, context }),
  };
}
