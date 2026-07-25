import { z } from "zod";
import type { RandomFn } from "../schema/ids";
import { operationSchema } from "./ops";

/**
 * Operation log — the append-only history of applied operations.
 *
 * Each entry pairs an operation with its generated inverse plus provenance
 * (who applied it, and which batch it belonged to). Phase 4 persists this log
 * in Convex and builds the SDK-owned undo/redo stack on it (Phase 4.3:
 * `undo`/`redo`/`advanceTo`/`rollbackTo`); one-click revert of an AI batch is
 * `rollbackTo` scoped to a batchId. This module ships only the types and a
 * tiny factory — no persistence.
 */

/** Who authored an operation: a human user or an AI agent. */
export const OPERATION_AUTHORS = ["user", "agent"] as const;

export const operationAuthorSchema = z
  .enum(OPERATION_AUTHORS)
  .describe('Who authored the operation: "user" (a human edit) or "agent" (an AI edit).');

export type OperationAuthor = z.infer<typeof operationAuthorSchema>;

/** One append-only operation log entry. */
export const operationLogEntrySchema = z
  .strictObject({
    id: z
      .string()
      .min(1)
      .describe('Unique id of this log entry, e.g. "ople_a1b2c3d4".'),
    op: operationSchema.describe("The operation that was applied."),
    inverse: operationSchema.describe(
      "The inverse operation generated when `op` was applied; applying it undoes `op` exactly.",
    ),
    authorId: z
      .string()
      .min(1)
      .describe("Stable identifier of the author: a user id, or an agent/thread id for AI edits."),
    author: operationAuthorSchema,
    batchId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Groups entries applied atomically as one batch (e.g. all operations from one AI turn). Batch revert rolls back every entry sharing this id. Omit for standalone operations.",
      ),
    timestamp: z
      .number()
      .int()
      .nonnegative()
      .describe("Creation time in epoch milliseconds."),
  })
  .describe(
    "One entry in the append-only operation log: an applied operation, its exact inverse, and authorship provenance.",
  );

export type OperationLogEntry = z.infer<typeof operationLogEntrySchema>;

const LOG_ENTRY_ID_PREFIX = "ople";
const LOG_ENTRY_ID_SUFFIX_LENGTH = 8;
const LOG_ENTRY_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generate a log entry id: `ople_<8 lowercase alphanumeric>`. Uniqueness is
 * probabilistic (36^8 ≈ 2.8 trillion); persistence (Phase 4) may substitute
 * its own ids via `createLogEntry`'s `id` override.
 */
export function generateLogEntryId(random: RandomFn = Math.random): string {
  let suffix = "";
  for (let i = 0; i < LOG_ENTRY_ID_SUFFIX_LENGTH; i += 1) {
    const index =
      Math.floor(random() * LOG_ENTRY_ID_ALPHABET.length) % LOG_ENTRY_ID_ALPHABET.length;
    suffix += LOG_ENTRY_ID_ALPHABET[index];
  }
  return `${LOG_ENTRY_ID_PREFIX}_${suffix}`;
}

export interface CreateLogEntryInput {
  /** The operation that was applied. */
  op: OperationLogEntry["op"];
  /** The inverse returned by applyOperation when `op` was applied. */
  inverse: OperationLogEntry["inverse"];
  /** Stable identifier of the author (user id or agent/thread id). */
  authorId: string;
  /** Whether a human or an AI agent authored the operation. */
  author: OperationAuthor;
  /** Optional batch grouping id — same value for every op in one atomic batch. */
  batchId?: string;
  /** Override the generated entry id (e.g. persistence-layer ids, tests). */
  id?: string;
  /** Override the timestamp (epoch ms). Defaults to Date.now(). */
  timestamp?: number;
  /** Injectable randomness for deterministic id generation in tests. */
  random?: RandomFn;
}

/** Build one operation log entry, generating id and timestamp when omitted. */
export function createLogEntry(input: CreateLogEntryInput): OperationLogEntry {
  const entry: OperationLogEntry = {
    id: input.id ?? generateLogEntryId(input.random),
    op: input.op,
    inverse: input.inverse,
    authorId: input.authorId,
    author: input.author,
    timestamp: input.timestamp ?? Date.now(),
  };
  if (input.batchId !== undefined) {
    entry.batchId = input.batchId;
  }
  return entry;
}
