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
  type ScaffoldSectionInput,
  type StyleTextSpanInput,
} from "@tandem/email-sdk";
import type { ConvexReactClient } from "convex/react";
import { createContext, useContext } from "react";
import { useStore, type StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
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
 *
 * Drafts v2 — STORE-PER-DOCUMENT FACTORY (the "simultaneous editing needs
 * per-document editor-store instances" seam the frames redesign left open):
 * the store is no longer a module singleton. {@link createEditorStore} makes
 * an independent instance (own doc/overlay/selection/timers), and a
 * refcounted registry ({@link acquireEditorStore} / {@link releaseEditorStore})
 * caches one instance per documentId for the frame that mounts it. The
 * ACTIVE instance — the one bound to the authoritative ?doc= URL — is held
 * in a swappable holder; {@link useEditorStore} keeps its historical shape
 * (selector hook + getState/subscribe statics) by delegating to the nearest
 * {@link EditorStoreProvider} and falling back to the active instance, so
 * every existing consumer works unchanged whether it renders inside a
 * specific frame's subtree or in shell chrome (toolbar, chat, panels).
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

/**
 * A dispatchable content input: a plain email-sdk Operation, or one of the
 * intent-shaped inputs (styleTextSpan, scaffoldSection) whose translation to
 * a canonical op (updateText / addSection) happens inside
 * dispatchContentAction (SDK resolveOperation hooks) against the CURRENT
 * local document. Type-only union — no dispatch logic branches on it.
 */
export type DispatchableOp = Operation | StyleTextSpanInput | ScaffoldSectionInput;

/** Coalesce key for an op, or null when the op never coalesces. */
function getCoalesceKey(op: DispatchableOp): string | null {
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
  /** The RESOLVED operation (styleTextSpan intents resolve to updateText). */
  op: Operation;
  /**
   * The raw styleTextSpan intent when this pending op came from one (null
   * otherwise). Sent to Convex INSTEAD of the locally-resolved op so the
   * server re-runs the same deterministic translation against the
   * authoritative document (agentText.applyAgentStyleTextSpan); `op` remains
   * what the local overlay replays for instant feedback.
   */
  styleTextSpanIntent: StyleTextSpanInput | null;
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

/**
 * Route ONE settled operation to the correct Convex mutation — THE wire-out
 * seam shared by the store's own outbound overlay (sendPendingOp) and the
 * chat panel's mid-turn-draft-switch path (use-tandem-chat.ts, which must
 * land a turn's ops in the document the turn STARTED in even when that
 * document is no longer the connected one).
 *
 * Phase 5.3 routing: agent `updateText` ops go through
 * agentText.applyAgentTextEdit, which records the SAME standard op row
 * (author/batchId provenance intact) AND merges the edit into the block's
 * live ProseMirror sync doc via the component's server-side transform — so
 * an agent rewrite lands as a minimal targeted change that rebases against
 * concurrent human keystrokes instead of clobbering them. Agent
 * `styleTextSpan` intents route through the sibling
 * agentText.applyAgentStyleTextSpan, which re-runs the same deterministic
 * find→marks translation against the AUTHORITATIVE document before recording
 * the one resulting updateText op the same way. All mutations return the
 * same result shape, so callers share their ack/failure handling. User
 * `updateText` session ops keep using applyOperations: their content ALREADY
 * came from the sync doc, so transforming it again would be circular.
 */
export function submitOperationToConvex({
  convexClient,
  documentId,
  op,
  styleTextSpanIntent,
  context,
}: {
  convexClient: ConvexReactClient;
  documentId: Id<"documents">;
  /** The RESOLVED operation (styleTextSpan intents resolve to updateText). */
  op: Operation;
  /** The raw styleTextSpan intent when `op` came from one (null otherwise). */
  styleTextSpanIntent: StyleTextSpanInput | null;
  context: ActionContext;
}) {
  const isAgentAuthored = context.author === "agent";
  const isAgentSpanStyle = isAgentAuthored && styleTextSpanIntent !== null;
  const isAgentTextEdit = isAgentAuthored && !isAgentSpanStyle && op.name === "updateText";
  return isAgentSpanStyle
    ? convexClient.mutation(api.agentText.applyAgentStyleTextSpan, {
        documentId,
        input: styleTextSpanIntent,
        context,
      })
    : isAgentTextEdit
      ? convexClient.mutation(api.agentText.applyAgentTextEdit, {
          documentId,
          op,
          context,
        })
      : convexClient.mutation(api.documents.applyOperations, {
          documentId,
          ops: [op],
          context,
        });
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

export interface EditorState {
  /** The rendered email document: server head + the pending local overlay. */
  doc: EmailDocument;
  /** Last server snapshot from the reactive getDocument query (null until loaded). */
  serverDoc: EmailDocument | null;
  serverHeadVersion: number;
  /** True once the first server snapshot has been applied. */
  isDocumentReady: boolean;
  /** The Convex document this store is bound to (null before connect). */
  documentId: Id<"documents"> | null;
  /**
   * The canvas the connected document lives on (null before connect). Held
   * here — not derived from the reactive snapshot — so the drafts bar keeps
   * its canvas while a draft switch's new subscription is still loading
   * (the snapshot goes undefined in that window; this does not).
   */
  canvasId: Id<"canvases"> | null;
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

  /** Bind the store to a loaded Convex document (called by StudioShell on load and on draft switch). */
  connectDocument: (input: {
    convexClient: ConvexReactClient;
    documentId: Id<"documents">;
    canvasId: Id<"canvases">;
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
  dispatch: (op: DispatchableOp, provenance?: DispatchProvenance) => DispatchContentActionResult;
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

/** One independent editor-store instance (vanilla zustand StoreApi). */
export type EditorStoreApi = StoreApi<EditorState>;

/**
 * THE FACTORY: one fully independent editor store — its own rendered doc,
 * server mirror, pending-op overlay, selection, gesture timers, and Convex
 * client binding. Two instances never share document state.
 */
export function createEditorStore(): EditorStoreApi {
  return createStore<EditorState>()((set, get) => {
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
    // Routing (agentText vs applyOperations) lives in submitOperationToConvex,
    // shared with the chat panel's mid-turn-draft-switch path.
    const mutationPromise = submitOperationToConvex({
      convexClient,
      documentId,
      op: pending.op,
      styleTextSpanIntent: pending.styleTextSpanIntent,
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
    canvasId: null,
    authorId: null,
    pendingOps: [],
    canUndo: false,
    canRedo: false,
    notice: null,
    selectedBlockId: null,
    editingBlockId: null,
    viewport: "desktop",

    connectDocument: ({ convexClient: client, documentId, canvasId, authorId }) => {
      convexClient = client;
      set({ documentId, canvasId, authorId });
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
        canvasId: null,
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
      // logEntry.op is always a plain Operation: for styleTextSpan the SDK's
      // resolveOperation hook already translated the intent into an updateText
      // op against the current doc — that's what the local overlay replays.
      const appliedOp = result.logEntry.op;
      const styleTextSpanIntent = op.name === "styleTextSpan" ? op : null;
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
        styleTextSpanIntent,
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
}

// ---------------------------------------------------------------------------
// Per-document registry — one cached instance per documentId
// ---------------------------------------------------------------------------

interface EditorStoreRegistryEntry {
  store: EditorStoreApi;
  /** Mounted holders (frames, pinned chat turns). Disposed when it hits 0. */
  referenceCount: number;
}

const editorStoreRegistry = new Map<Id<"documents">, EditorStoreRegistryEntry>();

/**
 * Get (or create) THE store instance for a document and take a reference.
 * Lifecycle contract: every acquire is paired with one
 * {@link releaseEditorStore} (frame unmount / doc close); the instance —
 * and with it selection, viewport, and any not-yet-confirmed overlay — is
 * retained while anyone still holds it.
 */
export function acquireEditorStore(documentId: Id<"documents">): EditorStoreApi {
  const existingEntry = editorStoreRegistry.get(documentId);
  if (existingEntry !== undefined) {
    existingEntry.referenceCount += 1;
    return existingEntry.store;
  }
  const store = createEditorStore();
  editorStoreRegistry.set(documentId, { store, referenceCount: 1 });
  return store;
}

/** Drop one reference; the last release detaches and evicts the instance. */
export function releaseEditorStore(documentId: Id<"documents">): void {
  const entry = editorStoreRegistry.get(documentId);
  if (entry === undefined) {
    return;
  }
  entry.referenceCount -= 1;
  if (entry.referenceCount > 0) {
    return;
  }
  editorStoreRegistry.delete(documentId);
  // Clears gesture timers and document-scoped state; the detached instance
  // is then garbage-collectable once its subscribers unhook.
  entry.store.getState().resetDocumentState();
}

/** Peek without taking a reference (null when no frame holds the document). */
export function peekEditorStore(documentId: Id<"documents">): EditorStoreApi | null {
  return editorStoreRegistry.get(documentId)?.store ?? null;
}

// ---------------------------------------------------------------------------
// The ACTIVE instance + the compatibility hook
// ---------------------------------------------------------------------------

/**
 * The active editor store: the instance bound to the authoritative `?doc=`
 * URL. Held in a tiny swappable store so hook consumers re-render when the
 * lifecycle owner (StudioShell) swaps instances on a draft switch. Starts
 * with a detached default instance — exactly the old singleton's boot state.
 */
const activeEditorStoreHolder = createStore<{ store: EditorStoreApi }>(() => ({
  store: createEditorStore(),
}));

/** The instance currently bound to the URL's ?doc= (always non-null). */
export function getActiveEditorStore(): EditorStoreApi {
  return activeEditorStoreHolder.getState().store;
}

/** Swap the active instance (lifecycle owner only — the ?doc= URL is authoritative). */
export function setActiveEditorStore(store: EditorStoreApi): void {
  if (activeEditorStoreHolder.getState().store !== store) {
    activeEditorStoreHolder.setState({ store });
  }
}

/**
 * Scope a subtree (one draft frame) to a specific store instance. Consumers
 * inside it read THAT document's state through {@link useEditorStore};
 * consumers outside any provider read the active instance.
 */
const EditorStoreContext = createContext<EditorStoreApi | null>(null);
export const EditorStoreProvider = EditorStoreContext.Provider;

/**
 * The historical consumer surface, preserved: a selector hook that also
 * carries getState/subscribe statics. Hook reads resolve against the nearest
 * EditorStoreProvider, falling back to the active instance; the statics
 * always target the ACTIVE instance (imperative call sites all mean "the
 * document the studio is editing").
 */
export function useEditorStore<SelectedValue>(
  selector: (state: EditorState) => SelectedValue,
): SelectedValue {
  const contextStore = useContext(EditorStoreContext);
  const activeStore = useStore(activeEditorStoreHolder, (holder) => holder.store);
  return useStore(contextStore ?? activeStore, selector);
}

useEditorStore.getState = (): EditorState => getActiveEditorStore().getState();

/**
 * The store INSTANCE a component is scoped to: the nearest
 * {@link EditorStoreProvider}'s instance, falling back to the active one.
 * For imperative reads/writes from callbacks that must target the document
 * of the FRAME they render in (multi-frame editing) — the static
 * `useEditorStore.getState()` always targets the ACTIVE instance and is
 * wrong inside a non-active frame's subtree.
 */
export function useEditorStoreApi(): EditorStoreApi {
  const contextStore = useContext(EditorStoreContext);
  const activeStore = useStore(activeEditorStoreHolder, (holder) => holder.store);
  return contextStore ?? activeStore;
}

useEditorStore.setState = (partial: Partial<EditorState>): void => {
  getActiveEditorStore().setState(partial);
};

/**
 * Subscribe to the ACTIVE instance, surviving instance swaps: when the
 * lifecycle owner swaps the active store (draft switch), the subscription
 * transparently re-attaches to the new instance — matching the old
 * singleton's "one subscription across draft switches" behavior that
 * use-persona-advisors and use-suggestions rely on.
 */
useEditorStore.subscribe = (
  listener: (state: EditorState, previousState: EditorState) => void,
): (() => void) => {
  let unsubscribeFromStore = getActiveEditorStore().subscribe(listener);
  const unsubscribeFromHolder = activeEditorStoreHolder.subscribe((holder) => {
    unsubscribeFromStore();
    unsubscribeFromStore = holder.store.subscribe(listener);
  });
  return () => {
    unsubscribeFromHolder();
    unsubscribeFromStore();
  };
};

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
