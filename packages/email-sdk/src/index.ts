/**
 * @flock/email-sdk — document definition, Zod schemas, operations, renderers.
 *
 * Phase 1 status: 1.1 (schemas) and 1.2 (flat store & integrity) implemented.
 * Operations (1.3) and renderers (1.4) build on this surface.
 */

export const SDK_VERSION = "0.1.0";

// --- Ids (schema/ids) -------------------------------------------------------
export {
  BLOCK_TYPES,
  CONTAINER_BLOCK_TYPES,
  LEAF_BLOCK_TYPES,
  ROOT_BLOCK_ID,
  BLOCK_ID_PREFIXES,
  BLOCK_ID_SUFFIX_LENGTH,
  generateBlockId,
  parseBlockId,
  formatBlockId,
  blockIdSchema,
  blockIdSchemasByType,
  rootBlockIdSchema,
  sectionBlockIdSchema,
  rowBlockIdSchema,
  columnBlockIdSchema,
  textBlockIdSchema,
  buttonBlockIdSchema,
  imageBlockIdSchema,
  dividerBlockIdSchema,
  linkBlockIdSchema,
  codeBlockIdSchema,
  spacerBlockIdSchema,
  leafBlockIdSchema,
} from "./schema/ids";
export type {
  BlockId,
  BlockType,
  ContainerBlockType,
  LeafBlockType,
  RandomFn,
  ParsedBlockId,
  FormatBlockIdInput,
} from "./schema/ids";

// --- Rich text (schema/text) --------------------------------------------------
export {
  textDocSchema,
  textBlockNodeSchema,
  headingNodeSchema,
  paragraphNodeSchema,
  inlineNodeSchema,
  textNodeSchema,
  hardBreakNodeSchema,
  textMarkSchema,
  boldMarkSchema,
  italicMarkSchema,
  underlineMarkSchema,
  strikeMarkSchema,
  linkMarkSchema,
  textStyleMarkSchema,
  highlightMarkSchema,
  createTextDoc,
} from "./schema/text";
export type {
  TextDoc,
  TextBlockNode,
  HeadingNode,
  ParagraphNode,
  InlineNode,
  TextNode,
  HardBreakNode,
  TextMark,
} from "./schema/text";

// --- Global styles (schema/globals) --------------------------------------------
export { globalStylesSchema, textAlignSchema, DEFAULT_GLOBAL_STYLES } from "./schema/globals";
export type { GlobalStyles, TextAlign } from "./schema/globals";

// --- Blocks (schema/blocks) ------------------------------------------------------
export {
  blockSchema,
  rootBlockSchema,
  sectionBlockSchema,
  rowBlockSchema,
  columnBlockSchema,
  textBlockSchema,
  buttonBlockSchema,
  imageBlockSchema,
  dividerBlockSchema,
  linkBlockSchema,
  codeBlockSchema,
  spacerBlockSchema,
  CODE_BLOCK_LANGUAGES,
  CODE_BLOCK_THEMES,
  BORDER_STYLES,
  borderStyleSchema,
} from "./schema/blocks";
export type {
  Block,
  BorderStyle,
  RootBlock,
  SectionBlock,
  RowBlock,
  ColumnBlock,
  TextBlock,
  ButtonBlock,
  ImageBlock,
  DividerBlock,
  LinkBlock,
  CodeBlock,
  SpacerBlock,
  CodeBlockLanguage,
  CodeBlockTheme,
  ContainerBlock,
  LeafBlock,
} from "./schema/blocks";

// --- Flat store (store/document) ----------------------------------------------
export {
  emailDocumentSchema,
  createEmptyDocument,
  createSampleDocument,
  createStarterDocument,
} from "./store/document";
export type { EmailDocument } from "./store/document";
export { createDemoDocument } from "./store/demo-document";

// --- Tree derivation (store/tree) ------------------------------------------------
export { inflate, deflate } from "./store/tree";
export type { EmailTree, EmailTreeNode } from "./store/tree";

