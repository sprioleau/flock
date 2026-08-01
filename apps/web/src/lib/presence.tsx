"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import usePresence from "@convex-dev/presence/react";
import { useConvex, type ConvexReactClient } from "convex/react";
import { api } from "@convex/_generated/api";
import { useEditorStore } from "@/lib/editor-store";
import { getOrCreateSessionId } from "@/lib/session";

/**
 * Phase 6.2a — the client presence module. THE CONTRACT for Phase 6.2b (live
 * text cursors) and every other presence consumer:
 *
 * - one presence room per DOCUMENT (roomId = the Convex document id string);
 * - userId = the Flock anonymous session id (two tabs of one browser are one
 *   roster user with two component sessions — the `data` payload is shared,
 *   last write wins);
 * - {@link PresenceProvider} is mounted ONCE at the studio shell level while
 *   a document is open; consumers use {@link usePresenceRoster} (read) and
 *   {@link useBroadcastPresence} (write).
 *
 * Broadcast semantics: the returned function merges a PARTIAL payload into
 * this user's full PresenceData and sends it via updateRoomUser, throttled
 * (~200ms trailing) and single-flighted, skipping no-op writes. Passing a key
 * with value `undefined` CLEARS that key (e.g.
 * `broadcast({ selection: undefined })` on blur). This throttle is network
 * cost control on presence writes only — never user-visible feedback (owner
 * latency law).
 *
 * Identity (name/color, nickname override) is initialized and broadcast by
 * the provider itself; the provider also owns broadcasting `editingBlockId`
 * and `selectedBlockId` for THIS human (from the editor store's text-editing
 * session and canvas selection). 6.2b owns only the `selection` field.
 */

export interface PresenceData {
  name: string;
  color: string;
  isAgent?: boolean;
  /**
   * Live lifecycle status for non-human roster members (multi-agent canvas
   * v0 — persona presence, userId prefix `persona:`). Written server-side on
   * state TRANSITIONS only (convex/personas.ts): "reading" while the runner
   * assembles document context, "thinking" while its batched analysis call is
   * in flight, "idle" otherwise. Humans never broadcast this field.
   */
  status?: "idle" | "reading" | "thinking";
  /** Block whose inline editor this user has open (or the agent is mutating). */
  editingBlockId?: string;
  /**
   * Block this user has SELECTED on the canvas (any block type — divider,
   * image, section, …). Weaker signal than editingBlockId; when a user both
   * selects and edits one block, the editing treatment wins in the UI.
   */
  selectedBlockId?: string;
  /** Live text selection inside a block's synced ProseMirror doc (6.2b). */
  selection?: {
    blockId: string;
    anchor: number;
    head: number;
    version?: number;
  };
  /**
   * Live mouse pointer on the editing canvas (pointer presence). `x`/`y` are
   * 0..1 fractions of the anchor rect: the innermost `[data-block-id]`
   * element under the pointer, or the `[data-dnd-canvas-root]` surface when
   * `blockId` is null (off-block hover). Block anchoring makes the position
   * land on the same CONTENT across clients with different canvas widths.
   * The sender clears this key (broadcasts `pointer: undefined`) on canvas
   * leave, window blur, and pointer idle.
   */
  pointer?: {
    blockId: string | null;
    x: number;
    y: number;
  };
}

export interface PresenceRosterEntry {
  userId: string;
  isSelf: boolean;
  isOnline: boolean;
  data: PresenceData;
}

/** Trailing-throttle window for updateRoomUser writes. */
const BROADCAST_THROTTLE_MS = 200;

/** localStorage key for the user-chosen nickname override. */
export const DISPLAY_NAME_STORAGE_KEY = "flock_display_name";

// ---------------------------------------------------------------------------
// Derived identity: stable adjective-animal name + hue from the session id
// ---------------------------------------------------------------------------

