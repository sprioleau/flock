import {
  buildComposedDrafts,
  type CreateDraftCommand,
  type EmailDocument,
} from "@flock/email-sdk";
import type { ConvexReactClient } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { computeNextDraftName } from "./draft-naming";

/**
 * The agent's createDraft executor — the DRAFT-CREATION half of agent/human
 * parity, sitting next to the DraftSelector machinery it mirrors.
 *
 * Two shapes, one entry point:
 *
 * - COMPOSED (the command carries a `drafts` plan): create an EMPTY draft and
 *   apply the SDK-composed ops into it — one applyTheme (the theme the user is
 *   already looking at) plus one addSection per section. This is the same
 *   route the drafts menu's "Ideate with AI" takes (empty seed, sections
 *   added), so a composed draft has an ordinary op log, version history, and
 *   undo from birth. The ops are authored "agent" and share the turn's
 *   batchId, so the whole creation reverts as one AI batch.
 *
 * - EMPTY (no plan): the pre-composition behavior, byte for byte — N starter
 *   drafts through documents.createDocument.
 *
 * NEITHER shape activates the new drafts: the user stays exactly where they
 * are and the drafts bar updates reactively. That is the point — the agent
 * adds a draft beside the user's work instead of taking over the canvas.
 */

export interface CreateAgentDraftsInput {
  convexClient: ConvexReactClient;
  /** The canvas the new drafts join (the user's current canvas). */
  canvasId: Id<"canvases">;
  /** The browser's anonymous session id. */
  sessionId: string;
  /** The resolved command from the createDraft action. */
  command: CreateDraftCommand;
  /** The draft the user is on — the theme and content source for composition. */
  sourceDoc: EmailDocument;
  /** Author id recorded on the composed ops (the chat thread). */
  authorId: string;
}

export interface CreateAgentDraftsResult {
  createdDocumentIds: Id<"documents">[];
  /** A user-facing sentence when something went wrong, else null. */
  failureNotice: string | null;
}

/**
 * Create the drafts the agent asked for. Never throws: a partial run keeps the
 * drafts it managed to create and reports one human sentence for the caller to
 * surface — a failed draft creation must not take down the chat turn.
 */
export async function createAgentDrafts({
  convexClient,
  canvasId,
  sessionId,
  command,
  sourceDoc,
  authorId,
}: CreateAgentDraftsInput): Promise<CreateAgentDraftsResult> {
  const composedDrafts = buildComposedDrafts({ sourceDoc, command });
  const createdDocumentIds: Id<"documents">[] = [];
  try {
    const existingDrafts = await convexClient.query(api.documents.listDocumentsByCanvas, {
      canvasId,
    });
    const existingNames = existingDrafts.map((draft) => draft.name);
    const draftCount = composedDrafts.length > 0 ? composedDrafts.length : command.count;

    for (let index = 0; index < draftCount; index += 1) {
      const composed = composedDrafts[index];
      // The model's own name for the draft, deduped against the canvas the
      // same way a human's new draft is; unnamed drafts just get "Draft N".
      const name = computeNextDraftName({
        existingNames,
        ...(composed?.name === undefined ? {} : { preferredName: composed.name }),
      });
      existingNames.push(name);
      const { documentId } = await convexClient.mutation(api.documents.createDocument, {
        sessionId,
        canvasId,
        name,
        // A composed draft is built from its sections; seeding the starter
        // email first would leave someone else's copy under the new one.
        ...(composed === undefined ? {} : { shouldSeedEmpty: true }),
      });
      createdDocumentIds.push(documentId);
      if (composed !== undefined && composed.ops.length > 0) {
        // One batch per draft: the composition is ONE agent action in the new
        // draft's own history, so reverting it there empties the draft rather
        // than peeling sections off one at a time.
        const result = await convexClient.mutation(api.documents.applyOperations, {
          documentId,
          ops: composed.ops,
          context: {
            authorId,
            /*
              The agent authored the composition, but the person who asked for
              the draft owns undoing it — same rule the editor store applies to
              every agent op it dispatches (buildDispatchContext).
            */
            undoOwnerId: sessionId,
            author: "agent",
            caller: "tool",
            batchId: crypto.randomUUID(),
          },
        });
        if (!result.isOk) {
          console.error("applyOperations (agent createDraft) rejected", result.errors);
          return {
            createdDocumentIds,
            failureNotice: `"${name}" was created but couldn't be filled in — open it and try again.`,
          };
        }
      }
    }
    return { createdDocumentIds, failureNotice: null };
  } catch (error) {
    console.error("createDocument (agent createDraft) failed", error);
    return {
      createdDocumentIds,
      failureNotice:
        createdDocumentIds.length > 0
          ? "Only some of the new drafts could be created (connection error)."
          : "Couldn't create the draft (connection error).",
    };
  }
}