// --- Integrity (store/integrity) ----------------------------------------------------
export { checkDocumentIntegrity, ALLOWED_CHILD_TYPES } from "./store/integrity";
export type {
  IntegrityCheckResult,
  IntegrityError,
  IntegrityErrorCode,
} from "./store/integrity";

// --- Renderers (render) ---------------------------------------------------------------
export {
  resolveGlobalStyles,
  resolveBlockStyles,
  resolveRootBlockStyles,
} from "./render/styles";
export type {
  ResolvedPadding,
  ResolvedRootStyles,
  ResolvedSectionStyles,
  ResolvedRowStyles,
  ResolvedColumnStyles,
  ResolvedTextNodeStyles,
  ResolvedTextStyles,
  ResolvedButtonStyles,
  ResolvedImageStyles,
  ResolvedDividerStyles,
  ResolvedLinkStyles,
  ResolvedCodeStyles,
  ResolvedSpacerStyles,
  ResolvedStylesByBlockType,
  ResolvedBlockStyles,
} from "./render/styles";
export { DocumentIntegrityError } from "./render/errors";
export { renderToReactEmail } from "./render/render-to-react-email";
export { renderToHTML } from "./render/render-to-html";
export type { RenderToHTMLOptions } from "./render/render-to-html";
export { normalizePlainText, renderToPlainText } from "./render/render-to-plain-text";
export { renderToJSON } from "./render/render-to-json";
export type { RenderedEmailNode } from "./render/render-to-json";

// Per-block wrapper views — reused by the Phase 2 editing canvas.
export { SectionBlockView } from "./render/blocks/SectionBlockView";
export type { SectionBlockViewProps } from "./render/blocks/SectionBlockView";
export { RowBlockView } from "./render/blocks/RowBlockView";
export type { RowBlockViewProps } from "./render/blocks/RowBlockView";
export { ColumnBlockView } from "./render/blocks/ColumnBlockView";
export type { ColumnBlockViewProps } from "./render/blocks/ColumnBlockView";
export { TextBlockView } from "./render/blocks/TextBlockView";
export type { TextBlockViewProps } from "./render/blocks/TextBlockView";
export { ButtonBlockView } from "./render/blocks/ButtonBlockView";
export type { ButtonBlockViewProps } from "./render/blocks/ButtonBlockView";
export { ImageBlockView } from "./render/blocks/ImageBlockView";
export type { ImageBlockViewProps } from "./render/blocks/ImageBlockView";
export { DividerBlockView } from "./render/blocks/DividerBlockView";
export type { DividerBlockViewProps } from "./render/blocks/DividerBlockView";
export { LinkBlockView } from "./render/blocks/LinkBlockView";
export type { LinkBlockViewProps } from "./render/blocks/LinkBlockView";
export { CodeBlockView } from "./render/blocks/CodeBlockView";
export type { CodeBlockViewProps } from "./render/blocks/CodeBlockView";
export { SpacerBlockView } from "./render/blocks/SpacerBlockView";
export type { SpacerBlockViewProps } from "./render/blocks/SpacerBlockView";

// --- Operations (operations/ops) --------------------------------------------------------
export {
  operationSchema,
  OPERATION_NAMES,
  updateBlockPropertiesOperationSchema,
  replaceBlockPropertiesOperationSchema,
  updateDocumentSettingsOperationSchema,
  applyThemeOperationSchema,
  addBlockOperationSchema,
  addSectionOperationSchema,
  restoreBlocksOperationSchema,
  removeBlockOperationSchema,
  moveBlockOperationSchema,
  reorderChildrenOperationSchema,
  placeBlockBesideOperationSchema,
  placeBlockBesideContentSchema,
  placeBlockBesideSideSchema,
  unplaceBlockBesideOperationSchema,
  previousColumnWidthSchema,
  updateTextOperationSchema,
  withRemoveBlockCascadeDefault,
} from "./operations/ops";
export type {
  Operation,
  OperationName,
  UpdateBlockPropertiesOperation,
  ReplaceBlockPropertiesOperation,
  UpdateDocumentSettingsOperation,
  ApplyThemeOperation,
  AddBlockOperation,
  AddSectionOperation,
  RestoreBlocksOperation,
  RemoveBlockOperation,
  MoveBlockOperation,
  ReorderChildrenOperation,
  PlaceBlockBesideOperation,
  PlaceBlockBesideContent,
  PlaceBlockBesideSide,
  UnplaceBlockBesideOperation,
  PreviousColumnWidth,
  UpdateTextOperation,
} from "./operations/ops";

