import "server-only";
import {
  ACTION_ERROR_FAILURE_KINDS,
  dispatchContentAction,
  emailActionRegistry,
  emailDocumentSchema,
  type ActionContext,
  type ActionFailureKind,
  type Operation,
} from "@flock/email-sdk";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { fetchAuthMutation, fetchAuthQuery } from "@/lib/auth/auth-server";

/*
  Running ONE content action without a browser: load the stored document,
  dispatch through the SDK action registry, persist through THE write path.

  The gap this closes. Every `kind: "content"` action is registered in
  app/api/chat/tools.ts with NO `execute()` — the tool call streams to the
  client and lib/editor-store.ts applies it. That store was the only non-test
  caller of `dispatchContentAction`, so the registry's most important actions
  could only ever run inside a live editor session. This module is the second
  caller, and it needs no editor.

  DELIBERATELY NARROW. `updateText` is the one action proven end to end here
  (module test: stored text changes, op row lands with the caller's
  provenance, the recorded inverse really inverts). `name` is a parameter
  rather than a constant because that is the shape the dispatcher already
  has — not a claim that every other content action is verified through this
  path. The sync-doc policy, called out where it bites below, is the
  remaining thing a generalisation has to settle; the other one — the
  dispatcher's discarded "ready-to-persist" log entry — is settled: it no
  longer exists, and the seven lines that persist here are the whole
  contract a second headless surface has to copy.

  NOT AN ENDPOINT, and that is a security property rather than an omission.
  Documents are capability-scoped — convex/documents.ts: "the document id is
  the capability — anyone holding it may read and write" — so an externally
  reachable headless write path would widen that capability to anyone who can
  guess or leak an id, with no session in the way. This module adds no HTTP
  route, no Convex HTTP action, and no other reachable surface; `server-only`
  keeps it out of client bundles, and the only way to call it is from
  server-side code that has already decided the caller may act.
*/

/*
  The two Convex calls this slice makes, as an injectable port.

  A port rather than a direct import because the production reader
  (`fetchAuthQuery`) is REQUEST-SCOPED: it resolves the caller's Convex token
  out of Next's request cookies, so it works from a route handler, server
  component, or server action, and throws outside one. A cron, a CLI, or a
  test has no request to read, and each supplies its own transport instead.
  The module still owns WHICH functions get called — the signatures are typed
  off those exact function references, so no implementation can quietly
  substitute a different write path.
*/
export interface StoredDocumentBackend {
  /*
    `documents.getDocument` — the head document plus its metadata, or null.
  */
  getDocument: (
    args: FunctionArgs<typeof api.documents.getDocument>,
  ) => Promise<FunctionReturnType<typeof api.documents.getDocument>>;
  /*
    `documents.applyOperations` — THE write path (see the routing note below).
  */
  applyOperations: (
    args: FunctionArgs<typeof api.documents.applyOperations>,
  ) => Promise<FunctionReturnType<typeof api.documents.applyOperations>>;
}

/*
  The production transport: the caller's own signed Convex token, forwarded
  from the surrounding Next request. Same helpers `/api/chat` already reads
  documents with (see app/api/chat/generation-brief.ts), so this module gets
  no more reach into Convex than the routes beside it.
*/
export function createNextServerBackend(): StoredDocumentBackend {
  return {
    getDocument: (args) => fetchAuthQuery(api.documents.getDocument, args),
    applyOperations: (args) => fetchAuthMutation(api.documents.applyOperations, args),
  };
}

/*
  One structured failure. `code` stays a string: it spans SDK codes and Convex transport codes.
*/
export interface StoredActionError {
  code: string;
  message: string;
  /*
    The block the failure is about, when the error names one.
  */
  blockId?: string;
}

export type RunStoredContentActionResult =
  | {
      isOk: true;
      /*
        The document's head version after the write. Exactly one operation is
        sent per call, so this is also the version the operation landed at.
      */
      headVersion: number;
      /*
        The canonical operation that was persisted — for an intent-shaped
        action (styleTextSpan) the RESOLVED operation, never the intent.
      */
      op: Operation;
    }
  | {
      isOk: false;
      /*
        Which half failed. Worth discriminating because the halves fail for
        different reasons: "load" is a missing or unreadable document,
        "dispatch" is the SDK refusing the input (or the authorization gate
        refusing the caller) before anything was written, and "persist" is
        Convex rejecting the operation against the AUTHORITATIVE document,
        which can differ from the one we read.
      */
      stage: "load" | "dispatch" | "persist";
      /*
        "retryable" → one repair round-trip; "terminal" → stop.
      */
      failureKind: ActionFailureKind;
      errors: StoredActionError[];
    };

export interface RunStoredContentActionInput {
  /*
    Where the document is read from and written to.
  */
  backend: StoredDocumentBackend;
  documentId: Id<"documents">;
  /*
    The content action to run. `updateText` is the one this slice proves.
  */
  name: string;
  /*
    Raw, unvalidated input — the dispatcher re-validates it against the action's FULL schema.
  */
  input: unknown;
  /*
    Caller provenance, stamped onto the operation row.

    `authorId` is SELF-ASSERTED, not a verified principal: nothing here (and
    nothing in documents.applyOperations) checks that the caller is who the
    field says. History attribution therefore records a claim, not a proof.
    That is a known open item for the headless path, not something this slice
    fixes — the fix is an authenticated caller identity resolved by the
    surface and handed in here, which needs a surface to exist first.
  */
  context: ActionContext;
}

/*
  Codes the SDK classifies terminal, as a set, so a transport `string` can be checked without a cast.
*/
const TERMINAL_ERROR_CODES = new Set(
  Object.entries(ACTION_ERROR_FAILURE_KINDS)
    .filter(([, failureKind]) => failureKind === "terminal")
    .map(([code]) => code),
);

