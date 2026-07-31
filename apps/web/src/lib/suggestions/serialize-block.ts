import type { Block } from "@tandem/email-sdk";

/**
 * Staleness-baseline serialization, shared by BOTH sides of the persona
 * findings pipeline:
 *
 * - client (use-suggestions.ts, use-persona-advisors.ts): serialize a target
 *   block from the rendered doc and compare against the snapshot taken when
 *   the suggestion/finding was generated — any mismatch invalidates it.
 * - server (/api/personas): serialize each target block of a finding from
 *   the SAME doc snapshot its ops were dry-run against, and persist those
 *   strings in `personaFindings.targetSnapshots` so every tab shares one
 *   staleness baseline.
 *
 * Deliberately NOT a "use client" module: the API route imports it too, and
 * both sides MUST produce byte-identical output for the comparison to mean
 * anything — this file is the single implementation.
 */

/**
 * Key-order-insensitive serialization for staleness comparison. The locally
 * applied doc and its server-snapshot rebase hold semantically identical
 * blocks whose object key ORDER can differ (Convex normalizes field order on
 * write), so plain JSON.stringify would false-positive every snapshot.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** Staleness baseline serialization of one block (undefined = block missing). */
export const serializeBlock = (block: Block | undefined): string | undefined =>
  block === undefined ? undefined : stableStringify(block);