// --- Applying operations (operations/apply) ------------------------------------------------
export { applyOperation, applyOperations, MAX_COLUMNS_PER_ROW } from "./operations/apply";
export type {
  ApplyOperationResult,
  ApplyOperationsResult,
  OperationError,
  OperationErrorCode,
} from "./operations/apply";

// --- Operation authorship (operations/log) ----------------------------------------------------
export { OPERATION_AUTHORS, operationAuthorSchema } from "./operations/log";
export type { OperationAuthor } from "./operations/log";

// --- Actions: caller provenance (actions/context) ---------------------------------------------
export {
  ACTION_CALLERS,
  actionCallerSchema,
  VERIFIED_CALLER_ABSENCE_REASONS,
} from "./actions/context";
export type {
  ActionCaller,
  ActionContext,
  VerifiedCaller,
  VerifiedCallerAbsenceReason,
} from "./actions/context";

// --- Actions: factory (actions/define) ---------------------------------------------------------
export {
  EMAIL_ACTION_KINDS,
  EDITOR_RESULT_SOURCES,
  NO_IDENTITY_SYSTEM_POLICIES,
  ActionAuthorizationError,
  defineEmailAction,
  resolveAuthorize,
  resolveNeedsApproval,
} from "./actions/define";
export type {
  EmailActionKind,
  EditorResultSource,
  NoIdentitySystemPolicy,
  VerifiedCallerRequirement,
  NeedsApprovalOption,
  AuthorizeOption,
  ResolveNeedsApprovalInput,
  ResolveAuthorizeInput,
  ContentEmailActionConfig,
  EditorEmailActionConfig,
  AnalysisEmailActionConfig,
  ContentEmailAction,
  EditorEmailAction,
  AnalysisEmailAction,
  AnyEmailAction,
} from "./actions/define";

// --- Actions: stop-vs-retry taxonomy (actions/taxonomy) ----------------------------------------
export {
  OPERATION_ERROR_FAILURE_KINDS,
  DISPATCH_ERROR_FAILURE_KINDS,
  ACTION_ERROR_FAILURE_KINDS,
  classifyActionErrors,
} from "./actions/taxonomy";
export type { ActionFailureKind, ActionDispatchErrorCode } from "./actions/taxonomy";

// --- Actions: editor-command channel (actions/editor-commands) ---------------------------------
export {
  PREVIEW_MODES,
  previewModeSchema,
  showPreviewInputSchema,
  showPreviewCommandSchema,
  sendTestEmailInputSchema,
  sendTestEmailCommandSchema,
  GENERATE_IMAGE_MAX_PROMPT_LENGTH,
  generateImageInputSchema,
  generateImageCommandSchema,
  UI_PANELS,
  uiPanelSchema,
  openPanelInputSchema,
  openPanelCommandSchema,
  undoInputSchema,
  undoCommandSchema,
  redoInputSchema,
  redoCommandSchema,
  goToVersionInputSchema,
  goToVersionCommandSchema,
  MAX_CREATE_DRAFT_COUNT,
  createDraftInputSchema,
  createDraftCommandSchema,
  PERSONA_NAME_MAX_LENGTH,
  PERSONA_DESCRIPTION_MAX_LENGTH,
  PERSONA_BEHAVIOR_MAX_LENGTH,
  createPersonaInputSchema,
  createPersonaCommandSchema,
  applyThemeToDraftInputSchema,
  applyThemeToDraftCommandSchema,
  editorCommandSchema,
} from "./actions/editor-commands";
export type {
  PreviewMode,
  ShowPreviewInput,
  ShowPreviewCommand,
  SendTestEmailInput,
  SendTestEmailCommand,
  GenerateImageInput,
  GenerateImageCommand,
  UiPanel,
  OpenPanelInput,
  OpenPanelCommand,
  UndoInput,
  UndoCommand,
  RedoInput,
  RedoCommand,
  GoToVersionInput,
  GoToVersionCommand,
  CreateDraftInput,
  CreateDraftCommand,
  CreatePersonaInput,
  CreatePersonaCommand,
  ApplyThemeToDraftInput,
  ApplyThemeToDraftCommand,
  EditorCommand,
} from "./actions/editor-commands";

