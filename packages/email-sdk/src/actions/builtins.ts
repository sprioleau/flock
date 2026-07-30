import type { z } from "zod";
import { applyOperation } from "../operations/apply";
import {
  addBlockOperationSchema,
  addSectionOperationSchema,
  applyThemeOperationSchema,
  moveBlockOperationSchema,
  removeBlockOperationSchema,
  reorderChildrenOperationSchema,
  replaceBlockPropertiesOperationSchema,
  restoreBlocksOperationSchema,
  updateBlockPropertiesOperationSchema,
  updateDocumentSettingsOperationSchema,
  updateTextOperationSchema,
  type Operation,
} from "../operations/ops";
import { defineEmailAction, type ContentEmailAction } from "./define";
import {
  sendTestEmailInputSchema,
  showPreviewInputSchema,
  type SendTestEmailCommand,
  type ShowPreviewCommand,
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

export const removeBlockAction = defineContentOperationAction({
  name: "removeBlock",
  schema: removeBlockOperationSchema,
  parallelSafe: false, // structural: cascades and shifts sibling indices
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

/** The §9.4 canonical `needsApproval` example: sending email is human-gated. */
export const sendTestEmailAction = defineEmailAction({
  name: "sendTestEmail",
  description:
    "Send a test version of the current email to one recipient for review. Requires human approval before executing.",
  kind: "editor",
  schema: sendTestEmailInputSchema,
  readOnly: false, // external side effect (an email leaves the building)
  parallelSafe: false,
  needsApproval: true,
  run: (input): SendTestEmailCommand => ({ type: "sendTestEmail", to: input.to }),
});

/** Every built-in editor action. */
export const editorEmailActions = [showPreviewAction, sendTestEmailAction] as const;

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
]);
