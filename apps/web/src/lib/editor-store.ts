import {
  applyOperation,
  dispatchContentAction,
  emailActionRegistry,
  createEmptyDocument,
  type ActionContext,
  type BlockId,
  type DispatchContentActionResult,
  type EmailDocument,
  type Operation,
  type PreviewMode,
} from "@tandem/email-sdk";
import type { ConvexReactClient } from "convex/react";
import { create } from "zustand";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

/**
 * The Phase 4 document store — Convex is the source of truth; this store is
 * the instant-feedback layer over it.
 *
 * THE INVARIANT (docs/email-editor-phased-plan.md §7) still holds: every
 * document mutation flows through the SDK's action layer. `dispatch` remains
 * the ONLY mutation entry point — it applies the op LOCALLY first (zero
 * input-path latency: color drags and number bursts never wait on a network
 * round-trip), then forwards the settled op to Convex `applyOperations`.
 *
 * Sync model — "local overlay, server-rebased" (chosen over Convex
 * `.withOptimisticUpdate` because optimistic updates only run per MUTATION
 * call, and a color drag produces ~60 local applies per second but exactly
 * ONE Convex op per settled gesture; the input path must update the doc
 * without issuing a mutation at all):
 *
 * - `serverDoc`/`serverHeadVersion` mirror the reactive `getDocument` query
 *   (fed by StudioShell via {@link EditorState.applyServerSnapshot}).
 * - `doc` (what components render) = serverDoc + every pending local op
 *   replayed on top. Local dispatches update it in place; server snapshots
 *   rebase it.
 * - `pendingOps` is the outbound overlay: ops HELD during an open gesture
 *   (see {@link UNDO_COALESCE_WINDOW_MS}), ops in flight to Convex, and ops
 *   acked but not yet visible in the query snapshot. An op leaves the overlay
 *   only when the server snapshot's headVersion covers its acked version —
 *   so the rendered doc never regresses between ack and snapshot delivery.
 * - Ordering: Convex executes one client's mutations in submission order, and
 *   a held gesture is always flushed before any newer op (or an undo/redo/
 *   revert) is submitted, so the server log matches the local apply order.
 *
 * History — one spine, on the server: undo/redo call `history.undo`/`redo`
 * (per-author; authorId = the anonymous session id), and AI-batch revert
 * calls `history.revertBatch`. The old local undo/redo stacks are gone;
 * button enablement comes from the reactive `history.canUndoRedo` query.
 */

/** Default provenance for ops produced by this UI's own controls. */
const LOCAL_ACTION_CONTEXT: Omit<ActionContext, "authorId"> = {
  caller: "frontend",
  author: "user",
};

/**
 * Per-dispatch provenance overrides. The chat panel passes `{ caller: "tool",
 * author: "agent", authorId: <chat id>, batchId: <turn batch id>, threadId }`
 * so agent-applied ops land in Convex with agent authorship and one shared
 * batchId per assistant turn (the AI-batch revert affordance hangs off it).
 */
export type DispatchProvenance = Partial<ActionContext>;

export type Viewport = PreviewMode;

/**
 * Gesture-settling window. Property-panel inputs dispatch on EVERY input
 * event so the canvas tracks in real time (color drags fire ~16ms apart);
 * consecutive ops hitting the same block + operation + property key set
 * within this window are ONE gesture: the held outbound op is replaced by the
 * latest forward op, and only the settled op is sent to Convex. A gesture
 * ends when the window lapses, the field blurs (endCoalescing), or a
 * different target or property is edited. One gesture = one Convex op = one
 * server-side undo step.
 */
export const UNDO_COALESCE_WINDOW_MS = 120;

/** Coalesce key for an op, or null when the op never coalesces. */
function getCoalesceKey(op: Operation): string | null {
  if (op.name === "updateBlockProperties") {
    return `updateBlockProperties:${op.blockId}:${Object.keys(op.properties).sort().join(",")}`;
  }
  if (op.name === "updateDocumentSettings") {
    return `updateDocumentSettings:${Object.keys(op.globals).sort().join(",")}`;
  }
  return null;
}