const IDENTITY_ADJECTIVES = [
  "Amber",
  "Bold",
  "Brisk",
  "Calm",
  "Clever",
  "Cosmic",
  "Deft",
  "Gentle",
  "Keen",
  "Lively",
  "Lucky",
  "Mellow",
  "Nimble",
  "Quiet",
  "Swift",
  "Witty",
] as const;

const IDENTITY_ANIMALS = [
  "Badger",
  "Falcon",
  "Fox",
  "Heron",
  "Ibex",
  "Lynx",
  "Marmot",
  "Narwhal",
  "Otter",
  "Owl",
  "Panda",
  "Puffin",
  "Quokka",
  "Raven",
  "Tapir",
  "Wren",
] as const;

/** FNV-1a 32-bit — tiny, stable, good enough spread for names and hues. */
function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Stable auto-generated identity for any presence userId (self or remote):
 * same id → same adjective-animal name and same hue, on every client.
 */
export function deriveIdentity(userId: string): { name: string; color: string } {
  const hash = hashString(userId);
  const adjective = IDENTITY_ADJECTIVES[hash % IDENTITY_ADJECTIVES.length];
  const animal = IDENTITY_ANIMALS[(hash >>> 5) % IDENTITY_ANIMALS.length];
  const hue = (hash >>> 10) % 360;
  return { name: `${adjective} ${animal}`, color: `hsl(${hue} 70% 45%)` };
}

function readStoredNickname(): string | null {
  const stored = window.localStorage.getItem(DISPLAY_NAME_STORAGE_KEY);
  return stored !== null && stored.trim().length > 0 ? stored.trim() : null;
}

// ---------------------------------------------------------------------------
// Throttled + single-flighted updateRoomUser writer
// ---------------------------------------------------------------------------

/**
 * Module-level factory (NOT a hook) for the presence write path: trailing
 * throttle (~200ms), single-flight (at most one mutation in the air; a write
 * requested mid-flight re-schedules once), and no-op skipping (the serialized
 * payload most recently accepted by the server is remembered in
 * `lastSentRef`; setting it to null forces a resend).
 */
interface ThrottledPresenceSender {
  schedule: () => void;
  cancel: () => void;
}

