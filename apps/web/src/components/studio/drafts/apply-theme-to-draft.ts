import {
  emailDocumentSchema,
  resolveDraftTarget,
  resolveThemeReference,
  ROOT_BLOCK_ID,
  type ApplyThemeToDraftCommand,
  type EmailDocument,
  type GlobalStyles,
  type NamedTheme,
  type PageTheme,
} from "@flock/email-sdk";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { areGlobalsEqual } from "@/lib/brand-kit";
import type { ApplyThemeOutcome } from "./apply-theme-report";

/*
  The agent's applyThemeToDraft executor — the RE-THEMING half of the theme
  composition work, sitting next to createAgentDrafts because it answers the
  same question from the other end: a theme has to reach a specific draft, and
  the draft is usually not the one on screen.

  THREE FACTS THIS FUNCTION ESTABLISHES, IN THIS ORDER, and none of them
  anywhere else:

  1. WHICH DRAFT. Resolved by name against `listDocumentsByCanvas` for the
     user's CURRENT canvas. That listing is the authorization boundary and the
     only one: a name that matches nothing on this canvas resolves to nothing,
     so a draft belonging to another canvas — or another person — is not
     rejected by a check somebody could later delete, it was never a
     candidate. `getDocument` re-asserts the canvas afterwards, which is
     redundant by construction and cheap enough to keep as the second lock.
  2. WHICH THEME. Resolved from the page this turn read or from the canvas's
     LIVE kit variations — never authored. The model's tool call carries a
     name, so there is no colour on the wire to be mistyped or improved on.
  3. WHETHER ANYTHING ACTUALLY CHANGED. The target's globals are read BEFORE
     the write. A draft already wearing the theme is left alone (a no-op
     applyTheme would put a step in its history for the user to undo past) and
     reported as unchanged, because "applied!" over a draft that already
     looked like that is indistinguishable from the real thing to everyone
     except the person who has to trust it.

  WHY THE WRITE GOES STRAIGHT TO CONVEX rather than through an editor store.
  A store is only meaningful once `connectDocument` and a server snapshot have
  run, which is true of mounted frames and of nothing else — and the whole
  point here is the draft the user is NOT looking at. So this takes the route
  createAgentDrafts already takes for a draft that does not exist on screen:
  one `applyOperations` call. The active canvas picks the change up through
  the same reactive snapshot path that shows a collaborator's edit.

  Never throws. A failed apply is an outcome to report, not an exception to
  take the chat turn down with.
*/

type ListDocumentsByCanvas = typeof api.documents.listDocumentsByCanvas;
type GetDocument = typeof api.documents.getDocument;
type ApplyOperations = typeof api.documents.applyOperations;

/**
 * The Convex surface this executor uses, spelled out as the three calls it
 * makes and nothing wider — the same narrowing, for the same reason, as
 * {@link AgentDraftsConvexClient}: the browser's real client satisfies it, and
 * so does convex-test's in-memory backend, which is what lets the regression
 * tests drive this against the real `applyOperations` instead of a stub that
 * only pretends to write.
 */
export interface ApplyThemeConvexClient {
  query(
    reference: ListDocumentsByCanvas,
    args: FunctionArgs<ListDocumentsByCanvas>,
  ): Promise<FunctionReturnType<ListDocumentsByCanvas>>;
  query(
    reference: GetDocument,
    args: FunctionArgs<GetDocument>,
  ): Promise<FunctionReturnType<GetDocument>>;
  mutation(
    reference: ApplyOperations,
    args: FunctionArgs<ApplyOperations>,
  ): Promise<FunctionReturnType<ApplyOperations>>;
}

export interface ApplyThemeToDraftInput {
  convexClient: ApplyThemeConvexClient;
  /*
    The canvas the user has open — the ONLY set of drafts reachable.
  */
  canvasId: Id<"canvases">;
  /*
    The browser's anonymous session id (the undo owner).
  */
  sessionId: string;
  /*
    The resolved command from the applyThemeToDraft action.
  */
  command: ApplyThemeToDraftCommand;
  /*
    The draft the user is looking at, for an omitted / "current" target.
  */
  currentDocumentId: Id<"documents"> | null;
  /*
    The current draft's own globals, for the "current" theme reference.
  */
  currentGlobals: GlobalStyles | null;
  /*
    The page theme this turn read, or null when it read no styled page.
  */
  pageTheme: PageTheme | null;
  /*
    This canvas's LIVE kit themes — soft-deleted variations must be absent.
  */
  kitThemes: NamedTheme[];
  /*
    Author id recorded on the op (the chat thread).
  */
  authorId: string;
  /*
    This turn's agent batch, so the re-theme reverts with the rest of it.
  */
  batchId: string;
}