/** One op in the outbound overlay (held, in flight, or acked-awaiting-snapshot). */
interface PendingOp {
  /** Local identity (server versions don't exist until the ack). */
  clientId: string;
  op: Operation;
  context: ActionContext;
  /** True while the op is held open for gesture coalescing (not yet sent). */
  isHeld: boolean;
  /** Discriminates the gesture: op name + target + sorted property keys. */
  coalesceKey: string | null;
  /** Timestamp of the gesture's most recent dispatch (epoch ms). */
  lastDispatchedAt: number;
  /** Server headVersion after this op, once the mutation acked (null before). */
  confirmedVersion: number | null;
}

/** Replay the still-pending overlay onto a server doc (dropping covered/conflicting ops). */
function rebasePendingOps({
  serverDoc,
  serverHeadVersion,
  pendingOps,
}: {
  serverDoc: EmailDocument;
  serverHeadVersion: number;
  pendingOps: PendingOp[];
}): { doc: EmailDocument; pendingOps: PendingOp[] } {
  let doc = serverDoc;
  const remaining: PendingOp[] = [];
  for (const pending of pendingOps) {
    const isCoveredByServer =
      pending.confirmedVersion !== null && pending.confirmedVersion <= serverHeadVersion;
    if (isCoveredByServer) {
      continue;
    }
    const result = applyOperation(doc, pending.op);
    if (result.isOk) {
      doc = result.doc;
      remaining.push(pending);
    } else {
      // A remote edit invalidated this not-yet-applied local op (e.g. the
      // target block was deleted in another tab). Drop it; the server wins.
      console.warn(`pending ${pending.op.name} no longer applies after rebase; dropped`);
    }
  }
  return { doc, pendingOps: remaining };
}

const HISTORY_FAILURE_MESSAGES: Record<string, string> = {
  nothing_to_undo: "Nothing to undo.",
  nothing_to_redo: "Nothing to redo.",
  conflict: "Couldn't apply — a newer change conflicts with it.",
  document_not_found: "This document no longer exists.",
  batch_not_found: "Those changes couldn't be found.",
  nothing_to_revert: "Those changes were already reverted.",
  invalid_version: "That version doesn't exist.",
  nothing_to_restore: "The document is already at this version.",
  too_many_operations: "Too many changes since that version to restore in one step.",
};

function toHistoryFailureMessage(reason: string): string {
  return HISTORY_FAILURE_MESSAGES[reason] ?? `Couldn't apply (${reason}).`;
}

/** Result surfaced to the AI-batch revert affordance. */
export type RevertBatchResult = { isOk: true } | { isOk: false; message: string };

/** Result surfaced to the history panel's restore affordance. */
export type RestoreVersionResult = { isOk: true } | { isOk: false; message: string };

interface EditorState {
  /** The rendered email document: server head + the pending local overlay. */
  doc: EmailDocument;
  /** Last server snapshot from the reactive getDocument query (null until loaded). */
  serverDoc: EmailDocument | null;
  serverHeadVersion: number;
  /** True once the first server snapshot has been applied. */
  isDocumentReady: boolean;
  /** The Convex document this store is bound to (null before connect). */
  documentId: Id<"documents"> | null;
  /** The anonymous session id — authorId for user ops and history calls. */
  authorId: string | null;
  /** Outbound overlay: held/in-flight/acked-awaiting-snapshot ops, oldest first. */
  pendingOps: PendingOp[];
  /** Server-derived button states (fed from the history.canUndoRedo query). */
  canUndo: boolean;
  canRedo: boolean;
  /** Transient user-facing notice (undo/redo/revert failures, dropped ops). */
  notice: string | null;
  /** The currently selected block on the canvas, or null for no selection. */
  selectedBlockId: BlockId | null;
  /**
   * The text block whose inline rich-text editor is open, or null. At most
   * one editor is open at a time; while open, canvas selection stays on it.
   */
  editingBlockId: BlockId | null;
  /** Canvas viewport width preset. */
  viewport: Viewport;

