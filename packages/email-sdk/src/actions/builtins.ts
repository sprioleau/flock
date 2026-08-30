import type { z } from "zod";
import { applyOperation } from "../operations/apply";
import {
  addBlockOperationSchema,
  addSectionOperationSchema,
  applyThemeOperationSchema,
  moveBlockOperationSchema,
  placeBlockBesideOperationSchema,
  removeBlockOperationSchema,
  reorderChildrenOperationSchema,
  replaceBlockPropertiesOperationSchema,
  restoreBlocksOperationSchema,
  unplaceBlockBesideOperationSchema,
  updateBlockPropertiesOperationSchema,
  updateDocumentSettingsOperationSchema,
  updateTextOperationSchema,
  withRemoveBlockCascadeDefault,
  type Operation,
} from "../operations/ops";
import { resolveCreateDraftCommand } from "./compose-draft";
import { defineEmailAction, type ContentEmailAction } from "./define";
import { inspectRenderedEmailAction } from "./inspect-rendered-email";
import {
  applyThemeToDraftInputSchema,
  createDraftInputSchema,
  createPersonaInputSchema,
  generateImageInputSchema,
  goToVersionInputSchema,
  openPanelInputSchema,
  redoInputSchema,
  sendTestEmailInputSchema,
  showPreviewInputSchema,
  undoInputSchema,
  type ApplyThemeToDraftCommand,
  type CreateDraftCommand,
  type CreatePersonaCommand,
  type GenerateImageCommand,
  type GoToVersionCommand,
  type OpenPanelCommand,
  type RedoCommand,
  type SendTestEmailCommand,
  type ShowPreviewCommand,
  type UndoCommand,
} from "./editor-commands";
import { createActionRegistry } from "./registry";
import { scaffoldSectionAction } from "./scaffold-section";
import { styleTextSpanAction } from "./style-text-span";

/*
  The built-in action definitions: one content action per 1.3 operation, plus
  the two §3.4 editor-action stubs (`showPreview`, `sendTestEmail`).

  `parallelSafe` rationale:
  - Property/text edits (`updateBlockProperties`, `replaceBlockProperties`,
    `updateText`) target ONE block each — same-turn concurrent execution on
    distinct blocks is safe (the §9.3 example).
  - Globals edits (`updateDocumentSettings`, `applyTheme`) contend on the root
    block's globals — not parallel-safe.
  - Structural ops (`addBlock`, `addSection`, `restoreBlocks`, `removeBlock`,
    `moveBlock`, `reorderChildren`) interact through sibling indices and
    parent/child links — not parallel-safe.
*/

interface ContentOperationActionInput<TSchema extends z.ZodType> {
  name: string;
  schema: TSchema;
  parallelSafe: boolean;
}

/*
  Wrap one 1.3 operation as a content action. The op schema doubles as the
  full validation schema, its `.describe()` text as the tool description, and
  the pure hook is exactly `applyOperation`. `agentInputSchema` is left
  defaulted (= full schema) for now — Phase 3 tunes compact variants where the
  full unions prove too heavy to advertise per-request.
*/
function defineContentOperationAction<TSchema extends z.ZodType>({
  name,
  schema,
  parallelSafe,
}: ContentOperationActionInput<TSchema>): ContentEmailAction<TSchema> {
  return defineEmailAction({
    name,
    description: schema.description ?? "",
    kind: "content",
    schema,
    readOnly: false,
    parallelSafe,
    needsApproval: false,
    run: (doc, op) => applyOperation(doc, op as Operation),
  });
}

/*
  --- Content actions (one per 1.3 operation) -----------------------------------
*/

export const updateBlockPropertiesAction = defineContentOperationAction({
  name: "updateBlockProperties",
  schema: updateBlockPropertiesOperationSchema,
  parallelSafe: true, /* distinct-block property edits are independent */
});

export const replaceBlockPropertiesAction = defineContentOperationAction({
  name: "replaceBlockProperties",
  schema: replaceBlockPropertiesOperationSchema,
  parallelSafe: true, /* distinct-block property replaces are independent */
});

