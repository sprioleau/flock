import type { z } from "zod";
import type { ApplyOperationResult, OperationError } from "../operations/apply";
import type { Operation } from "../operations/ops";
import type { BlockId } from "../schema/ids";
import type { EmailDocument } from "../store/document";
import type { ActionContext } from "./context";
import {
  ActionAuthorizationError,
  resolveNeedsApproval,
  type AnyEmailAction,
  type NeedsApprovalOption,
} from "./define";
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

/**
 * The failure arm every dispatcher shares. Structurally identical across the
 * three result unions, so one helper can build it for all of them.
 */
interface ActionDispatchFailure {
  isOk: false;
  failureKind: ActionFailureKind;
  errors: ActionDispatchError[];
}

/**
 * Translate a thrown authorization refusal into the structured failure the
 * dispatch surfaces return.
 *
 * The gate throws from inside `run` (see `defineEmailAction`) because that is
 * the only channel all three run shapes share; the dispatchers are where the
 * refusal rejoins the ordinary result taxonomy, so callers of
 * `dispatch*Action` never have to know a throw was involved. `not_authorized`
 * classifies terminal — the turn stops rather than inviting a repair round.
 */
function toAuthorizationDenial(error: ActionAuthorizationError): ActionDispatchFailure {
  return {
    isOk: false,
    failureKind: classifyActionErrors([{ code: error.code }]),
    errors: [{ code: error.code, message: error.message }],
  };
}

export type DispatchContentActionResult =
  | {
      isOk: true;
      /** The new document. The input document is never mutated. */
      doc: EmailDocument;
      /**
       * The CANONICAL operation that was applied — for an intent-shaped action
       * (styleTextSpan, scaffoldSection) the RESOLVED operation, never the
       * intent. This is the value a persistence caller sends onward.
       */
      op: Operation;
      /**
       * The operation that exactly undoes `op` ON THE DOCUMENT PASSED IN.
       *
       * Useful to a pure in-memory caller, and to nobody else: a caller that
       * persists must NOT forward this. The document a caller dispatches
       * against is a read, so an inverse computed from it can already be
       * stale; the write path recomputes the inverse against the
       * authoritative pre-op document inside its own transaction
       * (convex/model/emailDocuments.ts, commitVersions) and re-anchors
       * updateText inverses to the op log. A client-supplied inverse would be
       * both a correctness and a trust hazard, so no write path accepts one.
       */
      inverse: Operation;
      /**
       * The provenance this dispatch ran under, echoed back unchanged.
       *
       * Returned so that persisting is a single forward of ONE result value
       * (`op` + `context`) rather than a pairing of the dispatch output with a
       * context the caller has to keep hold of separately. Two places to pass
       * provenance is two places for it to disagree.
       */
      context: ActionContext;
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
  /** Caller provenance: read by the authorization gate, echoed back on the result. */
  context: ActionContext;
}

/**
 * Dispatch one content action: validate the raw input against the action's
 * FULL schema (the model only saw the compact one), run the pure apply, and on
 * success return the new document, the canonical operation, its in-memory
 * inverse, and the provenance the dispatch ran under.
 *
 * Pure — persistence and approval gating (the agent loop halts BEFORE dispatch
 * when `needsApproval` resolves true) live outside. This function does NOT
 * author an op-log row and deliberately no longer returns anything shaped like
 * one: the persisted row is authored end to end by the write path, which is
 * the only place that sees the authoritative pre-op document. Callers persist
 * by forwarding `op` and `context` to that write path.
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
  /*
    `run` carries the authorization gate (see `defineEmailAction`), so the
    context has to reach it — passing it here is not politeness, it is how the
    gate sees the caller. A refusal throws; it becomes a terminal failure.
  */
  let result: ApplyOperationResult;
  try {
    result = action.run({ doc, input: operation, context });
  } catch (error) {
    if (error instanceof ActionAuthorizationError) {
      return toAuthorizationDenial(error);
    }
    throw error;
  }
  if (!result.isOk) {
    return {
      isOk: false,
      failureKind: classifyActionErrors(result.errors),
      errors: result.errors.map((error: OperationError): ActionDispatchError => ({ ...error })),
    };
  }
  return { isOk: true, doc: result.doc, op: operation, inverse: result.inverse, context };
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
  /*
    Same gate, same reason as the content dispatcher: the context is what the
    authorization check reads, and a refusal arrives as a throw.
  */
  let command: EditorCommand;
  try {
    command = action.run({ input: parsedInput.data, context });
  } catch (error) {
    if (error instanceof ActionAuthorizationError) {
      return toAuthorizationDenial(error);
    }
    throw error;
  }
  return {
    isOk: true,
    command,
    isApprovalRequired: resolveNeedsApproval({ action, input: parsedInput.data, context }),
  };
}

