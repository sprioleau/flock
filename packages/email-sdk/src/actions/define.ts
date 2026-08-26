import type { z } from "zod";
import type { ApplyOperationResult } from "../operations/apply";
import type { Operation } from "../operations/ops";
import type { BlockId } from "../schema/ids";
import type { EmailDocument } from "../store/document";
import type { ActionContext, VerifiedCaller } from "./context";
import type { EditorCommand } from "./editor-commands";
import type { ActionDispatchErrorCode } from "./taxonomy";

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

/**
 * Authorization gate: MAY this caller invoke this action at all?
 *
 * A different question from `needsApproval`, which asks whether a human should
 * bless one particular call. Only the authorization question can be enforced
 * uniformly, because only it has an answer that does not depend on who happens
 * to be watching: an unauthorized caller is refused whether or not there is a
 * person at the keyboard to say no.
 *
 * Same shape as `NeedsApprovalOption` — a plain boolean, or a predicate over
 * the validated input and the caller's provenance — with `true` meaning
 * allowed. Omitting `authorize` means allowed, so this option is purely
 * additive: no action that does not declare one behaves differently.
 *
 * SYNCHRONOUS, deliberately. Content `run` is
 * `(doc, input) => ApplyOperationResult` and the browser editor store
 * dispatches content actions synchronously on its optimistic local-apply path;
 * an async gate would force `run` async and ripple through every one of those
 * call sites. Any I/O an authorization decision needs — resolving a session
 * cookie to a user, reading a role — belongs to the SURFACE, which does it
 * before dispatch and hands the answer in on the `ActionContext`.
 */
export type AuthorizeOption<TInput> =
  | boolean
  | ((input: TInput, context: ActionContext) => boolean);

/**
 * What an action that requires a verified caller does on a deployment that has
 * NO identity system at all (Flock's auth flag off: nobody is signed in
 * anywhere, so no caller can ever be verified).
 *
 * There is no safe default here, which is why there is no default. "allow"
 * silently makes the requirement a no-op on such a deployment; "refuse" makes
 * the action permanently uncallable there. Both are defensible and they are
 * opposites, so the action states which one it means, in its definition, where
 * a reader and a reviewer can see it.
 */
export const NO_IDENTITY_SYSTEM_POLICIES = ["allow", "refuse"] as const;

export type NoIdentitySystemPolicy = (typeof NO_IDENTITY_SYSTEM_POLICIES)[number];

/**
 * An action's DECLARED requirement for a verified caller.
 *
 * Declarative on purpose, and modelled on `resultSource`: an implicit property
 * of an action written by hand into each author's `authorize` closure becomes
 * one explicit, compile-time-checked field that both ends read. The hand-written
 * alternative — every author spelling out
 * `context.verifiedCaller?.isVerified === true` — gets the common case subtly
 * wrong in a way nothing catches: it silently answers "no identity system on
 * this deployment" with a refusal (or, if written the other way, with a pass),
 * and which of those was intended is invisible at the call site. Requiring
 * `whenNoIdentitySystem` makes that answer impossible to leave unstated.
 *
 * It composes WITH `authorize` rather than replacing it: this asks whether the
 * caller is who they say they are, `authorize` asks whether that caller may do
 * this thing. The requirement is checked first — there is no point judging an
 * identity nobody established.
 */
export interface VerifiedCallerRequirement {
  /** See {@link NoIdentitySystemPolicy}. Required: the action must answer it. */
  whenNoIdentitySystem: NoIdentitySystemPolicy;
}

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
  /**
   * Optional authorization gate — omitted means "anyone who can reach this may
   * call it". Unlike `needsApproval` this is NOT a flag dispatchers consult:
   * `defineEmailAction` composes it into the `run` it hands back, so it is
   * enforced on every dispatch path (see the note above the factory's return).
   *
   * The predicate sees exactly what `run` sees. For an intent-shaped content
   * action with a `resolveOperation` hook that is the RESOLVED operation, not
   * the raw intent — the same contract `run` already documents.
   */
  authorize?: AuthorizeOption<z.output<TSchema>>;
  /**
   * Optional declared requirement that the caller's identity be VERIFIED —
   * established by a surface from something the caller cannot write, not
   * self-asserted on `authorId`.
   *
   * Enforced in the same composed `run` as `authorize`, and checked BEFORE it,
   * so it holds on every dispatch path. Omitted means the action does not care,
   * which is every built-in but one.
   */
  requiresVerifiedCaller?: VerifiedCallerRequirement;
}