export const updateDocumentSettingsAction = defineContentOperationAction({
  name: "updateDocumentSettings",
  schema: updateDocumentSettingsOperationSchema,
  parallelSafe: false, /* contends on root globals */
});

export const applyThemeAction = defineContentOperationAction({
  name: "applyTheme",
  schema: applyThemeOperationSchema,
  parallelSafe: false, /* contends on root globals */
});

export const addBlockAction = defineContentOperationAction({
  name: "addBlock",
  schema: addBlockOperationSchema,
  parallelSafe: false, /* structural: sibling indices shift */
});

export const addSectionAction = defineContentOperationAction({
  name: "addSection",
  schema: addSectionOperationSchema,
  parallelSafe: false, /* structural: sibling indices shift */
});

export const restoreBlocksAction = defineContentOperationAction({
  name: "restoreBlocks",
  schema: restoreBlocksOperationSchema,
  parallelSafe: false, /* structural: sibling indices shift */
});

/*
  removeBlock is the one content op with a resolveOperation hook on an
  Operation-shaped input: live removals default `shouldRemoveEmptyAncestors`
  to true (empty columns/rows collapse, sibling widths re-equalize — one op,
  one undo). The RESOLVED, explicit flag is what reaches the op log, so
  historical un-flagged operations keep replaying without the cascade.
*/
export const removeBlockAction = defineEmailAction({
  name: "removeBlock",
  description: removeBlockOperationSchema.description ?? "",
  kind: "content",
  schema: removeBlockOperationSchema,
  readOnly: false,
  parallelSafe: false, /* structural: cascades and shifts sibling indices */
  needsApproval: false,
  resolveOperation: (_doc, op) => ({ isOk: true, op: withRemoveBlockCascadeDefault(op) }),
  run: (doc, op) => applyOperation(doc, op as Operation),
});

export const moveBlockAction = defineContentOperationAction({
  name: "moveBlock",
  schema: moveBlockOperationSchema,
  parallelSafe: false, /* structural: two parents' children change */
});

export const reorderChildrenAction = defineContentOperationAction({
  name: "reorderChildren",
  schema: reorderChildrenOperationSchema,
  parallelSafe: false, /* structural: whole-sibling-list permutation */
});

export const placeBlockBesideAction = defineContentOperationAction({
  name: "placeBlockBeside",
  schema: placeBlockBesideOperationSchema,
  parallelSafe: false, /* structural: rewires a section/row's children */
});

export const unplaceBlockBesideAction = defineContentOperationAction({
  name: "unplaceBlockBeside",
  schema: unplaceBlockBesideOperationSchema,
  parallelSafe: false, /* structural: rewires a section/row's children */
});

export const updateTextAction = defineContentOperationAction({
  name: "updateText",
  schema: updateTextOperationSchema,
  parallelSafe: true, /* distinct-block whole-doc text replaces are independent */
});

/*
  Every built-in content action whose input IS a 1.3 operation (one per op).
*/
export const contentEmailActions = [
  updateBlockPropertiesAction,
  replaceBlockPropertiesAction,
  updateDocumentSettingsAction,
  applyThemeAction,
  addBlockAction,
  addSectionAction,
  restoreBlocksAction,
  removeBlockAction,
  moveBlockAction,
  reorderChildrenAction,
  placeBlockBesideAction,
  unplaceBlockBesideAction,
  updateTextAction,
] as const;

/*
  --- Editor actions (§3.4 stubs) -------------------------------------------------
*/

export const showPreviewAction = defineEmailAction({
  name: "showPreview",
  description:
    "Switch the editor canvas preview between desktop and mobile viewports. A UI command — the email document is unchanged.",
  kind: "editor",
  schema: showPreviewInputSchema,
  readOnly: false, /* changes what's on the user's screen */
  /*
    KNOWN GAP, recorded rather than hidden: the viewport flip happens in the
    browser, so "server" here means the model is told the command was
    dispatched, not that the canvas changed. The only way it does not is the
    deliberate mid-turn draft-switch drop, so the lie is small and bounded —
    unlike a history step, which routinely has nothing to do.
  */
  resultSource: "server",
  parallelSafe: false, /* last viewport wins; concurrent flips are meaningless */
  needsApproval: false,
  run: (input): ShowPreviewCommand => ({ type: "showPreview", mode: input.mode }),
});

