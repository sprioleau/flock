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
  createDraftInputSchema,
  createPersonaInputSchema,
  generateImageInputSchema,
  goToVersionInputSchema,
  openPanelInputSchema,
  redoInputSchema,
  sendTestEmailInputSchema,
  showPreviewInputSchema,
  undoInputSchema,
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

/**
 * The built-in action definitions: one content action per 1.3 operation, plus
 * the two §3.4 editor-action stubs (`showPreview`, `sendTestEmail`).
 *
 * `parallelSafe` rationale:
 * - Property/text edits (`updateBlockProperties`, `replaceBlockProperties`,
 *   `updateText`) target ONE block each — same-turn concurrent execution on
 *   distinct blocks is safe (the §9.3 example).
 * - Globals edits (`updateDocumentSettings`, `applyTheme`) contend on the root
 *   block's globals — not parallel-safe.
 * - Structural ops (`addBlock`, `addSection`, `restoreBlocks`, `removeBlock`,
 *   `moveBlock`, `reorderChildren`) interact through sibling indices and
 *   parent/child links — not parallel-safe.
 */

interface ContentOperationActionInput<TSchema extends z.ZodType> {
  name: string;
  schema: TSchema;
  parallelSafe: boolean;
}

/**
 * Wrap one 1.3 operation as a content action. The op schema doubles as the
 * full validation schema, its `.describe()` text as the tool description, and
 * the pure hook is exactly `applyOperation`. `agentInputSchema` is left
 * defaulted (= full schema) for now — Phase 3 tunes compact variants where the
 * full unions prove too heavy to advertise per-request.
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

// --- Content actions (one per 1.3 operation) -----------------------------------

export const updateBlockPropertiesAction = defineContentOperationAction({
  name: "updateBlockProperties",
  schema: updateBlockPropertiesOperationSchema,
  parallelSafe: true, // distinct-block property edits are independent
});

export const replaceBlockPropertiesAction = defineContentOperationAction({
  name: "replaceBlockProperties",
  schema: replaceBlockPropertiesOperationSchema,
  parallelSafe: true, // distinct-block property replaces are independent
});

export const updateDocumentSettingsAction = defineContentOperationAction({
  name: "updateDocumentSettings",
  schema: updateDocumentSettingsOperationSchema,
  parallelSafe: false, // contends on root globals
});

export const applyThemeAction = defineContentOperationAction({
  name: "applyTheme",
  schema: applyThemeOperationSchema,
  parallelSafe: false, // contends on root globals
});

export const addBlockAction = defineContentOperationAction({
  name: "addBlock",
  schema: addBlockOperationSchema,
  parallelSafe: false, // structural: sibling indices shift
});

export const addSectionAction = defineContentOperationAction({
  name: "addSection",
  schema: addSectionOperationSchema,
  parallelSafe: false, // structural: sibling indices shift
});

export const restoreBlocksAction = defineContentOperationAction({
  name: "restoreBlocks",
  schema: restoreBlocksOperationSchema,
  parallelSafe: false, // structural: sibling indices shift
});

/**
 * removeBlock is the one content op with a resolveOperation hook on an
 * Operation-shaped input: live removals default `shouldRemoveEmptyAncestors`
 * to true (empty columns/rows collapse, sibling widths re-equalize — one op,
 * one undo). The RESOLVED, explicit flag is what reaches the op log, so
 * historical un-flagged operations keep replaying without the cascade.
 */
export const removeBlockAction = defineEmailAction({
  name: "removeBlock",
  description: removeBlockOperationSchema.description ?? "",
  kind: "content",
  schema: removeBlockOperationSchema,
  readOnly: false,
  parallelSafe: false, // structural: cascades and shifts sibling indices
  needsApproval: false,
  resolveOperation: (_doc, op) => ({ isOk: true, op: withRemoveBlockCascadeDefault(op) }),
  run: (doc, op) => applyOperation(doc, op as Operation),
});

export const moveBlockAction = defineContentOperationAction({
  name: "moveBlock",
  schema: moveBlockOperationSchema,
  parallelSafe: false, // structural: two parents' children change
});

export const reorderChildrenAction = defineContentOperationAction({
  name: "reorderChildren",
  schema: reorderChildrenOperationSchema,
  parallelSafe: false, // structural: whole-sibling-list permutation
});

export const placeBlockBesideAction = defineContentOperationAction({
  name: "placeBlockBeside",
  schema: placeBlockBesideOperationSchema,
  parallelSafe: false, // structural: rewires a section/row's children
});

export const unplaceBlockBesideAction = defineContentOperationAction({
  name: "unplaceBlockBeside",
  schema: unplaceBlockBesideOperationSchema,
  parallelSafe: false, // structural: rewires a section/row's children
});

export const updateTextAction = defineContentOperationAction({
  name: "updateText",
  schema: updateTextOperationSchema,
  parallelSafe: true, // distinct-block whole-doc text replaces are independent
});

/** Every built-in content action whose input IS a 1.3 operation (one per op). */
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

// --- Editor actions (§3.4 stubs) -------------------------------------------------