// --- Actions: registry & generated surfaces (actions/registry) ---------------------------------
export {
  createActionRegistry,
  getAction,
  toAISDKToolDefinitions,
  dispatchContentAction,
  dispatchEditorAction,
  dispatchAnalysisAction,
} from "./actions/registry";
export type {
  EmailActionRegistry,
  AISDKToolDefinition,
  ActionDispatchError,
  DispatchContentActionInput,
  DispatchContentActionResult,
  DispatchEditorActionInput,
  DispatchEditorActionResult,
  DispatchAnalysisActionInput,
  DispatchAnalysisActionResult,
} from "./actions/registry";

// --- Actions: built-in definitions & static registry (actions/builtins) ------------------------
export {
  updateBlockPropertiesAction,
  replaceBlockPropertiesAction,
  updateDocumentSettingsAction,
  applyThemeAction,
  applyThemeToDraftAction,
  addBlockAction,
  addSectionAction,
  restoreBlocksAction,
  removeBlockAction,
  moveBlockAction,
  reorderChildrenAction,
  updateTextAction,
  contentEmailActions,
  showPreviewAction,
  sendTestEmailAction,
  generateImageAction,
  openPanelAction,
  undoAction,
  redoAction,
  goToVersionAction,
  createDraftAction,
  createPersonaAction,
  editorEmailActions,
  inspectRenderedEmailAction,
  analysisEmailActions,
  emailActionRegistry,
} from "./actions/builtins";

// --- Operations: applyTheme section-override payload (operations/ops) ---------------------------
export { themeSectionOverrideSchema } from "./operations/ops";
export type { ThemeSectionOverride } from "./operations/ops";

// --- Actions: styleTextSpan — intent-level span styling (actions/style-text-span) ---------------
export {
  styleTextSpanInputSchema,
  styleTextSpanStyleSchema,
  styleTextSpanOccurrenceSchema,
  applySpanStyle,
  resolveStyleTextSpanOperation,
  styleTextSpanAction,
} from "./actions/style-text-span";
export type {
  StyleTextSpanInput,
  StyleTextSpanStyle,
  StyleTextSpanOccurrence,
  ApplySpanStyleInput,
  ApplySpanStyleResult,
  ResolveStyleTextSpanOperationInput,
  ResolveStyleTextSpanResult,
} from "./actions/style-text-span";

// --- Actions: intent→operation resolution contract (actions/define) -----------------------------
export type { ResolveContentOperationResult, ResolvedOperationError } from "./actions/define";

// --- Sections: the section catalog (sections/*, Phase 7.2) --------------------------------------
export {
  SECTION_TEMPLATES,
  SECTION_TEMPLATE_IDS,
  getSectionTemplate,
} from "./sections/catalog";
export type { SectionTemplateId } from "./sections/catalog";
export {
  SECTION_CATEGORIES,
  defineSectionTemplate,
  getModelFacingParamsSchema,
  getContentRequirements,
  getPreviewParams,
  getTemplateParamKeys,
} from "./sections/types";
export type {
  SectionCategory,
  SectionTemplate,
  SectionBuildInput,
  SectionBuildResult,
} from "./sections/types";