/*
  The §9.4 canonical `needsApproval` example: sending email is human-gated.

  It is also the only action that declares BOTH authorization gates, and the
  three questions in play here are genuinely different:

  - `needsApproval: true` — should a human bless THIS send? Only answerable
    where a human is present to ask, which is the agent loop and nowhere else.
  - `requiresVerifiedCaller` — is the caller who they say they are? Enforced
    inside `run`, so it holds on every path into this action.
  - `authorize` — is the invocation attributable at all? Also inside `run`.

  WHAT CHANGED, AND WHY IT HAD TO. Until this action declared a verified-caller
  requirement, its whole bar was the `authorize` line below: name SOMEBODY.
  `authorId` is self-asserted provenance, so on the agent path — which stamps
  `threadId ?? "flock-agent"` — that bar could not be failed. The mechanism was
  unbypassable and what it asserted was close to nothing, which is a worse
  state than an honest absence: it looks like a control.

  The requirement asks for the fact a surface cannot make up. A verified caller
  is established server-side from a signed token Convex verifies, never from
  anything on the request the caller controls, and the field carrying it is
  stripped off browser-supplied provenance so client code cannot assert one.
  The bar is still deliberately the lowest one available — every browser that
  loads Flock is signed in ANONYMOUSLY on arrival, so a visitor who has never
  typed an email address passes it without noticing, exactly as on the HTTP
  send route. What no longer passes is a caller that merely wrote a name down.

  `whenNoIdentitySystem: "allow"` is the deliberate part, and it matches the
  HTTP send route's reading of the same flag verbatim: with Flock's auth flag
  off, nothing signs anyone in, `getUserIdentity()` is null in every Convex
  function, and requiring an identity would refuse EVERY send forever — a
  permanently broken feature, not a security control. Such a deployment falls
  back to exactly the bar below (an attributable caller), which is what it had
  before this requirement existed. That is honestly weaker, and it is stated
  here rather than discovered: the fix for it is turning identity on, and
  production runs with it ON, which is where the exposure actually was.

  `authorize` STAYS, unchanged, and is not redundant. It asks the attribution
  question — every send names something the log can record — and on an
  auth-off deployment it is the only bar there is. Collapsing the two into one
  field is precisely the conflation that has now caused two separate defects
  in this codebase (undo ownership, and this gate).
*/
export const sendTestEmailAction = defineEmailAction({
  name: "sendTestEmail",
  description:
    "Send a test version of the current email to one recipient for review. Requires human approval before executing.",
  kind: "editor",
  schema: sendTestEmailInputSchema,
  readOnly: false, /* external side effect (an email leaves the building) */
  /*
    The send happens server-side; the message id in the result is a verdict.
  */
  resultSource: "server",
  parallelSafe: false,
  needsApproval: true,
  requiresVerifiedCaller: { whenNoIdentitySystem: "allow" },
  authorize: (_input, context) => context.authorId.trim().length > 0,
  run: (input): SendTestEmailCommand => ({ type: "sendTestEmail", to: input.to }),
});

/*
  AI image generation (intent-level args, §9.3): `run` produces the UNFULFILLED
  generateImage command; the app executor is effectful — it generates the
  image, uploads the binary to durable storage, and streams the FULFILLED
  command (src + alt). The pure-doc consequence is ONE updateBlockProperties
  operation the client dispatches through the normal validated spine — image
  bytes never enter the op log or block properties.

  No approval gate: generation only touches the targeted image block and the
  resulting op is undoable (undo restores the previous src). Not parallel-safe:
  each call is one slow, billed model request — keep them sequential within a
  turn so costs and failures stay legible.
*/
export const generateImageAction = defineEmailAction({
  name: "generateImage",
  description: generateImageInputSchema.description ?? "",
  kind: "editor",
  schema: generateImageInputSchema,
  readOnly: false, /* effectful: a billed generation + storage upload */
  /*
    The generation and upload happen server-side; the result is a verdict.
  */
  resultSource: "server",
  parallelSafe: false,
  needsApproval: false,
  run: (input): GenerateImageCommand => ({
    type: "generateImage",
    blockId: input.blockId,
    prompt: input.prompt,
  }),
});

