import {
  applyOperation,
  createLogEntry,
  dispatchContentAction,
  emailActionRegistry,
  createSampleDocument,
  type ActionContext,
  type BlockId,
  type DispatchContentActionResult,
  type EmailDocument,
  type Operation,
  type OperationLogEntry,
  type PreviewMode,
} from "@tandem/email-sdk";
import { create } from "zustand";

/**
 * The Phase 2 document store — local, in-memory, single-player.
 *
 * THE INVARIANT (docs/email-editor-phased-plan.md §7): every document
 * mutation flows through the SDK's action layer. `dispatch` wraps
 * `dispatchContentAction` and is the store's ONLY mutation entry point —
 * components never hand-edit the document. Undo/redo replay SDK-generated
 * inverses through `applyOperation`. Phase 4 swaps this store for Convex
 * live queries + mutations without touching any component.
 */

/** Default provenance for op-log entries produced by this UI's own controls. */
const LOCAL_ACTION_CONTEXT: ActionContext = {
  caller: "frontend",
  author: "user",
  authorId: "local",
};

/**
 * Per-dispatch provenance overrides, merged over {@link LOCAL_ACTION_CONTEXT}.
 * The chat panel passes `{ caller: "tool", author: "agent", authorId: <chat
 * id>, batchId: <turn batch id> }` so agent-applied ops land in the op log
 * with agent authorship and one shared batchId per assistant turn (Phase 4's
 * AI-batch revert hangs off that batchId).
 */
export type DispatchProvenance = Partial<ActionContext>;

export type Viewport = PreviewMode;

/**
 * Undo-stack coalescing window. Property-panel inputs dispatch on EVERY input
 * event so the canvas tracks in real time (color drags fire ~16ms apart);
 * consecutive ops hitting the same block + operation + property key set
 * within this window merge into ONE undo entry — the earliest inverse (the
 * gesture's starting value) with the latest forward op. A run ends when the
 * window lapses, the field blurs (endCoalescing), or a different target or
 * property is edited.
 */
export const UNDO_COALESCE_WINDOW_MS = 120;

/** Tracks the in-flight coalescing run (null = no run active). */
interface CoalesceRun {
  /** Discriminates the run: op name + target block + sorted property keys. */
  key: string;
  /** Timestamp of the run's most recent dispatch (epoch ms). */
  lastDispatchedAt: number;
  /** Log-entry id of the run's merged entry (must still top the undo stack). */
  entryId: string;
}

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

interface EditorState {
  /** The current email document — the flat block map, sole source of truth. */
  doc: EmailDocument;
  /** The active undo-coalescing run (see UNDO_COALESCE_WINDOW_MS). */
  coalesceRun: CoalesceRun | null;
  /** The currently selected block on the canvas, or null for no selection. */
  selectedBlockId: BlockId | null;
  /**
   * The text block whose inline rich-text editor is open, or null. At most
   * one editor is open at a time; while open, canvas selection stays on it.
   */
  editingBlockId: BlockId | null;
  /** Canvas viewport width preset. */
  viewport: Viewport;
  /** Entries whose `inverse` undoes them, oldest → newest. */
  undoStack: OperationLogEntry[];
  /** Entries undone and eligible for redo, oldest undo → newest undo. */
  redoStack: OperationLogEntry[];
  /** Append-only in-memory operation log (every applied op, incl. undo/redo). */
  opLog: OperationLogEntry[];

