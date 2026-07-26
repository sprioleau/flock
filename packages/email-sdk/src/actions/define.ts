import type { z } from "zod";
import type { ApplyOperationResult } from "../operations/apply";
import type { EmailDocument } from "../store/document";
import type { ActionContext } from "./context";
import type { EditorCommand } from "./editor-commands";

/**
 * `defineEmailAction` — the action envelope factory (plan §9.3).
 *
 * The envelope is the EXPOSURE layer; email-sdk operations are the pure
 * SUBSTANCE. One definition captures everything a surface needs — full
 * validation schema, compact model-facing schema, provenance-aware approval
 * gate, agent-loop flags — so tool definitions (Phase 3), Convex mutations
 * (Phase 4), and HTTP/MCP mounts (Phase 8) are all generated from the
 * registry instead of hand-wired per operation.
 *
 * This is our own thin factory. We deliberately do NOT import
 * `@agent-native/core` — we adopt six of its features (agentInputSchema,
 * needsApproval, caller provenance, readOnly/parallelSafe flags, stop-vs-retry
 * taxonomy, audit annotations) on our Convex + AI SDK stack, nothing more.
 */

/** The three action kinds, each with a different dispatch shape (see below). */
export const EMAIL_ACTION_KINDS = ["content", "editor", "analysis"] as const;

export type EmailActionKind = (typeof EMAIL_ACTION_KINDS)[number];

/**
 * Human-in-the-loop gate: a plain boolean, or a predicate over the validated
 * input and caller provenance (e.g. "approval only for external recipients",
 * or "only when an agent — not a human — is asking").
 */
export type NeedsApprovalOption<TInput> =
  | boolean
  | ((input: TInput, context: ActionContext) => boolean);

interface EmailActionConfigBase<TSchema extends z.ZodType> {
  /** Unique action name; also the tool name advertised to the model. */
  name: string;
  /** Model- and human-facing description of what the action does. */
  description: string;
  /** FULL Zod schema — every dispatch validates the raw input against this. */
  schema: TSchema;
  /**
   * Optional COMPACT schema advertised to the model instead of `schema`
   * (plan §9.4 item 1: keep deep discriminated unions out of every request;
   * a catalog-lookup tool teaches full shapes on demand). Validation always
   * runs against the full `schema`. Defaults to `schema`.
   */
  agentInputSchema?: z.ZodType;
  /** Safe to execute concurrently with other actions in the same turn. */
  parallelSafe: boolean;
  /** Human-in-the-loop gate — the loop halts with `approval_required` instead of executing. */
  needsApproval: NeedsApprovalOption<z.output<TSchema>>;
}

/**
 * Content action config: transforms the document. `run` is the pure hook —
 * `(doc, input) → ApplyOperationResult` — for the built-ins simply
 * `(doc, op) => applyOperation(doc, op)`. The input must be (or parse to) an
 * email-sdk Operation, because the dispatch layer logs it (with its generated
 * inverse) as the op-log entry that powers undo/redo and batch revert.
 */
export interface ContentEmailActionConfig<TSchema extends z.ZodType = z.ZodType>
  extends EmailActionConfigBase<TSchema> {
  kind: "content";
  /** Content actions mutate the document by definition. */
  readOnly: false;
  run: (doc: EmailDocument, input: z.output<TSchema>) => ApplyOperationResult;
}

/**
 * Editor action config: NO document effect. `run` produces a typed
 * `EditorCommand` payload that Phase 3 streams to the frontend as a data part;
 * a client dispatcher executes it against the editor UI.
 */
export interface EditorEmailActionConfig<
  TSchema extends z.ZodType = z.ZodType,
  TCommand extends EditorCommand = EditorCommand,
> extends EmailActionConfigBase<TSchema> {
  kind: "editor";
  /** Editor actions never change the document, but most affect the screen. */
  readOnly: boolean;
  run: (input: z.output<TSchema>) => TCommand;
}

/**
 * Analysis action config: read-only data over the document (e.g. a future
 * `get-block-details` catalog-lookup tool). `readOnly: true` is enforced —
 * it lets the agent loop dedupe repeated reads within a turn.
 */
export interface AnalysisEmailActionConfig<
  TSchema extends z.ZodType = z.ZodType,
  TOutput = unknown,
> extends EmailActionConfigBase<TSchema> {
  kind: "analysis";
  readOnly: true;
  run: (doc: EmailDocument, input: z.output<TSchema>) => TOutput;
}

/** A defined content action: config normalized (agentInputSchema resolved) and frozen. */
export type ContentEmailAction<TSchema extends z.ZodType = z.ZodType> = Readonly<
  ContentEmailActionConfig<TSchema>