/*
  --- Agent-parity UI actions -----------------------------------------------------
*/
//
/*
  "Anything the human can do and refer to in the UI should be doable by the
  agent" (owner directive). Each of these is a pure editor action whose `run`
  produces a typed command; the client executes it against the SAME machinery
  the human's own controls use (panel open states, the toolbar undo/redo, the
  history panel's restore, the drafts bar's createDocument, the persona
  picker's createPersona mutation).
*/

export const openPanelAction = defineEmailAction({
  name: "openPanel",
  description:
    "Open one of the editor's UI panels or dialogs for the user (theme picker, brand kit, asset library, agent personas, recommendations history, version history, blocks tab, properties tab, or the send-test dialog). A UI command — the email document is unchanged.",
  kind: "editor",
  schema: openPanelInputSchema,
  readOnly: false, /* changes what's on the user's screen */
  /*
    Same known gap as showPreview: a bounded, screen-only dispatch report.
  */
  resultSource: "server",
  parallelSafe: false, /* last surface wins; concurrent opens are meaningless */
  needsApproval: false,
  run: (input): OpenPanelCommand => ({ type: "openPanel", panel: input.panel }),
});

export const undoAction = defineEmailAction({
  name: "undo",
  description:
    "Undo the most recent change to the email document — the same single history step as the toolbar's Undo button. Use when the user asks to undo, revert, or take back the last change.",
  kind: "editor",
  schema: undoInputSchema,
  readOnly: false, /* steps the document's history back */
  /*
    CLIENT. Only the browser's store can ask Convex whether this session has a
    step left to undo, and "nothing to undo" is a routine answer — the server
    describing an undo it never attempted is what made the agent claim a
    success it had never checked.
  */
  resultSource: "client",
  parallelSafe: false, /* history steps are strictly ordered */
  needsApproval: false,
  run: (): UndoCommand => ({ type: "undo" }),
});

export const redoAction = defineEmailAction({
  name: "redo",
  description:
    "Redo the most recently undone change to the email document — the same single history step as the toolbar's Redo button.",
  kind: "editor",
  schema: redoInputSchema,
  readOnly: false, /* steps the document's history forward */
  /*
    CLIENT, for the same reason as undo.
  */
  resultSource: "client",
  parallelSafe: false, /* history steps are strictly ordered */
  needsApproval: false,
  run: (): RedoCommand => ({ type: "redo" }),
});

/*
  Approval-gated like sendTestEmail: a restore rewrites the working document
  wholesale (destructive-feeling even though the restore is itself one more
  history entry), so the human confirms via the approval chip first.
*/
export const goToVersionAction = defineEmailAction({
  name: "goToVersion",
  description:
    "Restore the email document to an earlier numbered version from the version history. The restore is applied as a new history entry (nothing is lost). Requires human approval before executing.",
  kind: "editor",
  schema: goToVersionInputSchema,
  readOnly: false, /* rewrites the working document to a past state */
  /*
    KNOWN GAP, and the biggest one left: restoreVersion runs in the browser and
    CAN legitimately fail (invalid_version, nothing_to_restore,
    too_many_operations), and today that outcome is swallowed into a toast
    while the model is told the restore was dispatched. It stays "server" for
    now only because it is the one approval-gated client-fulfilled action, and
    moving execution off the server also moves it relative to the approval
    halt — a change that cannot be verified without a live model turn.
  */
  resultSource: "server",
  parallelSafe: false,
  needsApproval: true,
  run: (input): GoToVersionCommand => ({ type: "goToVersion", version: input.version }),
});