function createThrottledPresenceSender({
  convexClient,
  roomId,
  userId,
  payloadRef,
  lastSentRef,
}: {
  convexClient: ConvexReactClient;
  roomId: string;
  userId: string;
  payloadRef: RefObject<PresenceData | null>;
  lastSentRef: RefObject<string | null>;
}): ThrottledPresenceSender {
  let timerId: number | null = null;
  let isSendInFlight = false;
  let hasPendingSend = false;

  const flush = async (): Promise<void> => {
    if (isSendInFlight) {
      hasPendingSend = true;
      return;
    }
    if (payloadRef.current === null) {
      return;
    }
    // ONE source of truth for the display name, resolved AT SEND TIME:
    // localStorage nickname override, else the session-derived name. Never
    // trust the in-memory copy — a tab whose payload was captured before a
    // rename in another tab would otherwise re-broadcast the old name and
    // make the avatar oscillate (two-tabs-one-user share one payload row).
    const resolvedName = readStoredNickname() ?? deriveIdentity(userId).name;
    if (payloadRef.current.name !== resolvedName) {
      payloadRef.current = { ...payloadRef.current, name: resolvedName };
    }
    const payload = payloadRef.current;
    const serialized = JSON.stringify(payload);
    if (serialized === lastSentRef.current) {
      return; // no-op write, skip
    }
    isSendInFlight = true;
    try {
      await convexClient.mutation(api.presence.updateRoomUser, {
        roomId,
        userId,
        data: payload,
      });
      lastSentRef.current = serialized;
    } catch (error) {
      console.warn("[presence] updateRoomUser failed", error);
    } finally {
      isSendInFlight = false;
      if (hasPendingSend) {
        hasPendingSend = false;
        schedule();
      }
    }
  };

  const schedule = (): void => {
    if (timerId !== null) {
      return;
    }
    timerId = window.setTimeout(() => {
      timerId = null;
      void flush();
    }, BROADCAST_THROTTLE_MS);
  };

  const cancel = (): void => {
    if (timerId !== null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
  };

  return { schedule, cancel };
}

// ---------------------------------------------------------------------------
// Provider + hooks
// ---------------------------------------------------------------------------

interface PresenceContextValue {
  roster: PresenceRosterEntry[];
  broadcast: (partial: Partial<PresenceData>) => void;
  /** Persist a nickname override (empty string reverts to the derived name) and broadcast it. */
  setNickname: (nickname: string) => void;
}

const PresenceContext = createContext<PresenceContextValue | null>(null);

export function PresenceProvider({
  documentId,
  children,
}: {
  /** The Convex document id string — the presence room. */
  documentId: string;
  children: React.ReactNode;
}) {
  const convexClient = useConvex();
  const [sessionId] = useState(() => getOrCreateSessionId());
  const [initialIdentity] = useState<PresenceData>(() => {
    const derived = deriveIdentity(getOrCreateSessionId());
    return { ...derived, name: readStoredNickname() ?? derived.name };
  });

  // The full local payload, merged across broadcasts. Identity first.
  const payloadRef = useRef<PresenceData | null>(initialIdentity);

  const presenceState = usePresence(api.presence, documentId, sessionId);

  // --- throttled + single-flighted updateRoomUser writes ---
  // The serialized payload most recently ACCEPTED by the server (null forces
  // a resend — e.g. writes dropped before our first heartbeat landed).
  const lastSentRef = useRef<string | null>(null);

  // One throttle controller per (client, room, user), created LAZILY from
  // event handlers/effects (never during render — React Compiler contract);
  // the mutable timer / in-flight state lives in a module-level factory
  // closure (see {@link createThrottledPresenceSender}).
  const senderRef = useRef<{ key: string; sender: ThrottledPresenceSender } | null>(null);
  const scheduleFlush = useCallback((): void => {
    const key = `${documentId}|${sessionId}`;
    if (senderRef.current === null || senderRef.current.key !== key) {
      senderRef.current?.sender.cancel();
      senderRef.current = {
        key,
        sender: createThrottledPresenceSender({
          convexClient,
          roomId: documentId,
          userId: sessionId,
          payloadRef,
          lastSentRef,
        }),
      };
    }
    senderRef.current.sender.schedule();
  }, [convexClient, documentId, sessionId]);

  useEffect(() => {
    // A new room (document switch) has no memory of what we sent to the old
    // one; also drop any timer still aimed at the previous room on unmount.
    lastSentRef.current = null;
    return () => {
      senderRef.current?.sender.cancel();
      senderRef.current = null;
    };
  }, [documentId, sessionId]);

  const broadcast = useCallback(
    (partial: Partial<PresenceData>): void => {
      const current = payloadRef.current;
      if (current === null) {
        return;
      }
      const next: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(partial)) {
        if (value === undefined) {
          delete next[key];
        } else {
          next[key] = value;
        }
      }
      payloadRef.current = next as unknown as PresenceData;
      scheduleFlush();
    },
    [scheduleFlush],
  );

  // Bootstrap convergence: updateRoomUser silently drops writes until the
  // first heartbeat creates our presence row, so if our self entry ever shows
  // up with NO data at all (fresh room, dropped first write), force a resend
  // of the full merged payload. Deliberately narrow — it never compares field
  // values, because two tabs of one user share one payload and value-level
  // "corrections" make the tabs clobber each other forever (each tab would
  // re-assert its own stale copy).
  const isSelfServerDataMissing =
    presenceState !== undefined &&
    presenceState.some((entry) => entry.userId === sessionId && entry.data === undefined);
  useEffect(() => {
    if (isSelfServerDataMissing) {
      lastSentRef.current = null; // an earlier write was dropped server-side
      scheduleFlush();
    }
  }, [isSelfServerDataMissing, scheduleFlush]);

  // Cross-tab nickname sync: when ANOTHER tab of this browser saves a
  // nickname (`storage` fires only in the tabs that didn't write), adopt it
  // into the local payload SILENTLY — the writing tab already broadcast it,
  // and rebroadcasting from here would clobber that tab's ephemeral fields
  // (its editingBlockId) with this tab's copy.
  useEffect(() => {
    const handleStorage = (event: StorageEvent): void => {
      if (event.key !== DISPLAY_NAME_STORAGE_KEY) {
        return;
      }
      const current = payloadRef.current;
      if (current === null) {
        return;
      }
      const nickname = event.newValue !== null && event.newValue.trim().length > 0
        ? event.newValue.trim()
        : null;
      payloadRef.current = { ...current, name: nickname ?? deriveIdentity(sessionId).name };
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [sessionId]);

  // This provider OWNS the human editingBlockId/selectedBlockId signals:
  // broadcast when this client's inline text-editing session opens/closes or
  // its canvas selection changes (read-only store subscriptions; the store
  // itself is never touched from here).
  const editingBlockId = useEditorStore((state) => state.editingBlockId);
  useEffect(() => {
    broadcast({ editingBlockId: editingBlockId ?? undefined });
  }, [editingBlockId, broadcast]);
  const selectedBlockId = useEditorStore((state) => state.selectedBlockId);
  useEffect(() => {
    broadcast({ selectedBlockId: selectedBlockId ?? undefined });
  }, [selectedBlockId, broadcast]);

  const setNickname = useCallback(
    (nickname: string): void => {
      const trimmed = nickname.trim();
      if (trimmed.length > 0) {
        window.localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, trimmed);
      } else {
        window.localStorage.removeItem(DISPLAY_NAME_STORAGE_KEY);
      }
      broadcast({ name: trimmed.length > 0 ? trimmed : deriveIdentity(sessionId).name });
    },
    [broadcast, sessionId],
  );

  const roster = useMemo<PresenceRosterEntry[]>(() => {
    return (presenceState ?? []).map((entry) => {
      const fallback = deriveIdentity(entry.userId);
      const data = (entry.data ?? {}) as Partial<PresenceData>;
      return {
        userId: entry.userId,
        isSelf: entry.userId === sessionId,
        isOnline: entry.online,
        data: { ...data, name: data.name ?? fallback.name, color: data.color ?? fallback.color },
      };
    });
  }, [presenceState, sessionId]);

  const contextValue = useMemo<PresenceContextValue>(
    () => ({ roster, broadcast, setNickname }),
    [roster, broadcast, setNickname],
  );

  return <PresenceContext.Provider value={contextValue}>{children}</PresenceContext.Provider>;
}

function usePresenceContext(hookName: string): PresenceContextValue {
  const context = useContext(PresenceContext);
  if (context === null) {
    throw new Error(`${hookName} must be used inside a <PresenceProvider>.`);
  }
  return context;
}

/**
 * The live roster for the open document: every known room member (self
 * first, per the component's ordering), with online/offline state and the
 * normalized PresenceData payload (name/color always present — derived
 * fallback when the member hasn't broadcast yet).
 */
export function usePresenceRoster(): PresenceRosterEntry[] {
  return usePresenceContext("usePresenceRoster").roster;
}

/**
 * Write half of the contract: merge a partial PresenceData into this user's
 * payload and send it (throttled ~200ms trailing, single-flighted, no-op
 * writes skipped). `undefined` values clear their key.
 */
export function useBroadcastPresence(): (partial: Partial<PresenceData>) => void {
  return usePresenceContext("useBroadcastPresence").broadcast;
}

/** Persist + broadcast a nickname override (empty string reverts to the derived name). */
export function useSetNickname(): (nickname: string) => void {
  return usePresenceContext("useSetNickname").setNickname;
}

/**
 * Non-throwing roster read for chrome that may render outside an open
 * document (returns null when no provider is mounted).
 */
export function useOptionalPresenceRoster(): PresenceRosterEntry[] | null {
  return useContext(PresenceContext)?.roster ?? null;
}
