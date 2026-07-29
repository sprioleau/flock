import type { Operation } from "@tandem/email-sdk";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";

/**
 * Pure presentation helpers for the History panel: turning the flat
 * `documents.getOperations` log into newest-first display groups, and
 * describing rows in human terms. No React, no I/O.
 */

/** One row of the getOperations page payload (typed off the query itself). */
export type OperationEntry = FunctionReturnType<
  typeof api.documents.getOperations
>["operations"][number];

/**
 * One display row: a run of consecutive operations sharing a defined batchId
 * (an agent turn, a batch revert, a rollback), or a single unbatched op.
 */
export interface HistoryGroup {
  /** Newest version in the group — the group's identity and its preview/restore target. */
  latestVersion: number;
  /** Shared batchId, or null for a single unbatched op. */
  batchId: string | null;
  /** The group's entries, newest first. */
  entries: OperationEntry[];
}

/**
 * Collapse an ASCENDING operation list into newest-first groups: consecutive
 * ops sharing the same defined batchId become one group; every other op is
 * its own group.
 */
export function buildHistoryGroups(operationsAscending: OperationEntry[]): HistoryGroup[] {
  const groups: HistoryGroup[] = [];
  for (let index = operationsAscending.length - 1; index >= 0; index -= 1) {
    const entry = operationsAscending[index]!;
    const batchId = entry.batchId ?? null;
    const currentGroup = groups[groups.length - 1];
    const isSameBatch =
      batchId !== null && currentGroup !== undefined && currentGroup.batchId === batchId;
    if (isSameBatch) {
      currentGroup.entries.push(entry);
    } else {
      groups.push({ latestVersion: entry.version, batchId, entries: [entry] });
    }
  }
  return groups;
}

/** Short human description of one op: its name plus the block it targeted. */
export function describeOperation(rawOp: unknown): string {
  const op = rawOp as Operation & { section?: { id?: string }; block?: { id?: string } };
  const targetId =
    "blockId" in op && typeof op.blockId === "string"
      ? op.blockId
      : op.section?.id ?? op.block?.id;
  return targetId !== undefined ? `${op.name} ${targetId}` : op.name;
}

/** Row label for a single (unbatched) entry, with undo/redo called out distinctly. */
export function describeEntry(entry: OperationEntry): string {
  if (entry.kind === "undo") {
    return entry.undoesVersion !== undefined
      ? `Undo (v${entry.undoesVersion})`
      : "Undo";
  }
  if (entry.kind === "redo") {
    return entry.redoesVersion !== undefined
      ? `Redo (v${entry.redoesVersion})`
      : "Redo";
  }
  return describeOperation(entry.op);
}

/** Title for a multi-op (or specially-named) batch group. */
export function describeGroup(group: HistoryGroup): string {
  if (group.batchId !== null && group.batchId.startsWith("rollback:")) {
    const targetVersion = group.batchId.slice("rollback:".length);
    return `Restored to version ${targetVersion}`;
  }
  if (group.batchId !== null && group.batchId.startsWith("revert:")) {
    return "Reverted agent changes";
  }
  if (group.entries.length === 1) {
    return describeEntry(group.entries[0]!);
  }
  return `${group.entries.length} edits`;
}

/** Author badge text for a group ("You" needs the viewer's own authorId). */
export function getGroupAuthorLabel({
  group,
  viewerAuthorId,
}: {
  group: HistoryGroup;
  viewerAuthorId: string | null;
}): "Agent" | "You" | "User" {
  const newestEntry = group.entries[0]!;
  if (newestEntry.author === "agent") {
    return "Agent";
  }
  return viewerAuthorId !== null && newestEntry.authorId === viewerAuthorId ? "You" : "User";
}

/** Compact relative timestamp ("just now", "5m ago", "2h ago", "3d ago"). */
export function formatRelativeTime(timestampMs: number, nowMs: number = Date.now()): string {
  const elapsedMs = Math.max(0, nowMs - timestampMs);
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 10) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