/** One structured intent-resolution failure — a repair hint for the model. */
export interface ResolvedOperationError {
  code: ActionDispatchErrorCode;
  /** Human-readable explanation, written to be fed back to the model as a repair hint. */
  message: string;
  blockId?: BlockId;
  relatedBlockId?: BlockId;
}

/** Result of an intent→operation translation (see `resolveOperation`). */
export type ResolveContentOperationResult =
  | { isOk: true; op: Operation }
  | { isOk: false; errors: ResolvedOperationError[] };

/**
 * Content action config: transforms the document. `run` is the pure hook —
 * `(doc, input) → ApplyOperationResult` — for the built-ins simply
 * `(doc, op) => applyOperation(doc, op)`. The input must be (or resolve to) an
 * email-sdk Operation, because the dispatch layer logs it (with its generated
 * inverse) as the op-log entry that powers undo/redo and batch revert.
 */
export interface ContentEmailActionConfig<TSchema extends z.ZodType = z.ZodType>
  extends EmailActionConfigBase<TSchema> {
  kind: "content";
  /** Content actions mutate the document by definition. */
  readOnly: false;
  /**
   * Optional intent→operation translation for actions whose model-facing
   * input is NOT itself an Operation (e.g. styleTextSpan's `{ blockId, find,
   * style }`). When present, `dispatchContentAction` resolves the validated
   * input against the CURRENT document into one canonical Operation BEFORE
   * running: `run` receives the RESOLVED operation (not the raw input), and
   * the op-log entry records the resolved operation — intent shapes never
   * reach the replayable history spine. Resolution failures carry the
   * stop-vs-retry taxonomy codes and are fed back to the model as repair
   * hints. Must be pure and deterministic.
   */
  resolveOperation?: (doc: EmailDocument, input: z.output<TSchema>) => ResolveContentOperationResult;
  run: (doc: EmailDocument, input: z.output<TSchema>) => ApplyOperationResult;
}

/*
  WHICH END PRODUCES AN EDITOR ACTION'S TOOL RESULT — the sentence the model
  is entitled to say once the call returns.

  "server": the server does the work inside its own executor and reports what
  actually happened (sendTestEmail returns the provider's message id;
  generateImage returns a stored image; createPersona returns a created row).
  The result is a verdict because the process that produced it is the process
  that did the work.

  "client": the server has NO executor at all. The call streams to the browser,
  the browser performs it, and the browser writes the tool result. Costs a
  round trip; buys a result that is not a guess.

  This exists because a `run` that merely DESCRIBES a command cannot answer
  "did it work?", and the transport used to answer anyway: the command object
  was streamed back as the tool result before the client had attempted
  anything. For undo that is not a harmless optimism — "there was nothing left
  to undo" is a routine, legitimate outcome, and the model was never told about
  it, so it reported a success it had never checked.

  Server-fulfilled actions keep "server" and are honest already. Four
  client-fulfilled actions (showPreview, openPanel, goToVersion, createDraft)
  are declared "server" today and are NOT yet honest: they still report the
  dispatch rather than the outcome. That is a known remaining gap, deliberately
  not closed in the same change as the history steps — see the notes on each.
*/
export const EDITOR_RESULT_SOURCES = ["server", "client"] as const;

export type EditorResultSource = (typeof EDITOR_RESULT_SOURCES)[number];

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
  /*
    REQUIRED, so every editor action has to answer the question rather than
    inherit an answer. See {@link EditorResultSource}.
  */
  resultSource: EditorResultSource;
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

/**
 * What a DEFINED action's `run` is called with.
 *
 * The config hook is written positionally — `(doc, input)`, `(input)` — and
 * stays that way, because that is what an action author writes. The callable
 * the factory hands back takes one object instead, for two reasons.
 *
 * First, style: the gate has to see the caller, which makes three arguments
 * for a content or analysis run, and three arguments is exactly where this
 * package's one lint rule says to switch to a single object.
 *
 * Second, and more usefully, the shape change is load-bearing. An old
 * `action.run(doc, input)` no longer compiles, so no call site can quietly
 * keep invoking an action without saying who is asking — the compiler finds
 * every one of them, which is the sort of thing you want when the argument
 * being added is the one an authorization decision reads.
 *
 * `context` is REQUIRED. Optional would leave "this surface forgot to identify
 * its caller" as a runtime refusal discovered in production; required makes it
 * a type error discovered while writing the surface.
 */