> & { readonly agentInputSchema: z.ZodType };

/** A defined editor action: config normalized (agentInputSchema resolved) and frozen. */
export type EditorEmailAction<
  TSchema extends z.ZodType = z.ZodType,
  TCommand extends EditorCommand = EditorCommand,
> = Readonly<EditorEmailActionConfig<TSchema, TCommand>> & { readonly agentInputSchema: z.ZodType };

/** A defined analysis action: config normalized (agentInputSchema resolved) and frozen. */
export type AnalysisEmailAction<
  TSchema extends z.ZodType = z.ZodType,
  TOutput = unknown,
> = Readonly<AnalysisEmailActionConfig<TSchema, TOutput>> & { readonly agentInputSchema: z.ZodType };

/**
 * Any defined action, input types erased (`any`) so heterogeneous actions can
 * share one registry. Narrow on `kind` before calling `run`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate erasure for the registry
export type AnyEmailAction =
  | ContentEmailAction<any>
  | EditorEmailAction<any, EditorCommand>
  | AnalysisEmailAction<any, unknown>;

type AnyEmailActionConfig =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate erasure, see AnyEmailAction
  | ContentEmailActionConfig<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | EditorEmailActionConfig<any, EditorCommand>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | AnalysisEmailActionConfig<any, unknown>;

/** Lowercase start, then letters/digits/hyphens: `updateText`, `send-test-email`. */
const ACTION_NAME_PATTERN = /^[a-z][a-zA-Z0-9-]*$/;

/**
 * Define one email action: validates the config, defaults `agentInputSchema`
 * to the full `schema`, and returns the frozen definition. Pure data + one
 * pure `run` hook — no framework dependencies, no I/O.
 */
export function defineEmailAction<TSchema extends z.ZodType>(
  config: ContentEmailActionConfig<TSchema>,
): ContentEmailAction<TSchema>;
export function defineEmailAction<TSchema extends z.ZodType, TCommand extends EditorCommand>(
  config: EditorEmailActionConfig<TSchema, TCommand>,
): EditorEmailAction<TSchema, TCommand>;
export function defineEmailAction<TSchema extends z.ZodType, TOutput>(
  config: AnalysisEmailActionConfig<TSchema, TOutput>,
): AnalysisEmailAction<TSchema, TOutput>;
export function defineEmailAction(config: AnyEmailActionConfig): AnyEmailAction {
  if (!ACTION_NAME_PATTERN.test(config.name)) {
    throw new Error(
      `defineEmailAction: invalid action name "${config.name}" — must start with a lowercase letter and contain only letters, digits, and hyphens.`,
    );
  }
  if (config.description.trim().length === 0) {
    throw new Error(
      `defineEmailAction: action "${config.name}" needs a non-empty description — it is the model's documentation for the tool.`,
    );
  }
  if (!EMAIL_ACTION_KINDS.includes(config.kind)) {
    throw new Error(
      `defineEmailAction: action "${config.name}" has unknown kind "${String(config.kind)}" — expected one of: ${EMAIL_ACTION_KINDS.join(", ")}.`,
    );
  }
  // The literal types enforce these for TS callers; re-check for JS/runtime callers.
  if (config.kind === "content" && (config.readOnly as boolean) !== false) {
    throw new Error(
      `defineEmailAction: content action "${config.name}" cannot be readOnly — content actions mutate the document by definition.`,
    );
  }
  if (config.kind === "analysis" && (config.readOnly as boolean) !== true) {
    throw new Error(
      `defineEmailAction: analysis action "${config.name}" must be readOnly — analysis actions only read the document.`,
    );
  }
  if (typeof config.run !== "function") {
    throw new Error(`defineEmailAction: action "${config.name}" needs a run function.`);
  }
  return Object.freeze({
    ...config,
    agentInputSchema: config.agentInputSchema ?? config.schema,
  });
}

export interface ResolveNeedsApprovalInput {
  /** The action whose `needsApproval` option to resolve. */
  action: AnyEmailAction;
  /**
   * The invocation input. Should already have passed the action's full schema
   * when the option is a predicate.
   */
  input: unknown;
  /** The caller context handed to a predicate-form `needsApproval`. */
  context: ActionContext;
}

/** Resolve an action's `needsApproval` gate for one invocation. */
export function resolveNeedsApproval({
  action,
  input,
  context,
}: ResolveNeedsApprovalInput): boolean {
  if (typeof action.needsApproval === "function") {
    return action.needsApproval(input, context);
  }
  return action.needsApproval;
}