/*
  Classify errors that came back over the wire, where `code` is a plain
  string. Same rule as the SDK's `classifyActionErrors` — one terminal error
  poisons the batch — and an unrecognised code reads retryable, which is that
  function's default too.
*/
function classifyTransportErrors(errors: readonly StoredActionError[]): ActionFailureKind {
  return errors.some((error) => TERMINAL_ERROR_CODES.has(error.code)) ? "terminal" : "retryable";
}

/*
  Run one content action against the stored document.

  Never throws for an expected failure — a missing document, a bad input, an
  action that is not a content action, and a server-side rejection all come
  back as the failure arm. A headless caller has no repair UI, so a thrown
  error would be indistinguishable from a bug.

  WHY documents.applyOperations AND NOT agentText.applyAgentTextEdit, which
  also takes an `updateText` op. Both record the identical operation row
  through `commitVersions`, so the history spine is the same either way; they
  differ only in what they do to the block's live ProseMirror sync doc.
  `applyAgentTextEdit` MERGES via a targeted server-side transform under
  AI_AGENT_CLIENT_ID, and pulses agent presence in the document's room — it
  exists for the agent editing ALONGSIDE a human in an open editor, which is
  a session this caller is not in. `applyOperations` instead force-writes the
  committed text back to the sync doc, and it does so precisely because we
  are headless: its `shouldForceTextSyncDocs` is
  `caller !== "frontend" || author === "agent"`, and the rule that flag
  encodes (convex/model/emailDocuments.ts, commitVersions) names "non-frontend
  callers (cli / mcp / http / tool)" as force-write-back cases by design. Its
  own live-entry normalization comment ends "this catches raw http/cli/mcp
  callers". So the write path already assigns this caller to applyOperations;
  routing through agentText would be claiming a live editing session we do not
  have, and would also narrow this module to `updateText` — the one content
  action agentText accepts.

  The accepted cost of that choice, stated plainly: if someone has the block
  open right now, a headless write replaces their in-flight sync-doc content
  rather than rebasing onto it. That is the documented policy for
  non-frontend callers, not a gap opened here — but it is the reason a
  headless write is an authoritative act and should be gated like one.
*/
export async function runStoredContentAction({
  backend,
  documentId,
  name,
  input,
  context,
}: RunStoredContentActionInput): Promise<RunStoredContentActionResult> {
  const payload = await backend.getDocument({ documentId });
  if (payload === null) {
    return {
      isOk: false,
      stage: "load",
      failureKind: "retryable",
      errors: [{ code: "target_not_found", message: `Document ${documentId} does not exist.` }],
    };
  }

  /*
    The stored doc arrives as `Record<string, any>` — convex/schema.ts types it
    `v.record(v.string(), v.any())` and leaves the shape to the SDK's Zod
    schema, which is what that field's comment says to use. Parsing rather
    than asserting is what makes the typed EmailDocument honest here, and it
    is also the only structural check on the wire boundary a headless caller
    crosses.
  */
  const parsedDoc = emailDocumentSchema.safeParse(payload.doc);
  if (!parsedDoc.success) {
    return {
      isOk: false,
      stage: "load",
      failureKind: "terminal",
      errors: [
        {
          code: "schema_validation_failed",
          message: `Stored document ${documentId} is not a valid email document: ${parsedDoc.error.issues
            .map((issue) => issue.message)
            .join("; ")}`,
        },
      ],
    };
  }

  /*
    The same dispatcher the editor store calls, on the same registry. This is
    where the action's FULL schema, its intent→operation resolution, and its
    authorization gate all run — and running them here is the whole point:
    the headless path earns the registry's guarantees instead of re-deriving
    a weaker set of its own.
  */
  const dispatched = dispatchContentAction({
    registry: emailActionRegistry,
    doc: parsedDoc.data,
    name,
    input,
    context,
  });
  if (!dispatched.isOk) {
    return {
      isOk: false,
      stage: "dispatch",
      failureKind: dispatched.failureKind,
      errors: dispatched.errors.map((error) => ({
        code: error.code,
        message: error.message,
        ...(error.blockId !== undefined ? { blockId: error.blockId } : {}),
      })),
    };
  }

  /*
    Persisting is now a single forward of the dispatch result: its canonical
    `op`, under the `context` it echoes back. Nothing about the row is
    authored here.

    This used to be the place where a "ready-to-persist" OperationLogEntry got
    thrown away — the dispatcher built one, applyOperations could not accept
    one, and only `.op` survived. The entry is gone rather than accommodated,
    because the write path recomputing the inverse is CORRECT and must stay:
    the document we dispatched against is a read, not a transaction, so an
    inverse computed from it can be stale, and updateText inverses additionally
    need re-anchoring to the op log (withOpLogTextInverses). An entry carrying
    an inverse the server must ignore is a shape that lies. Taking `context`
    off the result rather than off this function's own parameter is what makes
    the provenance the server records and the provenance the authorization
    gate saw the same value by construction, not by the caller's care.
  */
  const persisted = await backend.applyOperations({
    documentId,
    ops: [dispatched.op],
    context: dispatched.context,
  });
  if (!persisted.isOk) {
    const errors = persisted.errors.map((error) => ({
      code: error.code,
      message: error.message,
      ...(error.blockId !== undefined ? { blockId: error.blockId } : {}),
    }));
    return {
      isOk: false,
      stage: "persist",
      failureKind: classifyTransportErrors(errors),
      errors,
    };
  }
  return { isOk: true, headVersion: persisted.headVersion, op: dispatched.op };
}