export interface ActionInvocation<TSchema extends z.ZodType> {
  /** The validated input — this action's FULL schema has already accepted it. */
  input: z.output<TSchema>;
  /** Caller provenance. What the authorization gate judges. */
  context: ActionContext;
}

/** An invocation of a doc-reading action (content and analysis kinds). */
export interface DocumentActionInvocation<TSchema extends z.ZodType>
  extends ActionInvocation<TSchema> {
  /**
   * The document. Content actions never mutate it (they return a new one);
   * analysis actions only read it.
   */
  doc: EmailDocument;
}

/**
 * A defined content action: config normalized (agentInputSchema resolved),
 * `run` replaced by the authorization-gated callable, and frozen. The raw hook
 * is NOT on this object — see `defineEmailAction`.
 *
 * For an intent-shaped content action with a `resolveOperation` hook, the
 * `input` handed to `run` is the RESOLVED operation, not the raw intent — the
 * contract `run` already documented, and therefore also what a content
 * `authorize` predicate sees.
 */
export type ContentEmailAction<TSchema extends z.ZodType = z.ZodType> = Readonly<
  Omit<ContentEmailActionConfig<TSchema>, "run">
> & {
  readonly agentInputSchema: z.ZodType;
  readonly run: (invocation: DocumentActionInvocation<TSchema>) => ApplyOperationResult;
};

/** A defined editor action: as above — normalized, gated, frozen. */
export type EditorEmailAction<
  TSchema extends z.ZodType = z.ZodType,
  TCommand extends EditorCommand = EditorCommand,
> = Readonly<Omit<EditorEmailActionConfig<TSchema, TCommand>, "run">> & {
  readonly agentInputSchema: z.ZodType;
  readonly run: (invocation: ActionInvocation<TSchema>) => TCommand;
};

/** A defined analysis action: as above — normalized, gated, frozen. */
export type AnalysisEmailAction<
  TSchema extends z.ZodType = z.ZodType,
  TOutput = unknown,
> = Readonly<Omit<AnalysisEmailActionConfig<TSchema, TOutput>, "run">> & {
  readonly agentInputSchema: z.ZodType;
  readonly run: (invocation: DocumentActionInvocation<TSchema>) => TOutput;
};

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

/**
 * The refusal an unauthorized invocation produces.
 *
 * THROWN rather than returned, because the gate lives inside the callable and
 * the three `run` shapes have nowhere to put a failure: an editor `run` returns
 * an `EditorCommand`, an analysis `run` returns its data, and neither has a
 * failure arm to widen without changing every implementation. Throwing is the
 * one refusal channel all three share, and it is what makes the gate fail
 * CLOSED — a caller that ignores the result still does not get the body
 * executed, because the body never ran. The dispatchers catch it and translate
 * it into their structured `isOk: false` result so the normal surfaces see the
 * normal shape.
 *
 * `code` is `"not_authorized"`, which the taxonomy classifies as TERMINAL. A
 * denial is not a repair hint: nothing about the arguments was wrong, so the
 * model must not be invited to try the same call with different ones.
 */
export class ActionAuthorizationError extends Error {
  /** Taxonomy code — terminal, see `DISPATCH_ERROR_FAILURE_KINDS`. */
  readonly code: "not_authorized" = "not_authorized";
  /** The action that refused. */
  readonly actionName: string;

  constructor(actionName: string, message: string) {
    super(message);
    this.name = "ActionAuthorizationError";
    this.actionName = actionName;
  }
}

export interface ResolveAuthorizeInput {
  /** The action whose `authorize` gate to resolve. */
  action: AnyEmailAction;
  /**
   * The invocation input. Should already have passed the action's full schema
   * when the option is a predicate — a decision read off an unvalidated
   * payload is not a decision.
   */
  input: unknown;
  /** The caller provenance a predicate-form `authorize` judges. */
  context: ActionContext;
}

/**
 * Resolve an action's authorization for one invocation — BOTH gates, the
 * declared verified-caller requirement and the author's `authorize` hook. An
 * action with neither is allowed, which is what keeps both options additive.
 *
 * This is the READ-ONLY view of the gate, for surfaces that want to explain a
 * refusal before attempting one (e.g. greying out a control). It is NOT how
 * the gate is enforced — enforcement is inside `run` and cannot be skipped by
 * forgetting to call this. The two share {@link findAuthorizationRefusal}, so
 * a surface's preview of the answer and the answer itself cannot drift apart.
 */