  /** Bind the store to a loaded Convex document (called once by StudioShell). */
  connectDocument: (input: {
    convexClient: ConvexReactClient;
    documentId: Id<"documents">;
    authorId: string;
  }) => void;
  /** Detach from the current document and clear all document-scoped state. */
  resetDocumentState: () => void;
  /** Feed a reactive getDocument snapshot in; rebases the pending overlay. */
  applyServerSnapshot: (input: { doc: EmailDocument; headVersion: number }) => void;
  /** Feed the reactive canUndoRedo query result in. */
  setHistoryAvailability: (input: { canUndo: boolean; canRedo: boolean }) => void;

  /**
   * The only mutation entry point: dispatch one content operation through the
   * SDK action registry. Applies locally (instant) and forwards the settled
   * op to Convex. Returns the full LOCAL dispatch result so callers can
   * surface structured errors synchronously. `provenance` overrides the
   * default local-user authorship (see {@link DispatchProvenance}); agent
   * ops never coalesce — each is sent immediately with its own identity.
   */
  dispatch: (op: Operation, provenance?: DispatchProvenance) => DispatchContentActionResult;
  /**
   * Explicitly end the active gesture (field blur / picker close): flushes
   * the held op to Convex; the next dispatch starts a fresh gesture.
   */
  endCoalescing: () => void;
  /** Server-side per-author undo (history.undo); failures surface as a notice. */
  undo: () => void;
  /** Server-side per-author redo (history.redo); failures surface as a notice. */
  redo: () => void;
  /** Revert one AI turn's batch (history.revertBatch). */
  revertAgentBatch: (batchId: string) => Promise<RevertBatchResult>;
  /** Restore the document to a historical version (history.rollbackToVersion). */
  restoreVersion: (version: number) => Promise<RestoreVersionResult>;

  showNotice: (message: string) => void;
  dismissNotice: () => void;

  selectBlock: (blockId: BlockId | null) => void;
  /**
   * Open the inline rich-text editor for a text block (also selects it).
   * Selecting any other block — or deselecting — closes the open editor;
   * the editor component commits its session on unmount.
   */
  startTextEditing: (blockId: BlockId) => void;
  /** Close the inline rich-text editor (selection is left untouched). */
  stopTextEditing: () => void;
  setViewport: (viewport: Viewport) => void;
}

/** Keep the selection only if the block still exists in the new document. */
function reconcileSelection(
  selectedBlockId: BlockId | null,
  doc: EmailDocument,
): BlockId | null {
  return selectedBlockId !== null && doc[selectedBlockId] !== undefined
    ? selectedBlockId
    : null;
}

