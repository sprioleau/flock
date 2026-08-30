import {
  applyOperations,
  buildClearContentOperations,
  type EmailDocument,
  type Operation,
} from "@flock/email-sdk";
import type { DispatchProvenance } from "@/lib/editor-store";

/*
  The client half of "clear the content", as plain functions.

  The SDK decides WHAT a clear does (buildClearContentOperations — pure, no
  model call, no network); this module decides how that lands in the editor:
  one batch of ordinary operations through the store's normal dispatch, so
  every one of them goes down the same validated path as a human dragging a
  slider and shows up in version history like any other edit.

  Deliberately React-free: the app's vitest environment is `node`, so keeping
  the planning, the provenance and the outcome mapping out of the component is
  what makes the cleared / nothing-to-clear / failed paths testable at all.
*/

/*
  ---------------------------------------------------------------------------
  What the user reads
  ---------------------------------------------------------------------------
*/

/*
  The control itself, in the Blocks panel.
*/
export const CLEAR_CONTENT_BUTTON_LABEL = "Clear the content";

export const CLEAR_CONTENT_BLURB =
  "Keep this design and start the writing again from scratch.";

/*
  The confirmation step. This throws away work, so it is never one click.
*/
export const CLEAR_CONTENT_CONFIRM_TITLE = "Replace all the words with placeholders?";

export const CLEAR_CONTENT_CONFIRM_BODY =
  "Every heading, paragraph, button, link, code snippet and image in this email is replaced with placeholder content — so you keep the design and write it again from scratch. Your layout, your colours and your logo stay exactly as they are.";

export const CLEAR_CONTENT_CONFIRM_ACTION = "Clear the content";

export const CLEAR_CONTENT_CANCEL_ACTION = "Keep my content";

/*
  Afterwards.
*/
export const CLEAR_CONTENT_DONE_MESSAGE = "Placeholder content is in. Start writing.";

export const CLEAR_CONTENT_UNDO_ACTION = "Put my content back";

export const CLEAR_CONTENT_NOTHING_MESSAGE =
  "This email is already nothing but placeholders.";

export const CLEAR_CONTENT_FAILED_MESSAGE =
  "We couldn't clear this email just now. Try again.";

/*
  ---------------------------------------------------------------------------
  The store surface this needs
  ---------------------------------------------------------------------------
*/

/*
  The slice of the editor store a clear touches. Structural on purpose — the
  real store satisfies it, and a test can hand in a stub without a Convex
  client, a document, or a React tree.
*/
export interface ClearContentStore {
  /*
    The live document the plan is computed against.
  */
  doc: EmailDocument;
  /*
    The anonymous session id — the author of the ops, so THEY can undo them.
  */
  authorId: string | null;
  dispatch: (operation: Operation, provenance: DispatchProvenance) => { isOk: boolean };
  /*
    Settles any held property gesture so the clear is not folded into it.
  */
  endCoalescing: () => void;
}

export type ClearContentOutcome =
  | {
      kind: "cleared";
      /*
        Groups the whole clear as one revertable unit (history.revertBatch).
      */
      batchId: string;
      /*
        How many blocks were rewritten — for the report, not for the user.
      */
      operationCount: number;
    }
  /*
    The document is already all placeholders: nothing dispatched, no history entry.
  */
  | { kind: "nothing-to-clear" }
  | { kind: "failed"; message: string };

/*
  ---------------------------------------------------------------------------
  Doing it
  ---------------------------------------------------------------------------
*/

/*
  Batch id prefix, so a clear is recognizable in the op log's provenance.
*/
export const CLEAR_CONTENT_BATCH_PREFIX = "clear-content";

export function createClearContentBatchId(newId: () => string = () => crypto.randomUUID()): string {
  return `${CLEAR_CONTENT_BATCH_PREFIX}:${newId()}`;
}

export interface ClearContentInput {
  store: ClearContentStore;
  /** Groups every op of this clear. Generate with {@link createClearContentBatchId}. */
  batchId: string;
}

/*
  Clear the connected document: plan, then dispatch the whole plan under one
  batch id.

  Provenance is the honest one — `author: "user"`, `caller: "frontend"`, the
  session's own authorId — because a human clicked a button. That also puts
  every op in that human's own undo stack.

  The batch id is what makes the whole clear ONE thing to take back: the
  surface hands it to the store's `revertAgentBatch` (history.revertBatch),
  which applies every inverse newest-first, all-or-nothing, in a single
  server call. Per-op undo still works too — this only adds the one-click way.

  All-or-nothing intent: the plan is dry-run against the live document before
  anything is dispatched, so a plan that cannot apply produces no partial
  clear. (A dispatch that fails after that is already impossible in practice —
  the same pure apply engine just accepted it — but the batch id means even
  that case stays revertable as one unit.)
*/
export function clearContent({ store, batchId }: ClearContentInput): ClearContentOutcome {
  const operations = buildClearContentOperations(store.doc);
  if (operations.length === 0) {
    return { kind: "nothing-to-clear" };
  }
  /*
    Dry-run the whole plan against the live document first, so a plan that
    cannot apply leaves the email untouched instead of half-cleared.
  */
  if (!applyOperations(store.doc, operations).isOk) {
    return { kind: "failed", message: CLEAR_CONTENT_FAILED_MESSAGE };
  }
  /*
    Settle any open property gesture first: server order must match the order
    things were applied locally.
  */
  store.endCoalescing();
  for (const operation of operations) {
    const result = store.dispatch(operation, {
      caller: "frontend",
      author: "user",
      authorId: store.authorId ?? "local",
      batchId,
    });
    if (!result.isOk) {
      return { kind: "failed", message: CLEAR_CONTENT_FAILED_MESSAGE };
    }
  }
  /*
    Flush the last op immediately rather than letting it sit in the coalescing
    window — the clear is finished, and nothing about it should wait.
  */
  store.endCoalescing();
  return { kind: "cleared", batchId, operationCount: operations.length };
}