export function resolveAuthorize({ action, input, context }: ResolveAuthorizeInput): boolean {
  return findAuthorizationRefusal({ gate: action, input, context }) === null;
}

/**
 * Everything the gate reads off an action. Written structurally so the SAME
 * decision runs against a not-yet-frozen config (inside the factory) and
 * against a frozen action (the read-only `resolveAuthorize` view).
 */
type AuthorizationGate = AnyEmailAction | AnyEmailActionConfig;

interface FindVerifiedCallerRefusalInput {
  /** The action name, for the refusal sentence. */
  name: string;
  /** The action's declared requirement. */
  requirement: VerifiedCallerRequirement;
  /** What the surface established, if it established anything. */
  verifiedCaller: VerifiedCaller | undefined;
}

/**
 * Judge one invocation against a declared verified-caller requirement.
 * Returns the reason it is refused, or null when it may proceed.
 *
 * Every branch is a state some real surface produces, and the four are kept
 * apart on purpose — "nobody established anything" and "this deployment has
 * no identities to establish" are different facts and deserve different
 * sentences, because the fix for each is different.
 */
function findVerifiedCallerRefusal({
  name,
  requirement,
  verifiedCaller,
}: FindVerifiedCallerRefusalInput): string | null {
  if (verifiedCaller === undefined) {
    return `Action "${name}" requires a VERIFIED caller and this invocation carries none. All it carries is self-asserted provenance (\`authorId\`), which any surface writes for itself and nothing checks. The calling surface must establish who is asking — from a signed session token, not from anything the caller supplied — and put the answer on the ActionContext before dispatch.`;
  }
  if (verifiedCaller.isVerified) {
    if (verifiedCaller.ownerId.trim().length === 0) {
      /*
        A surface reporting a verified caller it cannot name has a bug, and
        the one thing that must not happen is that bug reading as a pass.
      */
      return `Action "${name}" was invoked with a verified caller that names nobody (empty ownerId). A verification that cannot say who was verified is not a verification.`;
    }
    return null;
  }
  if (verifiedCaller.reason === "no_identity_system") {
    if (requirement.whenNoIdentitySystem === "allow") {
      return null;
    }
    return `Action "${name}" requires a verified caller and declares whenNoIdentitySystem: "refuse", but this deployment has no identity system at all — nobody signs in here, so NO caller can ever satisfy it. This is a deployment configuration state, not something about this call: enabling identity on this deployment is the only thing that changes the answer.`;
  }
  return `Action "${name}" requires a verified caller. This deployment has an identity system and this caller has no verified session with it, so the server cannot say who is asking.`;
}

interface FindAuthorizationRefusalInput {
  /** The action or config carrying the gates and the name to refuse under. */
  gate: AuthorizationGate;
  /** What `run` is about to be given (already schema-validated). */
  input: unknown;
  /** The caller provenance both gates judge. */
  context: ActionContext;
}

/**
 * THE authorization decision, in one place: the declared verified-caller
 * requirement first, then the author's `authorize` hook. Returns the reason
 * for refusal, or null when the call may proceed.
 *
 * Order matters and is not arbitrary. `authorize` predicates read the context
 * to decide what a caller may do; running one over an identity nobody
 * established asks a question with no subject.
 */
function findAuthorizationRefusal({
  gate,
  input,
  context,
}: FindAuthorizationRefusalInput): string | null {
  const { name, authorize, requiresVerifiedCaller } = gate;
  if (requiresVerifiedCaller !== undefined) {
    const verifiedCallerRefusal = findVerifiedCallerRefusal({
      name,
      requirement: requiresVerifiedCaller,
      verifiedCaller: context.verifiedCaller,
    });
    if (verifiedCallerRefusal !== null) {
      return verifiedCallerRefusal;
    }
  }
  if (authorize === undefined) {
    return null;
  }
  const isAuthorized = typeof authorize === "function" ? authorize(input, context) : authorize;
  if (isAuthorized) {
    return null;
  }
  return `Action "${name}" is not authorized for this caller.`;
}

interface AssertAuthorizedInput {
  /** The config carrying the gates and the name to refuse under. */
  config: AnyEmailActionConfig;
  /** What `run` is about to be given. */
  input: unknown;
  /**
   * The caller provenance. Typed as possibly absent even though the invocation
   * type requires it, for the same reason the factory re-checks the literal
   * `readOnly` invariants: TS callers are already stopped at compile time,
   * JS callers are not.
   */
  context: ActionContext | undefined;
}