/*
  One document's raw globals, or null when it carries none of its own.
*/
function readDocumentGlobals(doc: EmailDocument): GlobalStyles | null {
  const root = doc[ROOT_BLOCK_ID];
  if (root === undefined || root.type !== "root") {
    return null;
  }
  const globals = root.properties.globals ?? {};
  return Object.keys(globals).length > 0 ? globals : null;
}

/*
  Re-theme one draft on the user's canvas, and report what actually happened.
*/
export async function applyThemeToDraft({
  convexClient,
  canvasId,
  sessionId,
  command,
  currentDocumentId,
  currentGlobals,
  pageTheme,
  kitThemes,
  authorId,
  batchId,
}: ApplyThemeToDraftInput): Promise<ApplyThemeOutcome> {
  const requestedDraft = command.draft ?? "current";
  try {
    const drafts = await convexClient.query(api.documents.listDocumentsByCanvas, { canvasId });
    const target = resolveDraftTarget({
      target: command.draft,
      drafts: drafts.map((draft) => ({ documentId: draft._id, name: draft.name })),
      currentDocumentId,
    });
    if (!target.isResolved) {
      return {
        kind: "draft-unresolved",
        reason: target.reason,
        requestedDraft,
        availableDraftNames: target.availableDraftNames,
      };
    }

    const theme = resolveThemeReference({
      reference: command.theme,
      pageTheme,
      kitThemes,
      currentGlobals,
    });
    if (!theme.isResolved) {
      return {
        kind: "theme-unresolved",
        reason: theme.reason,
        requestedTheme: command.theme,
        availableThemeNames: theme.availableThemeNames,
      };
    }

    const payload = await convexClient.query(api.documents.getDocument, {
      documentId: target.documentId,
    });
    /*
      The second lock. The id came out of THIS canvas's own listing, so a
      mismatch here is not reachable by a bad tool call — it would take a
      reordered listing or a moved document. Kept anyway: the cost is one
      comparison, and the failure it guards is re-theming a document on a
      canvas the user does not have open.
    */
    if (payload === null || payload.canvasId !== canvasId) {
      return {
        kind: "draft-unresolved",
        reason: "unknown-draft",
        requestedDraft,
        availableDraftNames: drafts.map((draft) => draft.name),
      };
    }

    /*
      ALREADY WEARING IT. Checked against the draft's RAW globals, exactly as
      the theme menu checks its own checkmark: applyTheme writes the payload
      verbatim, so a draft matches until a global is edited away from it.

      PARSED, NOT CAST. `getDocument` returns the document through a `v.any()`
      payload, so this is the one place its shape has to be re-established —
      and the SDK schema is what establishes it. A document that fails to
      parse (unreachable: every op that ever touched it was validated) is
      treated as an unknown before-state and the write goes ahead, because
      refusing to re-theme a draft over a shape check nobody can trip is worse
      than writing one op that may be a no-op.
    */
    const parsedDoc = emailDocumentSchema.safeParse(payload.doc);
    const previousGlobals = parsedDoc.success ? readDocumentGlobals(parsedDoc.data) : null;
    if (
      parsedDoc.success &&
      areGlobalsEqual({ a: previousGlobals ?? undefined, b: theme.globals })
    ) {
      return { kind: "already-applied", draftName: payload.name, themeName: theme.name };
    }

    const result = await convexClient.mutation(api.documents.applyOperations, {
      documentId: target.documentId,
      ops: [{ name: "applyTheme", globals: theme.globals }],
      context: {
        authorId,
        /*
          The agent made the edit; the person who asked for it owns undoing it
          — the same rule the editor store applies to every agent op, and the
          same one createAgentDrafts applies to a composed draft.
        */
        undoOwnerId: sessionId,
        author: "agent",
        caller: "tool",
        batchId,
      },
    });
    if (!result.isOk) {
      console.error("applyOperations (agent applyThemeToDraft) rejected", result.errors);
      return {
        kind: "failed",
        draftName: payload.name,
        themeName: theme.name,
        message: "the editor refused the change.",
      };
    }
    return {
      kind: "applied",
      draftName: payload.name,
      themeName: theme.name,
      themeSource: theme.source,
      ...(theme.derivedFrom === undefined ? {} : { derivedFrom: theme.derivedFrom }),
    };
  } catch (error) {
    console.error("applyThemeToDraft failed", error);
    return { kind: "unreachable" };
  }
}
