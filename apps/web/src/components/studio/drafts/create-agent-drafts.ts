import {
  buildComposedDrafts,
  resolveThemeReference,
  type ComposedDraft,
  type CreateDraftCommand,
  type EmailDocument,
  type GlobalStyles,
  type NamedTheme,
  type PageTheme,
  type ThemeResolution,
} from "@flock/email-sdk";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { CreateDraftOutcome, CreatedDraftSummary } from "@/lib/create-draft-report";
import { computeNextDraftName } from "./draft-naming";

/*
  The agent's createDraft executor — the DRAFT-CREATION half of agent/human
  parity, sitting next to the DraftSelector machinery it mirrors.

  Two shapes, one entry point:

  - COMPOSED (the command carries a `drafts` plan): create an EMPTY draft and
    apply the SDK-composed ops into it — one applyTheme (the theme the user is
    already looking at) plus one addSection per section. This is the same
    route the drafts menu's "Ideate with AI" takes (empty seed, sections
    added), so a composed draft has an ordinary op log, version history, and
    undo from birth. The ops are authored "agent" and share the turn's
    batchId, so the whole creation reverts as one AI batch.

  - EMPTY (no plan): the pre-composition behavior, byte for byte — N starter
    drafts through documents.createDocument.

  NEITHER shape activates the new drafts: the user stays exactly where they
  are and the drafts bar updates reactively. That is the point — the agent
  adds a draft beside the user's work instead of taking over the canvas.

  WHAT THIS FUNCTION RETURNS IS THE TOOL RESULT'S ONLY EVIDENCE. It is the
  last place in the system that can see both what was asked for and what now
  exists, so it reports both — real names as allocated, and per draft where
  the copy came from (lib/create-draft-report.ts turns that into the sentence
  the model is entitled to say). Before this, the model's confirmation was
  assembled server-side from the plan it had sent, which is why "built
  directly from your website" was said over sample copy.
*/

type ListDocumentsByCanvas = typeof api.documents.listDocumentsByCanvas;
type CreateDocument = typeof api.documents.createDocument;
type ApplyOperations = typeof api.documents.applyOperations;

/*
  The Convex surface this executor uses — spelled out as the THREE calls it
  makes, and nothing wider.

  Narrower than `ConvexReactClient` on purpose. The browser passes the real
  client, which satisfies this; so does convex-test's in-memory backend, whose
  own `query`/`mutation` are generic over "a function reference OR an inline
  handler" and therefore not assignable to the client's exact signatures. Both
  ends being able to satisfy the same interface is what lets the regression
  test drive this whole executor against real Convex functions — no stub that
  only pretends to apply the ops, and no cast. The bug this file guards is
  about what ends up IN the created document, so the test has to run the real
  `applyOperations` and read the document back afterwards.
*/
export interface AgentDraftsConvexClient {
  query(
    reference: ListDocumentsByCanvas,
    args: FunctionArgs<ListDocumentsByCanvas>,
  ): Promise<FunctionReturnType<ListDocumentsByCanvas>>;
  mutation(
    reference: CreateDocument,
    args: FunctionArgs<CreateDocument>,
  ): Promise<FunctionReturnType<CreateDocument>>;
  mutation(
    reference: ApplyOperations,
    args: FunctionArgs<ApplyOperations>,
  ): Promise<FunctionReturnType<ApplyOperations>>;
}

export interface CreateAgentDraftsInput {
  convexClient: AgentDraftsConvexClient;
  /*
    The canvas the new drafts join (the user's current canvas).
  */
  canvasId: Id<"canvases">;
  /*
    The currently active draft. When provided, new agent drafts stay in its
    group so grouped explorations do not spill back into Ungrouped.
  */
  sourceDocumentId?: Id<"documents">;
  /*
    The browser's anonymous session id.
  */
  sessionId: string;
  /*
    The resolved command from the createDraft action.
  */
  command: CreateDraftCommand;
  /*
    The draft the user is on — the theme and content source for composition.
  */
  sourceDoc: EmailDocument;
  /*
    True when THIS turn already read something outside the email — a fetched
    page, a looked-up person (lib/ingested-source.ts).

    It decides one thing: whether the composer may fall back to the source
    draft's own copy for params the model left out. Required rather than
    optional, because the failure it prevents is silent — a caller that
    forgets it gets the old, plausible-looking wrong answer rather than an
    error, and the compiler is the only thing that will notice.
  */
  hasIngestedSource: boolean;
  /*
    Author id recorded on the composed ops (the chat thread).
  */
  authorId: string;
  /*
    The page theme this turn read, or null. Only ever consulted when the
    command NAMES it — reading a page does not silently restyle a draft.
  */
  pageTheme: PageTheme | null;
  /*
    This canvas's LIVE kit themes — soft-deleted variations must be absent.
  */
  kitThemes: NamedTheme[];
  /*
    The source draft's own globals, for a `theme: "current"` reference.
  */
  sourceGlobals: GlobalStyles | null;
}

export interface CreateAgentDraftsResult extends CreateDraftOutcome {
  createdDocumentIds: Id<"documents">[];
}

