import type { OperationErrorCode } from "../operations/apply";

/**
 * Stop-vs-retry error taxonomy (plan §9.4 item 5, agent-native's
 * `AgentActionStopError` equivalent).
 *
 * When an action fails, the agent loop must decide between two moves:
 *
 * - `"retryable"` — feed the structured error messages back to the model for
 *   ONE repair round-trip (Phase 3.3's validation gate). Every 1.3 error
 *   message is written as a repair hint, and the model holds a document view,
 *   so addressing mistakes (bad ids, bad indices, wrong types, nesting rules)
 *   are all correctable in a single follow-up.
 * - `"terminal"` — stop the turn and surface the failure to the user. Reserved
 *   for internal invariant breaches the model cannot repair by changing its
 *   input.
 *
 * Exported as plain data so Phase 3 can tune the mapping (e.g. demote a code
 * to terminal after observing unproductive repair rounds) without touching
 * dispatch logic.
 */

export type ActionFailureKind = "retryable" | "terminal";

/**
 * Failure kind for every 1.3 operation error code.
 *
 * Rationale per code:
 * - Validation failures (`op_validation_failed`, `schema_validation_failed`,
 *   `children_not_permutation`, `index_out_of_range`) — the payload was wrong;
 *   the error message says how. Retryable.
 * - Addressing/structure mistakes (`target_not_found`, `nesting_violation`,
 *   `root_not_allowed`, `duplicate_block_id`, `wrong_block_type`) — also
 *   retryable: with the document view in context the model can pick a valid
 *   target, id, or parent on the repair round.
 * - `integrity_check_failed` — the op passed its own checks but the RESULTING
 *   document broke referential integrity. That is an internal invariant breach
 *   (or a structurally unsound input document), not an input the model can
 *   repair. Terminal.
 */
export const OPERATION_ERROR_FAILURE_KINDS = {
  op_validation_failed: "retryable",
  schema_validation_failed: "retryable",
  children_not_permutation: "retryable",
  index_out_of_range: "retryable",
  target_not_found: "retryable",
  nesting_violation: "retryable",
  root_not_allowed: "retryable",
  duplicate_block_id: "retryable",
  wrong_block_type: "retryable",
  integrity_check_failed: "terminal",
} as const satisfies Record<OperationErrorCode, ActionFailureKind>;

/** Failure codes the dispatch layer itself can add on top of the 1.3 op codes. */
export const DISPATCH_ERROR_FAILURE_KINDS = {
  /** No action with that name — the model can pick from the advertised tool list. */
  unknown_action: "retryable",
  /** The action exists but was routed through the wrong dispatcher (e.g. an
   * editor action through `dispatchContentAction`). A wiring bug, not a
   * payload the model can repair. */
  wrong_action_kind: "terminal",
} as const satisfies Record<string, ActionFailureKind>;

export type ActionDispatchErrorCode = OperationErrorCode | keyof typeof DISPATCH_ERROR_FAILURE_KINDS;

/** The full code → failure-kind map the dispatchers classify with. */
export const ACTION_ERROR_FAILURE_KINDS: Record<ActionDispatchErrorCode, ActionFailureKind> = {
  ...OPERATION_ERROR_FAILURE_KINDS,
  ...DISPATCH_ERROR_FAILURE_KINDS,
};

/**
 * Classify a failed dispatch: terminal if ANY error is terminal (one invariant
 * breach poisons the batch), retryable otherwise.
 */
export function classifyActionErrors(
  errors: readonly { code: ActionDispatchErrorCode }[],
): ActionFailureKind {
  const hasTerminalError = errors.some(
    (error) => ACTION_ERROR_FAILURE_KINDS[error.code] === "terminal",
  );
  return hasTerminalError ? "terminal" : "retryable";
}