/*
  THE way to make a new email that is not the one on screen. Give it a
  `drafts` plan and each entry becomes a complete, ready-to-send email in the
  drafts bar — the same affordance the human has from the drafts bar, with
  content. The SDK fills in whatever the plan leaves out (see compose-draft):
  a missing header/body/footer, the current theme, the current draft's own
  headline/CTA/brand, and real structural variation between siblings.

  The `count`-only form is preserved verbatim: N empty starter drafts, the
  pre-composition behavior, for "just give me a blank one to fill in".
*/
export const createDraftAction = defineEmailAction({
  name: "createDraft",
  description:
    "Create one or more NEW drafts in the drafts bar (max 5 per call), each a complete email of its own — header, body sections, and footer. The user's current draft is never modified and stays active. Give a `drafts` plan (one entry per draft: an optional name plus its sections, each a section-catalog templateId with its copy) whenever the user wants a new email, another version, or a few ideas to compare; for several at once, make the entries genuinely different from one another. New drafts keep the theme currently applied, and any copy you leave out is carried over from the draft the user is looking at. Use the bare `count` form ONLY when the user explicitly wants empty starter drafts to fill in themselves. Never rebuild or clear the current draft in order to produce a new one.",
  kind: "editor",
  schema: createDraftInputSchema,
  readOnly: false, /* adds drafts to the user's canvas */
  /*
    The drafts are built in the BROWSER, so only the browser knows what landed
    -- how many drafts were created, the names actually allocated (they are
    deduped, so often not the ones asked for), and whether each section carried
    real copy or fell back to its template's sample text. `run` below returns
    an INTENT, not an outcome; nothing has happened when it returns.

    So the server is not entitled to answer this call. It streams the call and
    stops: no execute, and therefore no `data-editor-command` verdict either.
    The browser reports what it observed -- createAgentDrafts returns the real
    names plus per-draft composition counts, create-draft-report.ts turns them
    into the model-facing note, and runClientResultEditorTool sends it.

    This declaration is what routes the call (chat/tools.ts branches on it), so
    the two paths can never both run. Declaring it "server" again would put the
    old note back: one composed from the PLAN, accurate about what the model
    MEANT to build and structurally incapable of being wrong about it -- which
    is how the agent came to describe the section catalog's sample email as
    "built directly from your website".
  */
  resultSource: "client",
  parallelSafe: false, /* draft names are allocated sequentially */
  needsApproval: false,
  run: (input): CreateDraftCommand => resolveCreateDraftCommand(input),
});

/*
  Like generateImage, `run` produces the UNFULFILLED intent; the app executor
  creates the session-owned persona row server-side (advisory capability and
  per-session quota are enforced by the Convex mutation) and streams the
  fulfilled command carrying the new slug.
*/
export const createPersonaAction = defineEmailAction({
  name: "createPersona",
  description:
    "Create a new advisory persona (a specialized reviewer agent, e.g. an accessibility advocate) for this session. The persona reviews the email as the user works and leaves recommendations; it can never edit the document. Give it a short name, a one-sentence description, and optionally detailed behavior instructions.",
  kind: "editor",
  schema: createPersonaInputSchema,
  readOnly: false, /* creates a session-owned persona row */
  /*
    The row is created server-side; the returned slug is a verdict.
  */
  resultSource: "server",
  parallelSafe: false, /* per-session quota + slug allocation are sequential */
  needsApproval: false,
  run: (input): CreatePersonaCommand => ({
    type: "createPersona",
    name: input.name,
    description: input.description,
    ...(input.behavior === undefined ? {} : { behavior: input.behavior }),
  }),
});