  /**
   * The only mutation entry point: dispatch one content operation through the
   * SDK action registry. Returns the full dispatch result so callers can
   * surface structured errors. `provenance` overrides the default local-user
   * authorship (see {@link DispatchProvenance}); agent-authored ops never
   * coalesce with user gestures on the undo stack.
   */
  dispatch: (op: Operation, provenance?: DispatchProvenance) => DispatchContentActionResult;
  /**
   * Explicitly end the active coalescing run (field blur / picker close):
   * the next dispatch starts a fresh undo entry even inside the window.
   */
  endCoalescing: () => void;
  /** Apply the most recent undo-stack entry's inverse (through applyOperation). */
  undo: () => void;
  /** Reapply the most recently undone operation (through applyOperation). */
  redo: () => void;
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

export const useEditorStore = create<EditorState>()((set, get) => ({
  doc: createSampleDocument(),
  coalesceRun: null,
  selectedBlockId: null,
  editingBlockId: null,
  viewport: "desktop",
  undoStack: [],
  redoStack: [],
  opLog: [],

  dispatch: (op, provenance) => {
    const context: ActionContext = { ...LOCAL_ACTION_CONTEXT, ...provenance };
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

    const now = Date.now();
    // Agent ops never coalesce: each tool call is a discrete edit, and merging
    // with an adjacent user gesture would fuse two authors into one undo step.
    const coalesceKey = context.author === "agent" ? null : getCoalesceKey(op);

    set((state) => {
      const topEntry = state.undoStack[state.undoStack.length - 1];
      const lastLogEntry = state.opLog[state.opLog.length - 1];
      const shouldCoalesce =
        coalesceKey !== null &&
        state.coalesceRun !== null &&
        state.coalesceRun.key === coalesceKey &&
        now - state.coalesceRun.lastDispatchedAt <= UNDO_COALESCE_WINDOW_MS &&
        topEntry !== undefined &&
        topEntry.id === state.coalesceRun.entryId &&
        lastLogEntry !== undefined &&
        lastLogEntry.id === state.coalesceRun.entryId;

      if (shouldCoalesce) {
        // Merge into the run's entry: keep the EARLIEST inverse (snapshots
        // the gesture's starting value) under the LATEST forward op, so undo
        // jumps end→start in one step and redo start→end in one step. The op
        // log is coalesced identically — one logical entry per gesture is
        // what Phase 4 persists.
        const mergedEntry: OperationLogEntry = {
          ...result.logEntry,
          id: topEntry.id,
          inverse: topEntry.inverse,
        };
        return {
          doc: result.doc,
          opLog: [...state.opLog.slice(0, -1), mergedEntry],
          undoStack: [...state.undoStack.slice(0, -1), mergedEntry],
          redoStack: [],
          coalesceRun: { key: coalesceKey, lastDispatchedAt: now, entryId: mergedEntry.id },
          selectedBlockId: reconcileSelection(state.selectedBlockId, result.doc),
          editingBlockId: reconcileSelection(state.editingBlockId, result.doc),
        };
      }

      return {
        doc: result.doc,
        opLog: [...state.opLog, result.logEntry],
        undoStack: [...state.undoStack, result.logEntry],
        redoStack: [],
        coalesceRun:
          coalesceKey !== null
            ? { key: coalesceKey, lastDispatchedAt: now, entryId: result.logEntry.id }
            : null,
        selectedBlockId: reconcileSelection(state.selectedBlockId, result.doc),
        editingBlockId: reconcileSelection(state.editingBlockId, result.doc),
      };
    });
    return result;
  },

  endCoalescing: () => set({ coalesceRun: null }),

  undo: () => {
    const { doc, undoStack } = get();
    const entry = undoStack[undoStack.length - 1];
    if (entry === undefined) {
      return;
    }
    const result = applyOperation(doc, entry.inverse);
    if (!result.isOk) {
      console.error("undo failed", result.errors);
      return;
    }
    const undoEntry = createLogEntry({
      op: entry.inverse,
      inverse: result.inverse,
      authorId: LOCAL_ACTION_CONTEXT.authorId,
      author: LOCAL_ACTION_CONTEXT.author,
      caller: LOCAL_ACTION_CONTEXT.caller,
    });
    set((state) => ({
      doc: result.doc,
      coalesceRun: null,
      opLog: [...state.opLog, undoEntry],
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, entry],
      selectedBlockId: reconcileSelection(state.selectedBlockId, result.doc),
      editingBlockId: reconcileSelection(state.editingBlockId, result.doc),
    }));
  },

  redo: () => {
    const { doc, redoStack } = get();
    const entry = redoStack[redoStack.length - 1];
    if (entry === undefined) {
      return;
    }
    const result = applyOperation(doc, entry.op);
    if (!result.isOk) {
      console.error("redo failed", result.errors);
      return;
    }
    const redoEntry = createLogEntry({
      op: entry.op,
      inverse: result.inverse,
      authorId: LOCAL_ACTION_CONTEXT.authorId,
      author: LOCAL_ACTION_CONTEXT.author,
      caller: LOCAL_ACTION_CONTEXT.caller,
    });
    set((state) => ({
      doc: result.doc,
      coalesceRun: null,
      opLog: [...state.opLog, redoEntry],
      undoStack: [...state.undoStack, entry],
      redoStack: state.redoStack.slice(0, -1),
      selectedBlockId: reconcileSelection(state.selectedBlockId, result.doc),
      editingBlockId: reconcileSelection(state.editingBlockId, result.doc),
    }));
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
}));

// Dev-only escape hatch so in-browser verification (agents, debugging) can
// inspect the op log and document without going through React.
declare global {
  interface Window {
    __tandemEditorStore?: typeof useEditorStore;
  }
}
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  window.__tandemEditorStore = useEditorStore;
}

/** Selector: is there anything to undo? */
export const selectCanUndo = (state: EditorState): boolean => state.undoStack.length > 0;

/** Selector: is there anything to redo? */
export const selectCanRedo = (state: EditorState): boolean => state.redoStack.length > 0;