// --- Sections: content fit — does this content fit this template (sections/content-fit) ---------
export {
  isContentRequirementSatisfied,
  hasContentForTemplate,
  findContentFittingTemplate,
  projectParamsOntoTemplate,
} from "./sections/content-fit";
export type {
  SectionContentRequirements,
  SectionListRequirement,
  ContentFittingTemplate,
} from "./sections/content-fit";
export { buildColumns, computeEqualColumnWidths } from "./sections/build-columns";
export type { BuildColumnsInput, BuildColumnsResult, ColumnSpec } from "./sections/build-columns";

// --- Actions: scaffoldSection — intent-level section scaffolding (actions/scaffold-section) -----
export {
  scaffoldSectionInputSchema,
  scaffoldSectionPositionSchema,
  resolveScaffoldSectionOperation,
  resolveScaffoldSectionIndex,
  scaffoldSectionAction,
  SAVED_SECTION_TEMPLATE_ID_PREFIX,
  isSavedSectionTemplateId,
} from "./actions/scaffold-section";
export type {
  ScaffoldSectionInput,
  ScaffoldSectionPosition,
  ResolveScaffoldSectionOperationInput,
  ResolveScaffoldSectionResult,
} from "./actions/scaffold-section";

// --- Actions: createDraft composition — plan → a whole new email (actions/compose-draft) --------
export {
  MAX_DRAFT_PLAN_SECTIONS,
  DRAFT_NAME_MAX_LENGTH,
  resolveCreateDraftCommand,
  deriveDraftContentClues,
  completeDraftSections,
  diversifyDraftSections,
  resolveSectionsToAvailableContent,
  buildComposedDrafts,
} from "./actions/compose-draft";
export type {
  SectionContentResolution,
  DraftPlan,
  DraftSectionPlan,
  DraftContentClues,
  SectionCopy,
  ComposedDraft,
  ComposedDraftComposition,
  BuildComposedDraftsInput,
} from "./actions/compose-draft";

// --- Actions: theme & draft REFERENCES — naming a theme instead of carrying one -----------------
//
// The model names a theme and a draft; the app resolves both against lists it
// already holds (this canvas's drafts, this kit's LIVE themes, the page read
// this turn). No colour value ever reaches the model, and no document id ever
// leaves the browser. See actions/theme-target.ts for the full argument.
export {
  CURRENT_THEME_REFERENCE,
  PAGE_THEME_REFERENCE,
  CURRENT_DRAFT_TARGET,
  MAX_REFERENCE_LENGTH,
  themeReferenceSchema,
  draftTargetSchema,
  normalizeReferenceKey,
  matchNamedCandidate,
  resolveThemeReference,
  resolveDraftTarget,
} from "./actions/theme-target";
export type {
  NamedCandidateMatch,
  NamedTheme,
  PageTheme,
  ResolvedThemeSource,
  ThemeResolution,
  ResolveThemeReferenceInput,
  NamedDraft,
  DraftTargetResolution,
} from "./actions/theme-target";

// --- Actions: inspectRenderedEmail — read the rendered email back (actions/inspect-rendered-email)
export {
  inspectRenderedEmail,
  inspectRenderedEmailInputSchema,
  RENDERED_TEXT_DEFAULT_CHARACTERS,
  RENDERED_TEXT_MAX_CHARACTERS,
  RENDER_FAILURE_MESSAGE_MAX_CHARACTERS,
  RENDERED_TEXT_TRUNCATION_MARKER,
  GMAIL_CLIPPING_BYTE_LIMIT,
} from "./actions/inspect-rendered-email";
export type {
  InspectRenderedEmailInput,
  InspectRenderedEmailOptions,
  InspectRenderedEmailResult,
  RenderedEmailReport,
  RenderedEmailFailure,
} from "./actions/inspect-rendered-email";

// --- Actions: clearContent — strip the copy, keep the design (actions/clear-content) ------------
export {
  buildClearContentOperations,
  isBrandLogoBlock,
  CLEARED_HEADING_TEXT,
  CLEARED_PARAGRAPH_TEXT,
  CLEARED_BUTTON_LABEL,
  CLEARED_LINK_TEXT,
  CLEARED_CODE,
  CLEARED_IMAGE_SRC,
  CLEARED_IMAGE_ALT,
} from "./actions/clear-content";