export const useEditorStore = create<EditorState>()((set, get) => {
  // The Convex client is runtime wiring, not renderable state.
  let convexClient: ConvexReactClient | null = null;
  let flushTimerId: ReturnType<typeof setTimeout> | null = null;
  let noticeTimerId: ReturnType<typeof setTimeout> | null = null;

  const getHeldOp = (): PendingOp | null => {
    const lastPending = get().pendingOps[get().pendingOps.length - 1];
    return lastPending !== undefined && lastPending.isHeld ? lastPending : null;
  };

  /** Remove one pending op (send failure) and rebase the doc without it. */
  const dropPendingOp = (clientId: string, noticeMessage: string): void => {
    set((state) => {
      const pendingOps = state.pendingOps.filter((pending) => pending.clientId !== clientId);
      if (state.serverDoc === null) {
        return { pendingOps };
      }
      const rebased = rebasePendingOps({
        serverDoc: state.serverDoc,
        serverHeadVersion: state.serverHeadVersion,
        pendingOps,
      });
      return {
        pendingOps: rebased.pendingOps,
        doc: rebased.doc,
        selectedBlockId: reconcileSelection(state.selectedBlockId, rebased.doc),
        editingBlockId: reconcileSelection(state.editingBlockId, rebased.doc),
      };
    });
    get().showNotice(noticeMessage);
  };

  /** Submit one pending op to Convex applyOperations and track its outcome. */
  const sendPendingOp = (clientId: string): void => {
    const { documentId, pendingOps } = get();
    const pending = pendingOps.find((candidate) => candidate.clientId === clientId);
    if (pending === undefined || documentId === null || convexClient === null) {
      return;
    }
    if (pending.isHeld) {
      set((state) => ({
        pendingOps: state.pendingOps.map((candidate) =>
          candidate.clientId === clientId ? { ...candidate, isHeld: false } : candidate,
        ),
      }));
    }
    // Phase 5.3: agent `updateText` ops route through agentText.applyAgentTextEdit,
    // which records the SAME standard op row (author/batchId provenance intact)
    // AND merges the edit into the block's live ProseMirror sync doc via the
    // component's server-side transform — so an agent rewrite lands as a minimal
    // targeted change that rebases against concurrent human keystrokes instead
    // of clobbering them. Both mutations return the same result shape, so the
    // ack/failure handling below is shared. User `updateText` session ops keep
    // using applyOperations: their content ALREADY came from the sync doc, so
    // transforming it again would be circular.
    const isAgentTextEdit = pending.context.author === "agent" && pending.op.name === "updateText";
    const mutationPromise = isAgentTextEdit
      ? convexClient.mutation(api.agentText.applyAgentTextEdit, {
          documentId,
          op: pending.op,
          context: pending.context,
        })
      : convexClient.mutation(api.documents.applyOperations, {
          documentId,
          ops: [pending.op],
          context: pending.context,
        });
    mutationPromise
      .then((result) => {
        if (!result.isOk) {
          const detail = result.errors[0]?.message ?? "the server rejected it";
          dropPendingOp(clientId, `A change couldn't be saved and was rolled back: ${detail}`);
          return;
        }
        const confirmedVersion = result.headVersion;
        set((state) => {
          const pendingOpsWithAck = state.pendingOps.map((candidate) =>
            candidate.clientId === clientId ? { ...candidate, confirmedVersion } : candidate,
          );
          // If the snapshot covering this version already arrived, prune now.
          if (state.serverDoc !== null && confirmedVersion <= state.serverHeadVersion) {
            const rebased = rebasePendingOps({
              serverDoc: state.serverDoc,
              serverHeadVersion: state.serverHeadVersion,
              pendingOps: pendingOpsWithAck,
            });
            return { pendingOps: rebased.pendingOps, doc: rebased.doc };
          }
          return { pendingOps: pendingOpsWithAck };
        });
      })
      .catch(() => {
        dropPendingOp(clientId, "A change couldn't be saved (connection error) and was rolled back.");
      });
  };

  /** Settle the open gesture: send its held op now. */
  const flushHeldOp = (): void => {
    if (flushTimerId !== null) {
      clearTimeout(flushTimerId);
      flushTimerId = null;
    }
    const heldOp = getHeldOp();
    if (heldOp !== null) {
      sendPendingOp(heldOp.clientId);
    }
  };

  /** (Re)arm the gesture-settle timer. */
  const scheduleFlush = (): void => {
    if (flushTimerId !== null) {
      clearTimeout(flushTimerId);
    }
    flushTimerId = setTimeout(() => {
      flushTimerId = null;
      flushHeldOp();
    }, UNDO_COALESCE_WINDOW_MS);
  };

  return {
    doc: createEmptyDocument(),
    serverDoc: null,
    serverHeadVersion: 0,
    isDocumentReady: false,
    documentId: null,
    authorId: null,
    pendingOps: [],
    canUndo: false,
    canRedo: false,
    notice: null,
    selectedBlockId: null,
    editingBlockId: null,
    viewport: "desktop",

    connectDocument: ({ convexClient: client, documentId, authorId }) => {
      convexClient = client;
      set({ documentId, authorId });
    },

    resetDocumentState: () => {
      if (flushTimerId !== null) {
        clearTimeout(flushTimerId);
        flushTimerId = null;
      }
      set({
        doc: createEmptyDocument(),
        serverDoc: null,
        serverHeadVersion: 0,
        isDocumentReady: false,
        documentId: null,
        pendingOps: [],
        canUndo: false,
        canRedo: false,
        notice: null,
        selectedBlockId: null,
        editingBlockId: null,
      });
    },

    applyServerSnapshot: ({ doc, headVersion }) => {
      set((state) => {
        const rebased = rebasePendingOps({
          serverDoc: doc,
          serverHeadVersion: headVersion,
          pendingOps: state.pendingOps,
        });
        return {
          serverDoc: doc,
          serverHeadVersion: headVersion,
          doc: rebased.doc,
          pendingOps: rebased.pendingOps,
          isDocumentReady: true,
          selectedBlockId: reconcileSelection(state.selectedBlockId, rebased.doc),
          editingBlockId: reconcileSelection(state.editingBlockId, rebased.doc),
        };
      });
    },

    setHistoryAvailability: ({ canUndo, canRedo }) => set({ canUndo, canRedo }),

    dispatch: (op, provenance) => {
      const context: ActionContext = {
        ...LOCAL_ACTION_CONTEXT,
        authorId: get().authorId ?? "local",
        ...provenance,
      };
      const result = dispatchContentAction({
        registry: emailActionRegistry,
        doc: get().doc,
        name: op.name,
        input: op,
        context,
      });
      if (!result.isOk) {
        // Surface for debugging; UI controls are built to only emit valid ops.
        // Agent-authored failures are an EXPECTED path (the chat panel surfaces
        // them as failed chips and reports them back to the model), so they are
        // not console noise.
        if (context.author !== "agent") {
          console.error(`dispatch(${op.name}) failed`, result.errors);
        }
        return result;
      }

      // 1. Instant local apply — the input path never waits on Convex.
      set((state) => ({
        doc: result.doc,
        selectedBlockId: reconcileSelection(state.selectedBlockId, result.doc),
        editingBlockId: reconcileSelection(state.editingBlockId, result.doc),
      }));

      // 2. Outbound bookkeeping. Agent ops never coalesce: each tool call is a
      // discrete edit with its own provenance.
      const now = Date.now();
      const coalesceKey = context.author === "agent" ? null : getCoalesceKey(op);
      const appliedOp = result.logEntry.op;
      const heldOp = getHeldOp();
      const isSameGesture =
        coalesceKey !== null &&
        heldOp !== null &&
        heldOp.coalesceKey === coalesceKey &&
        now - heldOp.lastDispatchedAt <= UNDO_COALESCE_WINDOW_MS;

      if (isSameGesture) {
        // Extend the open gesture: the latest forward op supersedes the held
        // one entirely (same target, same property keys, newest values).
        set((state) => ({
          pendingOps: state.pendingOps.map((candidate) =>
            candidate.clientId === heldOp.clientId
              ? { ...candidate, op: appliedOp, lastDispatchedAt: now }
              : candidate,
          ),
        }));
        scheduleFlush();
        return result;
      }

      // A new edit always settles the previous gesture first (server order
      // must match local apply order).
      flushHeldOp();
      const pending: PendingOp = {
        clientId: crypto.randomUUID(),
        op: appliedOp,
        context,
        isHeld: coalesceKey !== null,
        coalesceKey,
        lastDispatchedAt: now,
        confirmedVersion: null,
      };
      set((state) => ({ pendingOps: [...state.pendingOps, pending] }));
      if (coalesceKey === null) {
        sendPendingOp(pending.clientId);
      } else {
        scheduleFlush();
      }
      return result;
    },

    endCoalescing: () => flushHeldOp(),

    undo: () => {
      const { documentId, authorId } = get();
      if (documentId === null || authorId === null || convexClient === null) {
        return;
      }
      // Settle the open gesture first so it is what gets undone.
      flushHeldOp();
      convexClient
        .mutation(api.history.undo, { documentId, authorId })
        .then((result) => {
          if (!result.isOk) {
            get().showNotice(toHistoryFailureMessage(result.reason));
          }
        })
        .catch(() => get().showNotice("Undo failed (connection error)."));
    },

    redo: () => {
      const { documentId, authorId } = get();
      if (documentId === null || authorId === null || convexClient === null) {
        return;
      }
      flushHeldOp();
      convexClient
        .mutation(api.history.redo, { documentId, authorId })
        .then((result) => {
          if (!result.isOk) {
            get().showNotice(toHistoryFailureMessage(result.reason));
          }
        })
        .catch(() => get().showNotice("Redo failed (connection error)."));
    },

    revertAgentBatch: async (batchId) => {
      const { documentId, authorId } = get();
      if (documentId === null || authorId === null || convexClient === null) {
        return { isOk: false as const, message: "Not connected to the document." };
      }
      flushHeldOp();
      try {
        const result = await convexClient.mutation(api.history.revertBatch, {
          documentId,
          batchId,
          authorId,
        });
        if (!result.isOk) {
          return { isOk: false as const, message: toHistoryFailureMessage(result.reason) };
        }
        return { isOk: true as const };
      } catch {
        return { isOk: false as const, message: "Revert failed (connection error)." };
      }
    },

    restoreVersion: async (version) => {
      const { documentId, authorId } = get();
      if (documentId === null || authorId === null || convexClient === null) {
        return { isOk: false as const, message: "Not connected to the document." };
      }
      flushHeldOp();
      try {
        const result = await convexClient.mutation(api.history.rollbackToVersion, {
          documentId,
          version,
          authorId,
        });
        if (!result.isOk) {
          return { isOk: false as const, message: toHistoryFailureMessage(result.reason) };
        }
        return { isOk: true as const };
      } catch {
        return { isOk: false as const, message: "Restore failed (connection error)." };
      }
    },

    showNotice: (message) => {
      if (noticeTimerId !== null) {
        clearTimeout(noticeTimerId);
      }
      noticeTimerId = setTimeout(() => {
        noticeTimerId = null;
        set({ notice: null });
      }, 4000);
      set({ notice: message });
    },

    dismissNotice: () => {
      if (noticeTimerId !== null) {
        clearTimeout(noticeTimerId);
        noticeTimerId = null;
      }
      set({ notice: null });
    },

    selectBlock: (blockId) =>
      set((state) => ({
        selectedBlockId: blockId,
        // Moving selection off the block being edited closes its editor
        // (the unmounting editor commits its session).
        editingBlockId: state.editingBlockId === blockId ? state.editingBlockId : null,
      })),
    startTextEditing: (blockId) =>
      set({ selectedBlockId: blockId, editingBlockId: blockId }),
    stopTextEditing: () => set({ editingBlockId: null }),
    setViewport: (viewport) => set({ viewport }),
  };
});

// Dev-only escape hatch so in-browser verification (agents, debugging) can
// inspect the pending overlay and document without going through React.
declare global {
  interface Window {
    __tandemEditorStore?: typeof useEditorStore;
  }
}
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  window.__tandemEditorStore = useEditorStore;
}

/** Selector: can history.undo do anything for this author? (server-derived) */
export const selectCanUndo = (state: EditorState): boolean => state.canUndo;

/** Selector: can history.redo do anything for this author? (server-derived) */
export const selectCanRedo = (state: EditorState): boolean => state.canRedo;
