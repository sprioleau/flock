"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConvex } from "convex/react";
import type { EmailDocument } from "@tandem/email-sdk";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { OperationEntry } from "../history/history-grouping";

/**
 * Data layer for time-travel replay: reconstructed documents by version
 * (small LRU over one-off `getDocumentAtVersion` queries, aggressively
 * prefetched around the playhead) plus the full op list for captions.
 *
 * Prefetch strategy (owner law: no debounce — warm instead):
 * - Small histories (head ≤ EAGER_FULL_PREFETCH_MAX_HEAD) are warmed in FULL
 *   the moment the panel opens, so every scrub position is a synchronous
 *   cache hit.
 * - Larger histories warm a sliding window around the playhead on every
 *   playhead change: PREFETCH_AHEAD_COUNT versions ahead (playback + forward
 *   scrub) and PREFETCH_BEHIND_COUNT behind (backward scrub).
 * - In-flight versions are tracked so a fast drag never issues duplicate
 *   queries; each reconstruction is server-bounded (snapshot + ≤ interval
 *   ops) so repeats are cheap anyway.
 *
 * Memory is bounded by the LRU cap; nothing else retains reconstructions.
 * Cache entries are keyed by `documentId:version`, so a document switch
 * never needs an explicit reset (stale entries just age out of the LRU).
 * Render paths read the state-backed map via `getDocAtVersion`; interval and
 * effect paths use the stable `hasVersion`/`ensureVersion` callbacks
 * (ref-backed key mirrors, never touched during render).
 */

const OPERATIONS_PAGE_SIZE = 200;
const MAX_OPERATION_PAGES = 50;
/** LRU cap on cached reconstructions. */
const RECONSTRUCTION_CACHE_SIZE = 64;
/** Versions warmed ahead of the playhead (≥ 2s of 2x playback buffer). */
const PREFETCH_AHEAD_COUNT = 8;
/** Versions warmed behind the playhead for backward scrubbing. */
const PREFETCH_BEHIND_COUNT = 2;
/** Histories up to this head are fully warmed when the panel opens. */
const EAGER_FULL_PREFETCH_MAX_HEAD = 48;

function toCacheKey(documentId: Id<"documents">, version: number): string {
  return `${documentId}:${version}`;
}

export interface ReplayTimeline {
  /** Cached reconstruction for a version of the CURRENT document, if warm. */
  getDocAtVersion: (version: number) => EmailDocument | null;
  /** Whether a version is already cached (stable; safe inside intervals). */
  hasVersion: (version: number) => boolean;
  /** Start fetching one version if it isn't cached or already in flight. */
  ensureVersion: (version: number) => void;
  /** Warm the prefetch window around the playhead. */
  prefetchAround: (version: number) => void;
  /** version → op-log entry, once loaded (null while loading). */
  operationsByVersion: Map<number, OperationEntry> | null;
}

export function useReplayTimeline({
  documentId,
  headVersion,
  isOpen,
}: {
  documentId: Id<"documents"> | null;
  /** The scrubber's upper bound — captured by the panel when it opens. */
  headVersion: number;
  isOpen: boolean;
}): ReplayTimeline {
  const convexClient = useConvex();
  const [docsByCacheKey, setDocsByCacheKey] = useState<Map<string, EmailDocument>>(
    () => new Map(),
  );
  const [operationsState, setOperationsState] = useState<{
    documentId: Id<"documents">;
    entries: Map<number, OperationEntry>;
  } | null>(null);

  /** Mirror of the cache's keys, for synchronous checks in callbacks. */
  const knownCacheKeysRef = useRef<Set<string>>(new Set());
  const inFlightCacheKeysRef = useRef<Set<string>>(new Set());

  const hasVersion = useCallback(
    (version: number): boolean =>
      documentId !== null && knownCacheKeysRef.current.has(toCacheKey(documentId, version)),
    [documentId],
  );

  const ensureVersion = useCallback(
    (version: number): void => {
      if (documentId === null || version < 0 || version > headVersion) {
        return;
      }
      const cacheKey = toCacheKey(documentId, version);
      if (
        knownCacheKeysRef.current.has(cacheKey) ||
        inFlightCacheKeysRef.current.has(cacheKey)
      ) {
        return;
      }
      inFlightCacheKeysRef.current.add(cacheKey);
      convexClient
        .query(api.documents.getDocumentAtVersion, { documentId, version })
        .then((result) => {
          if (result === null) {
            return;
          }
          const doc = result.doc as EmailDocument;
          setDocsByCacheKey((current) => {
            const next = new Map(current);
            next.delete(cacheKey);
            next.set(cacheKey, doc);
            while (next.size > RECONSTRUCTION_CACHE_SIZE) {
              const oldestKey = next.keys().next().value;
              if (oldestKey === undefined) {
                break;
              }
              next.delete(oldestKey);
              knownCacheKeysRef.current.delete(oldestKey);
            }
            knownCacheKeysRef.current.add(cacheKey);
            return next;
          });
        })
        .catch(() => {
          // Prefetch failures are non-fatal; a later ensureVersion retries.
        })
        .finally(() => {
          inFlightCacheKeysRef.current.delete(cacheKey);
        });
    },
    [convexClient, documentId, headVersion],
  );

  const prefetchAround = useCallback(
    (version: number): void => {
      const aheadEnd = Math.min(headVersion, version + PREFETCH_AHEAD_COUNT);
      for (let target = version; target <= aheadEnd; target += 1) {
        ensureVersion(target);
      }
      const behindStart = Math.max(0, version - PREFETCH_BEHIND_COUNT);
      for (let target = behindStart; target < version; target += 1) {
        ensureVersion(target);
      }
    },
    [ensureVersion, headVersion],
  );

  // Small histories: warm the whole timeline at open, so scrubbing anywhere
  // is a synchronous cache hit.
  useEffect(() => {
    if (!isOpen || documentId === null || headVersion > EAGER_FULL_PREFETCH_MAX_HEAD) {
      return;
    }
    for (let version = 0; version <= headVersion; version += 1) {
      ensureVersion(version);
    }
  }, [isOpen, documentId, headVersion, ensureVersion]);

  // Page the full op list once per open, for captions + author colors.
  useEffect(() => {
    if (!isOpen || documentId === null) {
      return;
    }
    let isCancelled = false;
    const loadOperations = async (): Promise<void> => {
      const entries = new Map<number, OperationEntry>();
      let sinceVersion = 0;
      for (let pageIndex = 0; pageIndex < MAX_OPERATION_PAGES; pageIndex += 1) {
        const page = await convexClient.query(api.documents.getOperations, {
          documentId,
          sinceVersion,
          limit: OPERATIONS_PAGE_SIZE,
        });
        if (isCancelled) {
          return;
        }
        for (const entry of page.operations) {
          entries.set(entry.version, entry);
        }
        sinceVersion = page.nextSinceVersion;
        if (page.isDone) {
          break;
        }
      }
      setOperationsState({ documentId, entries });
    };
    loadOperations().catch(() => {
      // Captions are decorative; the scrubber still works without them.
    });
    return () => {
      isCancelled = true;
    };
  }, [isOpen, documentId, convexClient]);

  const getDocAtVersion = (version: number): EmailDocument | null =>
    documentId === null
      ? null
      : (docsByCacheKey.get(toCacheKey(documentId, version)) ?? null);

  const operationsByVersion =
    operationsState !== null && operationsState.documentId === documentId
      ? operationsState.entries
      : null;

  return { getDocAtVersion, hasVersion, ensureVersion, prefetchAround, operationsByVersion };
}