export const showPreviewAction = defineEmailAction({
  name: "showPreview",
  description:
    "Switch the editor canvas preview between desktop and mobile viewports. A UI command — the email document is unchanged.",
  kind: "editor",
  schema: showPreviewInputSchema,
  readOnly: false, // changes what's on the user's screen
  parallelSafe: false, // last viewport wins; concurrent flips are meaningless
  needsApproval: false,
  run: (input): ShowPreviewCommand => ({ type: "showPreview", mode: input.mode }),
});

/**
 * The §9.4 canonical `needsApproval` example: sending email is human-gated.
 *
 * It is also the first `authorize` consumer, and the two gates are asking
 * different questions. `needsApproval: true` asks a human to bless THIS send,
 * and is honoured only where a human is present to be asked — inside the agent
 * loop, via the chat route's `toolApproval` mapping. `authorize` asks whether
 * the caller may send AT ALL, and is enforced inside `run`, so it holds on
 * every path into this action rather than only the one with a chat window
 * attached. The HTTP send route grew the same requirement directly; this gives
 * the agent path the guarantee instead of assuming the loop provides it.
 *
 * The bar is attribution, deliberately the lowest one there is: an invocation
 * must name a caller. `authorId` is the only identity `ActionContext` carries,
 * so "identified" can mean nothing stronger here than "non-empty `authorId`" —
 * and a missing context is refused outright by the gate itself. Note what that
 * does and does not buy: `authorId` is SELF-ASSERTED provenance stamped by the
 * surface, not a verified principal, so this makes every send attributable to
 * something a surface was willing to name; it does not prove who that is.
 * Verified identity is the surface's job — resolve it before dispatch (the
 * send route does exactly that against the signed token Convex verifies) — and
 * expressing it in the envelope would need a field `ActionContext` does not
 * have today. Adding one is a deliberate decision, not a detail to slip in
 * here.
 */
export const sendTestEmailAction = defineEmailAction({
  name: "sendTestEmail",
  description:
    "Send a test version of the current email to one recipient for review. Requires human approval before executing.",
  kind: "editor",
  schema: sendTestEmailInputSchema,
  readOnly: false, // external side effect (an email leaves the building)
  parallelSafe: false,
  needsApproval: true,
  authorize: (_input, context) => context.authorId.trim().length > 0,
  run: (input): SendTestEmailCommand => ({ type: "sendTestEmail", to: input.to }),
});

/**
 * AI image generation (intent-level args, §9.3): `run` produces the UNFULFILLED
 * generateImage command; the app executor is effectful — it generates the
 * image, uploads the binary to durable storage, and streams the FULFILLED
 * command (src + alt). The pure-doc consequence is ONE updateBlockProperties
 * operation the client dispatches through the normal validated spine — image
 * bytes never enter the op log or block properties.
 *
 * No approval gate: generation only touches the targeted image block and the
 * resulting op is undoable (undo restores the previous src). Not parallel-safe:
 * each call is one slow, billed model request — keep them sequential within a
 * turn so costs and failures stay legible.
 */
export const generateImageAction = defineEmailAction({
  name: "generateImage",
  description: generateImageInputSchema.description ?? "",
  kind: "editor",
  schema: generateImageInputSchema,
  readOnly: false, // effectful: a billed generation + storage upload
  parallelSafe: false,
  needsApproval: false,
  run: (input): GenerateImageCommand => ({
    type: "generateImage",
    blockId: input.blockId,
    prompt: input.prompt,
  }),
});

// --- Agent-parity UI actions -----------------------------------------------------
//
// "Anything the human can do and refer to in the UI should be doable by the
// agent" (owner directive). Each of these is a pure editor action whose `run`
// produces a typed command; the client executes it against the SAME machinery
// the human's own controls use (panel open states, the toolbar undo/redo, the
// history panel's restore, the drafts bar's createDocument, the persona
// picker's createPersona mutation).

export const openPanelAction = defineEmailAction({
  name: "openPanel",
  description:
    "Open one of the editor's UI panels or dialogs for the user (theme picker, brand kit, asset library, agent personas, recommendations history, version history, blocks tab, properties tab, or the send-test dialog). A UI command — the email document is unchanged.",
  kind: "editor",
  schema: openPanelInputSchema,
  readOnly: false, // changes what's on the user's screen
  parallelSafe: false, // last surface wins; concurrent opens are meaningless
  needsApproval: false,
  run: (input): OpenPanelCommand => ({ type: "openPanel", panel: input.panel }),
});

export const undoAction = defineEmailAction({
  name: "undo",
  description:
    "Undo the most recent change to the email document — the same single history step as the toolbar's Undo button. Use when the user asks to undo, revert, or take back the last change.",
  kind: "editor",
  schema: undoInputSchema,
  readOnly: false, // steps the document's history back
  parallelSafe: false, // history steps are strictly ordered
  needsApproval: false,
  run: (): UndoCommand => ({ type: "undo" }),
});

export const redoAction = defineEmailAction({
  name: "redo",
  description:
    "Redo the most recently undone change to the email document — the same single history step as the toolbar's Redo button.",
  kind: "editor",
  schema: redoInputSchema,
  readOnly: false, // steps the document's history forward
  parallelSafe: false, // history steps are strictly ordered
  needsApproval: false,
  run: (): RedoCommand => ({ type: "redo" }),
});