/*
  Re-theme ONE draft — including a draft the user is not looking at.

  TWO THINGS THE OLD WIRING COULD NOT DO, and this is the one action that
  answers both.

  1. IT NAMES A THEME INSTEAD OF CARRYING ONE. The only way to theme anything
     used to be `applyTheme`, whose argument is a complete GlobalStyles
     object, so re-using a page's colours meant the model transcribing a dozen
     hex values out of one tool result into the next tool call. Every one of
     them is a value it could mistype or quietly improve. Here it passes
     "page", or the theme's name; the browser resolves it from the ingestion
     payload or the canvas's live kit. A colour never touches the wire.
  2. IT SAYS WHICH DRAFT. `applyTheme` targets whatever document the turn is
     pinned to, which is the user's current draft — so "theme the draft you
     just made" would have repainted the one they are looking at.

  CLIENT-RESULT for the same reason createDraft is: the browser holds the
  canvas's draft list, the kit, the transcript, and the per-document store
  registry, and it is the only party that can say whether the theme landed,
  on which draft, and whether that draft's globals actually changed. `run`
  returns an INTENT; nothing has happened when it returns.
*/
export const applyThemeToDraftAction = defineEmailAction({
  name: "applyThemeToDraft",
  description:
    "Apply an EXISTING theme to one draft — the colours and fonts read off a page you fetched this turn (theme: \"page\"), one of this canvas's saved themes by name, or the theme already on the user's draft (\"current\"). Name the draft with `draft` (its name in the drafts bar, exactly as createDraft reported it) to re-theme a draft the user is NOT looking at; omit it for their current one. NEVER pass a colour, a hex value, or a styles object — you name a theme that already exists, you do not author one. To give a BRAND-NEW draft a theme, pass `theme` to createDraft instead: a draft is born themed rather than themed afterwards.",
  kind: "editor",
  schema: applyThemeToDraftInputSchema,
  readOnly: false, /* rewrites one draft's globals */
  resultSource: "client",
  parallelSafe: false, /* contends on one document's root globals */
  needsApproval: false,
  run: (input): ApplyThemeToDraftCommand => ({
    type: "applyThemeToDraft",
    theme: input.theme,
    ...(input.draft === undefined ? {} : { draft: input.draft }),
  }),
});

/*
  Every built-in editor action.
*/
export const editorEmailActions = [
  showPreviewAction,
  sendTestEmailAction,
  generateImageAction,
  openPanelAction,
  undoAction,
  redoAction,
  goToVersionAction,
  createDraftAction,
  createPersonaAction,
  applyThemeToDraftAction,
] as const;

/*
  --- Analysis actions (read-only reads of the rendered email) --------------------
*/
//
/*
  The first built-in analysis action. getBlockDetails (§9.4) lives in
  @flock/agent because it wraps that package's describeBlock; this one belongs
  HERE, because everything it wraps — the renderers — is already in this
  package, and the sdk cannot depend on the agent.
*/

/*
  Lets the agent look at what it just built. The rendering pipeline was
  already reachable from the browser (POST /api/render backs the preview
  dialog) and from nowhere else, so the agent could edit an email it had no
  way to read. See ./inspect-rendered-email for why the result is the
  plain-text rendering plus size facts rather than the HTML.
*/
export { inspectRenderedEmailAction };

/*
  Every built-in analysis action.
*/
export const analysisEmailActions = [inspectRenderedEmailAction] as const;

/*
  The static registry of all built-in actions. Phase 3 feeds
  `toAISDKToolDefinitions(emailActionRegistry)` to the AI route and routes
  tool calls through `dispatchContentAction` / `dispatchEditorAction`.

  styleTextSpan (defined in ./style-text-span with its intent→updateText
  translation) registers after the op-mirroring content actions: it is a
  content action too — the chat client applies it through the same
  validateAndClassifyOp → store-dispatch path as every other content op.
  scaffoldSection (Phase 7.2, ./scaffold-section) follows the same pattern:
  an intent-shaped content action whose resolveOperation hook translates
  `{ templateId, position, params }` into one canonical addSection op.
*/
export const emailActionRegistry = createActionRegistry([
  ...contentEmailActions,
  styleTextSpanAction,
  scaffoldSectionAction,
  ...editorEmailActions,
  ...analysisEmailActions,
]);