// ---------------------------------------------------------------------------
// Surface (d): analysis-action dispatcher (read-only data back to the model)
// ---------------------------------------------------------------------------

export type DispatchAnalysisActionResult =
  | {
      isOk: true;
      /**
       * Whatever the action's `run` returned, type erased.
       *
       * Analysis `run` is DECLARED synchronous, but an analysis action may
       * legitimately return a promise as its `TOutput` (the agent package's
       * web-content and person-research actions do network I/O and are typed
       * `AnalysisEmailAction<Schema, Promise<...>>`). This dispatcher stays
       * synchronous and hands that value straight back rather than awaiting it,
       * so it keeps working for both — the caller awaits when it must. Making
       * dispatch async instead would have made `run` async, which the editor
       * store's synchronous local-apply path cannot absorb.
       */
      data: unknown;
      /** Resolved `needsApproval` gate — the loop must halt for approval when true. */
      isApprovalRequired: boolean;
    }
  | {
      isOk: false;
      failureKind: ActionFailureKind;
      errors: ActionDispatchError[];
    };

export interface DispatchAnalysisActionInput {
  /** The registry to resolve the action from. */
  registry: EmailActionRegistry;
  /** The document the analysis reads. Never mutated — analysis is readOnly. */
  doc: EmailDocument;
  /** The action name (the tool name the model called). */
  name: string;
  /** Raw, unvalidated input — re-validated here against the action's FULL schema. */
  input: unknown;
  /** Caller provenance, which the authorization gate inside `run` reads. */
  context: ActionContext;
}

/**
 * Dispatch one analysis action: resolve it, check the kind, validate the raw
 * input against the action's FULL schema, and run it behind the same
 * authorization gate the other two kinds go through.
 *
 * This dispatcher exists because its absence WAS the bug. Content and editor
 * actions had dispatchers; analysis actions did not, so the chat route called
 * `action.run(doc, input)` itself — a second, hand-rolled dispatch path that
 * drifted from the other two and answered to nothing the registry enforces.
 * Two dispatchers plus one open-coded call site is not "three dispatch paths",
 * it is two paths and a hole. Every action kind now has exactly one door.
 */
export function dispatchAnalysisAction({
  registry,
  doc,
  name,
  input,
  context,
}: DispatchAnalysisActionInput): DispatchAnalysisActionResult {
  const action = getAction(registry, name);
  if (action === undefined) {
    const knownAnalysisActionNames = registry.actions
      .filter((candidate) => candidate.kind === "analysis")
      .map((candidate) => candidate.name);
    return {
      isOk: false,
      failureKind: classifyActionErrors([{ code: "unknown_action" }]),
      errors: [
        {
          code: "unknown_action",
          message: `No action named "${name}". Known analysis actions: ${knownAnalysisActionNames.join(", ")}.`,
        },
      ],
    };
  }
  if (action.kind !== "analysis") {
    return {
      isOk: false,
      failureKind: classifyActionErrors([{ code: "wrong_action_kind" }]),
      errors: [
        {
          code: "wrong_action_kind",
          message: `Action "${name}" is a ${action.kind} action; dispatchAnalysisAction only handles analysis actions.`,
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
  let data: unknown;
  try {
    data = action.run({ doc, input: parsedInput.data, context });
  } catch (error) {
    if (error instanceof ActionAuthorizationError) {
      return toAuthorizationDenial(error);
    }
    throw error;
  }
  return {
    isOk: true,
    data,
    isApprovalRequired: resolveNeedsApproval({ action, input: parsedInput.data, context }),
  };
}