/*
  A DRAFT IS BORN THEMED, OR IT IS NOT THEMED.

  The reported failure: a turn read wesbos.com, the pipeline derived the page's
  theme correctly, and the draft it created came back with `globals: {}`. The
  model called readWebPage and createDraft and never applied the theme — and it
  was right not to, because the only theming tool it had (`applyTheme`) targets
  the turn's OWN document, so applying it would have repainted the draft the
  user was looking at instead. There was no expressible form of "theme the
  draft you are making".

  So the theme resolves HERE, before the first `createDocument` call, and rides
  the composition as one more op in the same batch. There is no second round
  trip that could land on the wrong draft, and no window in which the draft
  exists unthemed. What the model supplies is a NAME.

  A reference that resolves to nothing is NOT a failure of the call: the drafts
  are still created, inheriting the theme they would have had, and the report
  says the theme was not found and lists the ones that exist. Failing the whole
  creation over a mistyped theme name would trade a wrong colour for a missing
  draft, and the model may not retry createDraft — a retry makes a second one.
*/
function resolveNewDraftTheme({
  command,
  pageTheme,
  kitThemes,
  sourceGlobals,
}: {
  command: CreateDraftCommand;
  pageTheme: PageTheme | null;
  kitThemes: NamedTheme[];
  sourceGlobals: GlobalStyles | null;
}): ThemeResolution | null {
  if (command.theme === undefined) {
    return null;
  }
  return resolveThemeReference({
    reference: command.theme,
    pageTheme,
    kitThemes,
    currentGlobals: sourceGlobals,
  });
}

/*
  One created draft's report line, from its name and its composition.
*/
function toCreatedDraftSummary({
  name,
  composed,
}: {
  name: string;
  composed: ComposedDraft | undefined;
}): CreatedDraftSummary {
  if (composed === undefined) {
    /*
      An empty starter draft: no sections at all, so nothing to attribute.
    */
    return {
      name,
      plannedSectionCount: 0,
      carriedOverSectionCount: 0,
      templateDefaultSectionCount: 0,
      substitutedSectionCount: 0,
      droppedSectionCount: 0,
    };
  }
  return { name, ...composed.composition };
}

/*
  Create the drafts the agent asked for. Never throws: a partial run keeps the
  drafts it managed to create and reports one human sentence for the caller to
  surface — a failed draft creation must not take down the chat turn.
*/
export async function createAgentDrafts({
  convexClient,
  canvasId,
  sourceDocumentId,
  sessionId,
  command,
  sourceDoc,
  hasIngestedSource,
  authorId,
  pageTheme,
  kitThemes,
  sourceGlobals,
}: CreateAgentDraftsInput): Promise<CreateAgentDraftsResult> {
  /*
    THE FIX FOR THE REPORTED DEFECT, in one argument. The composer's carry-over
    turns a plan's gaps into the SOURCE draft's copy, which is right for "make
    another version of this" and wrong — quietly, plausibly wrong — for "make
    one from my portfolio site". The turn already knows which of those it is.
  */
  const theme = resolveNewDraftTheme({ command, pageTheme, kitThemes, sourceGlobals });
  const composedDrafts = buildComposedDrafts({
    sourceDoc,
    command,
    shouldCarryOverSourceCopy: !hasIngestedSource,
    ...(theme !== null && theme.isResolved ? { themeGlobals: theme.globals } : {}),
  });
  const isComposed = composedDrafts.length > 0;
  const requestedCount = isComposed ? composedDrafts.length : command.count;
  const createdDocumentIds: Id<"documents">[] = [];
  const createdDrafts: CreatedDraftSummary[] = [];
  const outcomeBase = {
    requestedCount,
    isComposed,
    isSourceCopyCarryOverAllowed: !hasIngestedSource,
    theme,
  };
  try {
    const existingDrafts = await convexClient.query(api.documents.listDocumentsByCanvas, {
      canvasId,
    });
    const existingNames = existingDrafts.map((draft) => draft.name);
    const sourceGroupId = existingDrafts.find(
      (draft) => draft._id === sourceDocumentId,
    )?.groupId;

    for (let index = 0; index < requestedCount; index += 1) {
      const composed = composedDrafts[index];
      /*
        The model's own name for the draft, deduped against the canvas the
        same way a human's new draft is; unnamed drafts just get "Draft N".
      */
      const name = computeNextDraftName({
        existingNames,
        ...(composed?.name === undefined ? {} : { preferredName: composed.name }),
      });
      existingNames.push(name);
      const { documentId } = await convexClient.mutation(api.documents.createDocument, {
        sessionId,
        canvasId,
        name,
        ...(sourceGroupId === undefined ? {} : { groupId: sourceGroupId }),
        /*
          A composed draft is built from its sections; seeding the starter
          email first would leave someone else's copy under the new one.
        */
        ...(composed === undefined ? {} : { shouldSeedEmpty: true }),
      });
      createdDocumentIds.push(documentId);
      if (composed !== undefined && composed.ops.length > 0) {
        /*
          One batch per draft: the composition is ONE agent action in the new
          draft's own history, so reverting it there empties the draft rather
          than peeling sections off one at a time.
        */
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
          /*
            The row exists but its sections do not, so it is NOT reported as a
            created draft: an empty document under a name the model would go on
            to describe is exactly the kind of confident wrongness this whole
            change is about.
          */
          return {
            ...outcomeBase,
            createdDocumentIds,
            createdDrafts,
            failureNotice: `"${name}" was created but couldn't be filled in — open it and try again.`,
          };
        }
      }
      createdDrafts.push(toCreatedDraftSummary({ name, composed }));
    }
    return { ...outcomeBase, createdDocumentIds, createdDrafts, failureNotice: null };
  } catch (error) {
    console.error("createDocument (agent createDraft) failed", error);
    return {
      ...outcomeBase,
      createdDocumentIds,
      createdDrafts,
      failureNotice:
        createdDocumentIds.length > 0
          ? "Only some of the new drafts could be created (connection error)."
          : "Couldn't create the draft (connection error).",
    };
  }
}