/**
 * The gate itself, applied inside every `run` the factory hands out. Returns
 * normally when the call may proceed; throws `ActionAuthorizationError` when
 * it may not. Ungated actions return immediately and pay nothing.
 */
function assertAuthorized({ config, input, context }: AssertAuthorizedInput): void {
  const { authorize, requiresVerifiedCaller, name } = config;
  if (authorize === undefined && requiresVerifiedCaller === undefined) {
    return;
  }
  if (context === undefined) {
    /*
      Fails CLOSED. A caller that will not say who it is has not answered the
      question, and a gate that opens when it cannot see is not a gate.
    */
    throw new ActionAuthorizationError(
      name,
      `Action "${name}" is authorization-gated but was invoked without an ActionContext, so there is no caller to authorize. The calling surface must supply the caller's provenance.`,
    );
  }
  const refusal = findAuthorizationRefusal({ gate: config, input, context });
  if (refusal !== null) {
    throw new ActionAuthorizationError(
      name,
      `${refusal} This is a refusal, not a validation failure — the same call with different arguments is refused too.`,
    );
  }
}

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
  if (config.kind === "editor" && !EDITOR_RESULT_SOURCES.includes(config.resultSource)) {
    throw new Error(
      `defineEmailAction: editor action "${config.name}" must declare resultSource as one of: ${EDITOR_RESULT_SOURCES.join(", ")} — it decides whether the server may answer for this call at all.`,
    );
  }
  /*
    Same shape of check as `resultSource` above, and for the same reason: the
    policy has no safe default, so an action declaring the requirement must
    declare a real answer for the deployment where it can never be met.
  */
  if (
    config.requiresVerifiedCaller !== undefined &&
    !NO_IDENTITY_SYSTEM_POLICIES.includes(config.requiresVerifiedCaller.whenNoIdentitySystem)
  ) {
    throw new Error(
      `defineEmailAction: action "${config.name}" requires a verified caller, so it must declare whenNoIdentitySystem as one of: ${NO_IDENTITY_SYSTEM_POLICIES.join(", ")} — a deployment with no identity system can never satisfy the requirement, and the action has to say what happens there.`,
    );
  }
  if (typeof config.run !== "function") {
    throw new Error(`defineEmailAction: action "${config.name}" needs a run function.`);
  }
  /*
    THE AUTHORIZATION GATE IS COMPOSED INTO `run` HERE — it is deliberately NOT
    a flag on the returned action that dispatchers are trusted to read.

    `needsApproval` took the flag route, and this repo shows the consequence:
    it is honoured only inside the agent loop, where the chat route maps it onto
    the AI SDK's `toolApproval`. Every other caller of the very same action —
    the HTTP route, the editor store, a future MCP mount — reaches the body with
    the flag unread, because nothing forces them to read it. A flag is a
    request. A wrapper is a guarantee.

    `run` is the one thing every dispatch site goes through, so composing the
    check into `run` means there is no caller that can reach the body without
    passing the check. The raw hook is captured in this closure and is never
    copied onto the frozen action, so the ungated path does not exist outside
    this function — not "is discouraged", does not exist.

    If a later change is tempted to simplify this into an `isAuthorized` flag
    the dispatchers consult: that is precisely the defect this replaced, and
    the resulting hole is invisible until a second surface calls the action.
  */
  const agentInputSchema = config.agentInputSchema ?? config.schema;
  if (config.kind === "content") {
    const runContent = config.run;
    return Object.freeze({
      ...config,
      agentInputSchema,
      run: ({ doc, input, context }: DocumentActionInvocation<z.ZodType>) => {
        assertAuthorized({ config, input, context });
        return runContent(doc, input);
      },
    });
  }
  if (config.kind === "editor") {
    const runEditor = config.run;
    return Object.freeze({
      ...config,
      agentInputSchema,
      run: ({ input, context }: ActionInvocation<z.ZodType>) => {
        assertAuthorized({ config, input, context });
        return runEditor(input);
      },
    });
  }
  const runAnalysis = config.run;
  return Object.freeze({
    ...config,
    agentInputSchema,
    run: ({ doc, input, context }: DocumentActionInvocation<z.ZodType>) => {
      assertAuthorized({ config, input, context });
      return runAnalysis(doc, input);
    },
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
