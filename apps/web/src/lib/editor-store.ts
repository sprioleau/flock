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

/** Provenance stamped on every op-log entry produced by this UI. */
const LOCAL_ACTION_CONTEXT: ActionContext = {
  caller: "frontend",
  author: "user",
  authorId: "local",
};

export type Viewport = PreviewMode;

interface EditorState {
  /** The current email document — the flat block map, sole source of truth. */
  doc: EmailDocument;
  /** The currently selected block on the canvas, or null for no selection. */
  selectedBlockId: BlockId | null;
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
   * surface structured errors.
   */
  dispatch: (op: Operation) => DispatchContentActionResult;
  /** Apply the most recent undo-stack entry's inverse (through applyOperation). */
  undo: () => void;
  /** Reapply the most recently undone operation (through applyOperation). */
  redo: () => void;
  selectBlock: (blockId: BlockId | null) => void;
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
  selectedBlockId: null,
  viewport: "desktop",
  undoStack: [],
  redoStack: [],
  opLog: [],

  dispatch: (op) => {
    const result = dispatchContentAction({
      registry: emailActionRegistry,
      doc: get().doc,
      name: op.name,
      input: op,
      context: LOCAL_ACTION_CONTEXT,
    });
    if (!result.isOk) {
      // Surface for debugging; UI controls are built to only emit valid ops.
      console.error(`dispatch(${op.name}) failed`, result.errors);
      return result;
    }
    set((state) => ({
      doc: result.doc,
      opLog: [...state.opLog, result.logEntry],
      undoStack: [...state.undoStack, result.logEntry],
      redoStack: [],
      selectedBlockId: reconcileSelection(state.selectedBlockId, result.doc),
    }));
    return result;
  },

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
      opLog: [...state.opLog, undoEntry],
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, entry],
      selectedBlockId: reconcileSelection(state.selectedBlockId, result.doc),
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
      opLog: [...state.opLog, redoEntry],
      undoStack: [...state.undoStack, entry],
      redoStack: state.redoStack.slice(0, -1),
      selectedBlockId: reconcileSelection(state.selectedBlockId, result.doc),
    }));
  },

  selectBlock: (blockId) => set({ selectedBlockId: blockId }),
  setViewport: (viewport) => set({ viewport }),
}));

/** Selector: is there anything to undo? */
export const selectCanUndo = (state: EditorState): boolean => state.undoStack.length > 0;

/** Selector: is there anything to redo? */
export const selectCanRedo = (state: EditorState): boolean => state.redoStack.length > 0;