/**
 * Approval-gated like sendTestEmail: a restore rewrites the working document
 * wholesale (destructive-feeling even though the restore is itself one more
 * history entry), so the human confirms via the approval chip first.
 */
export const goToVersionAction = defineEmailAction({
  name: "goToVersion",
  description:
    "Restore the email document to an earlier numbered version from the version history. The restore is applied as a new history entry (nothing is lost). Requires human approval before executing.",
  kind: "editor",
  schema: goToVersionInputSchema,
  readOnly: false, // rewrites the working document to a past state
  parallelSafe: false,
  needsApproval: true,
  run: (input): GoToVersionCommand => ({ type: "goToVersion", version: input.version }),
});

/**
 * THE way to make a new email that is not the one on screen. Give it a
 * `drafts` plan and each entry becomes a complete, ready-to-send email in the
 * drafts bar — the same affordance the human has from the drafts bar, with
 * content. The SDK fills in whatever the plan leaves out (see compose-draft):
 * a missing header/body/footer, the current theme, the current draft's own
 * headline/CTA/brand, and real structural variation between siblings.
 *
 * The `count`-only form is preserved verbatim: N empty starter drafts, the
 * pre-composition behavior, for "just give me a blank one to fill in".
 */
export const createDraftAction = defineEmailAction({
  name: "createDraft",
  description:
    "Create one or more NEW drafts in the drafts bar (max 5 per call), each a complete email of its own — header, body sections, and footer. The user's current draft is never modified and stays active. Give a `drafts` plan (one entry per draft: an optional name plus its sections, each a section-catalog templateId with its copy) whenever the user wants a new email, another version, or a few ideas to compare; for several at once, make the entries genuinely different from one another. New drafts keep the theme currently applied, and any copy you leave out is carried over from the draft the user is looking at. Use the bare `count` form ONLY when the user explicitly wants empty starter drafts to fill in themselves. Never rebuild or clear the current draft in order to produce a new one.",
  kind: "editor",
  schema: createDraftInputSchema,
  readOnly: false, // adds drafts to the user's canvas
  parallelSafe: false, // draft names are allocated sequentially
  needsApproval: false,
  run: (input): CreateDraftCommand => resolveCreateDraftCommand(input),
});

/**
 * Like generateImage, `run` produces the UNFULFILLED intent; the app executor
 * creates the session-owned persona row server-side (advisory capability and
 * per-session quota are enforced by the Convex mutation) and streams the
 * fulfilled command carrying the new slug.
 */
export const createPersonaAction = defineEmailAction({
  name: "createPersona",
  description:
    "Create a new advisory persona (a specialized reviewer agent, e.g. an accessibility advocate) for this session. The persona reviews the email as the user works and leaves recommendations; it can never edit the document. Give it a short name, a one-sentence description, and optionally detailed behavior instructions.",
  kind: "editor",
  schema: createPersonaInputSchema,
  readOnly: false, // creates a session-owned persona row
  parallelSafe: false, // per-session quota + slug allocation are sequential
  needsApproval: false,
  run: (input): CreatePersonaCommand => ({
    type: "createPersona",
    name: input.name,
    description: input.description,
    ...(input.behavior === undefined ? {} : { behavior: input.behavior }),
  }),
});

/** Every built-in editor action. */
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
] as const;

// --- Analysis actions (read-only reads of the rendered email) --------------------
//
// The first built-in analysis action. getBlockDetails (§9.4) lives in
// @flock/agent because it wraps that package's describeBlock; this one belongs
// HERE, because everything it wraps — the renderers — is already in this
// package, and the sdk cannot depend on the agent.

/**
 * Lets the agent look at what it just built. The rendering pipeline was
 * already reachable from the browser (POST /api/render backs the preview
 * dialog) and from nowhere else, so the agent could edit an email it had no
 * way to read. See ./inspect-rendered-email for why the result is the
 * plain-text rendering plus size facts rather than the HTML.
 */
export { inspectRenderedEmailAction };

/** Every built-in analysis action. */
export const analysisEmailActions = [inspectRenderedEmailAction] as const;

/**
 * The static registry of all built-in actions. Phase 3 feeds
 * `toAISDKToolDefinitions(emailActionRegistry)` to the AI route and routes
 * tool calls through `dispatchContentAction` / `dispatchEditorAction`.
 *
 * styleTextSpan (defined in ./style-text-span with its intent→updateText
 * translation) registers after the op-mirroring content actions: it is a
 * content action too — the chat client applies it through the same
 * validateAndClassifyOp → store-dispatch path as every other content op.
 * scaffoldSection (Phase 7.2, ./scaffold-section) follows the same pattern:
 * an intent-shaped content action whose resolveOperation hook translates
 * `{ templateId, position, params }` into one canonical addSection op.
 */
export const emailActionRegistry = createActionRegistry([
  ...contentEmailActions,
  styleTextSpanAction,
  scaffoldSectionAction,
  ...editorEmailActions,
  ...analysisEmailActions,
]);
