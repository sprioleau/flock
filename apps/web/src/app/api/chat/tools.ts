import {
  materializeSectionVariations,
  proposeEditsInputSchema,
  proposeSectionVariationsInputSchema,
  readWebPageInputSchema,
  validateEditSuggestions,
} from "@flock/agent";
import {
  dispatchAnalysisAction,
  dispatchEditorAction,
  getAction,
  toAISDKToolDefinitions,
  type ActionContext,
  type ActionDispatchError,
  type EmailDocument,
} from "@flock/email-sdk";
import { tool, type Tool, type ToolApprovalStatus, type ToolSet, type UIMessageStreamWriter } from "ai";
import {
  CHAT_TABLE_MAX_ROWS,
  serializeChatError,
  type AnalysisToolOutput,
  type EditorToolOutput,
  type ReadWebPageToolOutput,
  type ListAssetsToolOutput,
  type ProposeEditsToolOutput,
  type ProposeSectionVariationsToolOutput,
  type FlockChatMessage,
} from "@/lib/chat-contract";
import { createPageClassifier } from "@/lib/content-ingestion/classify-page-model";
import { ingestPage } from "@/lib/content-ingestion/ingest-page";
import { generateAndStoreImage } from "../generate-image/generation";
import { createPersonaForSession } from "./create-persona";
import { ASSET_KIND_LABELS, listSessionAssets } from "./list-assets";
import { toModelInputSchema } from "./model-schema";
import { chatActionRegistry } from "./registry";
import { sendTestEmailWithResend } from "./send-test-email";

/*
  Registry → AI SDK toolset (Phase 3.2/3.3, agent registry since Phase 3
  integration).

  Every action in `chatActionRegistry` (email-sdk built-ins + agent analysis
  actions) is advertised to the model as a tool (name, description, compact
  agentInputSchema straight from `toAISDKToolDefinitions`). The kinds diverge
  on execution:

  - CONTENT actions get NO execute(). The validated tool call streams to the
    client as a `tool-<name>` part; the CLIENT applies it optimistically
    (validateAndClassifyOp gate) and Phase 4 makes Convex authoritative.
    Server-side, streamText already validates the input against the tool's
    inputSchema before `tool-input-available` is emitted (gate layer 1).

  - EDITOR actions with `resultSource: "server"` execute server-side:
    `dispatchEditorAction` re-validates against the FULL schema and produces
    the typed EditorCommand, which is written onto the stream as a
    `data-editor-command` part for the Phase 3.4 frontend dispatcher. The tool
    output ({status:"dispatched"}) closes the tool-call loop so the model can
    confirm the result.

  - EDITOR actions with `resultSource: "client"` (undo, redo, createDraft) get
    NO execute() here at all — see the branch below. The server cannot know
    whether a history step existed to take, or which drafts landed under which
    names, so it must not answer for either.

  - ANALYSIS actions (getBlockDetails, §9.4 catalog-lookup) execute
    server-side against THIS REQUEST'S document and return their JSON result
    straight to the model in-loop. Read-only: nothing is applied client-side
    and no data part is written.
*/

/*
  Thrown for terminal dispatch failures — see pipeline onError handling.
*/
export class TerminalChatError extends Error {
  readonly errors: ActionDispatchError[];

  constructor(errors: ActionDispatchError[]) {
    super(errors.map((error) => error.message).join("; "));
    this.name = "TerminalChatError";
    this.errors = errors;
  }
}

export interface BuildChatToolsInput {
  writer: UIMessageStreamWriter<FlockChatMessage>;
  actionContext: ActionContext;
  /*
    This request's document — what analysis actions read (never mutated).
  */
  doc: EmailDocument;
  /*
    The calling browser's anonymous session id (session cookie), or null.
    generateImage registers what it uploads under this session's library
    (Content Studio Stage S — every generation registers unconditionally).
  */
  sessionId: string | null;
  /*
    True when this turn runs on the deterministic mock model. The person
    pipeline reads it to skip the live public-web search entirely — a mock
    run must cost no quota AND must never fabricate research results.
  */
  isUsingMockModel: boolean;
}

export interface BuiltChatTools {
  /*
    The toolset streamText advertises and executes.
  */
  tools: ToolSet;
  /*
    The same tools WITHOUT execute() — passed to the repair re-ask call so a
    repair round can never re-trigger editor side effects.
  */
  schemaOnlyTools: ToolSet;
  /*
    streamText-level approval config (tool-level needsApproval is deprecated
    in AI SDK v7). Registry predicates are adapted by closing over the
    request's ActionContext.
  */
  toolApproval: Record<string, ToolApprovalStatus | ((input: unknown) => ToolApprovalStatus)>;
}

/*
  ---------------------------------------------------------------------------
  Generative-UI widget tools (host-side fulfillment — see widget-actions.ts)
  ---------------------------------------------------------------------------
*/

/*
  Format an asset timestamp for the chat table ("Jul 30"). Server-side and
  deterministic per run — the table is a snapshot, not a live clock.
*/
function formatAssetDate(createdAtMs: number): string {
  return new Date(createdAtMs).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface BuildWidgetToolInput {
  name: string;
  description: string;
  modelInputSchema: ReturnType<typeof toModelInputSchema>;
  writer: UIMessageStreamWriter<FlockChatMessage>;
  doc: EmailDocument;
  sessionId: string | null;
}

/*
  The widget tools' host-side executions, or null when `name` is not a
  host-fulfilled widget tool. Each execute runs the agent package's pure
  computation, writes ONE `data-*` part with `id = toolCallId` (same-id
  rewrites reconcile; the transcript's latest-part dedupe supersedes the tool
  chip with the widget), and returns a COMPACT model-facing summary — the
  full widget payload never rides the model loop. Failures throw, which the
  SDK surfaces as a retryable tool error the model sees on the next step.

  askForClarification is NOT here on purpose: it registers schema-only (no
  execute) so the turn ends on the call and the user's answer arrives as
  their next message through the composer-handoff send seam.
*/
function buildWidgetTool({
  name,
  description,
  modelInputSchema,
  writer,
  doc,
  sessionId,
}: BuildWidgetToolInput): Tool | null {
  if (name === "proposeSectionVariations") {
    return tool({
      description,
      inputSchema: modelInputSchema,
      execute: async (input, { toolCallId }): Promise<ProposeSectionVariationsToolOutput> => {
        const parsedInput = proposeSectionVariationsInputSchema.safeParse(input);
        if (!parsedInput.success) {
          throw new Error(
            `Input for action "proposeSectionVariations" failed validation: ${parsedInput.error.message}`,
          );
        }
        const result = materializeSectionVariations(parsedInput.data);
        if (result.variations.length === 0) {
          throw new Error(
            "No variation could be built — use templateIds from the section catalog listed in your instructions.",
          );
        }
        writer.write({
          type: "data-section-variations",
          id: toolCallId,
          data: {
            toolCallId,
            ...(parsedInput.data.intent === undefined ? {} : { intent: parsedInput.data.intent }),
            variations: result.variations.map((variation, index) => ({
              id: `v${index + 1}`,
              title: variation.title,
              templateId: variation.templateId,
              blocks: variation.blocks,
            })),
          },
        });
        return {
          status: "presented",
          note: "The variations are on screen as a picker with previews. The user will choose one — do not scaffold or insert any of them yourself.",
          variationCount: result.variations.length,
        };
      },
    });
  }
  if (name === "proposeEdits") {
    return tool({
      description,
      inputSchema: modelInputSchema,
      execute: async (input, { toolCallId }): Promise<ProposeEditsToolOutput> => {
        const parsedInput = proposeEditsInputSchema.safeParse(input);
        if (!parsedInput.success) {
          throw new Error(
            `Input for action "proposeEdits" failed validation: ${parsedInput.error.message}`,
          );
        }
        const result = validateEditSuggestions({ doc, input: parsedInput.data });
        if (result.suggestions.length === 0) {
          throw new Error(
            "None of the suggested edits matched the current document — check block ids and property names against the document context, then call proposeEdits again.",
          );
        }
        writer.write({
          type: "data-edit-suggestions",
          id: toolCallId,
          data: {
            toolCallId,
            suggestions: result.suggestions,
            droppedCount: result.droppedCount,
          },
        });
        return {
          status: "presented",
          note: "The suggestions are on screen as cards with Apply buttons. The user applies or dismisses each one — do not apply the edits yourself.",
          suggestionCount: result.suggestions.length,
          droppedCount: result.droppedCount,
        };
      },
    });
  }
  if (name === "listAssets") {
    return tool({
      description,
      inputSchema: modelInputSchema,
      execute: async (_input, { toolCallId }): Promise<ListAssetsToolOutput> => {
        const outcome = await listSessionAssets({ sessionId });
        if (!outcome.isOk) {
          throw new Error(outcome.message);
        }
        const { assets, totalCount } = outcome.result;
        /*
          An empty library needs no table — the model just says so in prose.
        */
        if (assets.length > 0) {
          const rows = assets
            .slice(0, CHAT_TABLE_MAX_ROWS)
            .map((asset) => [asset.name, ASSET_KIND_LABELS[asset.kind], formatAssetDate(asset.createdAtMs)]);
          const moreRowCount = Math.max(0, totalCount - rows.length);
          writer.write({
            type: "data-table",
            id: toolCallId,
            data: {
              toolCallId,
              title: "Images in your library",
              headers: ["Name", "Type", "Added"],
              rows,
              ...(moreRowCount === 0 ? {} : { moreRowCount }),
            },
          });
        }
        return { isFound: true, data: outcome.result };
      },
    });
  }
  return null;
}

/*
  ---------------------------------------------------------------------------
  Web-content ingestion tools (Phase 7.4 — host-side fulfillment)
  ---------------------------------------------------------------------------
*/

interface BuildIngestionToolInput {
  name: string;
  description: string;
  modelInputSchema: ReturnType<typeof toModelInputSchema>;
  sessionId: string | null;
  isUsingMockModel: boolean;
}

/*
  The ingestion tool, or null when `name` isn't it.

  It is a registry "analysis" action, but it is fulfilled HERE rather than
  through the generic in-loop `action.run` for one reason: the pipeline needs
  the CALLER'S SESSION so a rehosted image joins that session's Asset
  Library. The registry is a module-level singleton (the
  prompt-cache contract), so its injected executors cannot close over a
  request. Same host-fulfillment pattern as generateImage and createPersona.

  A REFUSAL IS NOT AN ERROR. "This page is paywalled / blocked by robots.txt /
  has nothing readable on it" comes back as a successful tool output carrying
  `isOk: false` and a user-facing `message`, because that is information the
  model must relay before stopping. Throwing would put it on the error path,
  where the model is invited to retry — exactly the wrong instinct for a page
  that cannot be read.
*/
function buildIngestionTool({
  name,
  description,
  modelInputSchema,
  sessionId,
  isUsingMockModel,
}: BuildIngestionToolInput): Tool | null {
  if (name !== "readWebPage") {
    return null;
  }
  return tool({
    description,
    inputSchema: modelInputSchema,
    execute: async (input): Promise<ReadWebPageToolOutput> => {
      const parsedInput = readWebPageInputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new Error(
          `Input for action "readWebPage" failed validation: ${parsedInput.error.message}`,
        );
      }
      /*
        Images are rehosted on every tier, mock included — the old pipeline's
        isMockRun flag gated a live public-web SEARCH, not the image copy, and
        conflating the two would silently drop stored images from every /demo
        run.

        The READING is what a mock run skips. createPageClassifier returns null
        there, and the classifier falls to its deterministic floor: no quota
        spent, and nothing invented about a page nobody read.

        The page's THEME is not gated either, for the opposite reason to the
        images: it costs no quota on ANY tier. Deriving it reads colours and
        font families the page declared and assigns their roles from the names
        the page gave them — no model is involved, so there is nothing for a
        mock run to skip and nothing for a free-tier bucket to pay for. See
        lib/brand-kit-extraction/derive-page-theme.ts for why that is a choice
        rather than an omission.
      */
      const result = await ingestPage({
        url: parsedInput.data.url,
        sessionId,
        classify: createPageClassifier({ isMockRun: isUsingMockModel }),
      });
      return { isFound: true, data: result };
    },
  });
}

/*
  Build the per-request toolset. The writer is this request's stream writer.
*/
export function buildChatTools({
  writer,
  actionContext,
  doc,
  sessionId,
  isUsingMockModel,
}: BuildChatToolsInput): BuiltChatTools {
  const tools: ToolSet = {};
  const schemaOnlyTools: ToolSet = {};
  const toolApproval: BuiltChatTools["toolApproval"] = {};

  for (const definition of toAISDKToolDefinitions(chatActionRegistry)) {
    const action = getAction(chatActionRegistry, definition.name);
    if (action === undefined) continue; /* unreachable: definitions come from the registry */

    /*
      Gemini-compatible JSON Schema declaration; validation still runs the
      registry's Zod schema (see model-schema.ts).
    */
    const modelInputSchema = toModelInputSchema(definition.inputSchema);

    const schemaOnlyTool = tool({
      description: definition.description,
      inputSchema: modelInputSchema,
    });
    schemaOnlyTools[definition.name] = schemaOnlyTool;

    /*
      Widget tools (generative UI) come FIRST: they are registry "analysis"
      actions, but their fulfillment is host-side (data-part writes, the
      session-scoped asset query) rather than the generic in-loop run.
      askForClarification deliberately registers schema-only — the turn must
      END on the call so the widget can wait for the user's answer.
    */
    const widgetTool = buildWidgetTool({
      name: definition.name,
      description: definition.description,
      modelInputSchema,
      writer,
      doc,
      sessionId,
    });
    /*
      Ingestion tools are likewise host-fulfilled — they need the request's
      session to file a rehosted image under the right library.
    */
    const ingestionTool = buildIngestionTool({
      name: definition.name,
      description: definition.description,
      modelInputSchema,
      sessionId,
      isUsingMockModel,
    });
    if (definition.name === "askForClarification") {
      tools[definition.name] = schemaOnlyTool;
    } else if (widgetTool !== null) {
      tools[definition.name] = widgetTool;
    } else if (ingestionTool !== null) {
      tools[definition.name] = ingestionTool;
    } else if (action.kind === "editor" && action.resultSource === "client") {
      /*
        CLIENT-RESULT editor actions (undo, redo, createDraft): schema-only,
        exactly like a content op. The call streams to the browser, which does
        the real work — the history mutation, or building the drafts — and
        writes the tool result with `addToolOutput`.

        The server is deliberately silent here — no execute, and therefore no
        `data-editor-command` part either. This is the whole fix: an editor
        `run` returns a command DESCRIBING what should happen, and streaming
        that back as the tool result told the model an undo had succeeded
        before the browser had attempted anything. The agent then said "I've
        undone that change for you" over an unchanged draft, and — from a note
        composed server-side out of the PLAN — described the section catalog's
        sample email as "built directly from your website". A result the
        server cannot verify is not a result it may send.
      */
      tools[definition.name] = schemaOnlyTool;
    } else if (action.kind === "editor") {
      tools[definition.name] = tool({
        description: definition.description,
        inputSchema: modelInputSchema,
        execute: async (input, { toolCallId }): Promise<EditorToolOutput> => {
          const result = dispatchEditorAction({
            registry: chatActionRegistry,
            name: definition.name,
            input,
            context: actionContext,
          });
          if (!result.isOk) {
            if (result.failureKind === "terminal") {
              /*
                Terminal (e.g. wrong_action_kind — a wiring bug): stop the
                turn with a structured error part, then fail the tool call.
              */
              writer.write({
                type: "error",
                errorText: serializeChatError({
                  kind: "flock-chat-error",
                  failureKind: "terminal",
                  errors: result.errors.map(({ code, message }) => ({ code, message })),
                }),
              });
              throw new TerminalChatError(result.errors);
            }
            /*
              Retryable: surface as a tool execution error — the model sees it
              on the next step (stopWhen allows one) and can correct itself.
            */
            throw new Error(result.errors.map((error) => error.message).join("; "));
          }
          /*
            Phase 8.1: an approved sendTestEmail performs the REAL send here,
            server-side, against THIS request's document. The module's
            payload-hash idempotency key makes approval-loop double-fires
            no-ops. Failures throw with the module's clean human copy (raw
            provider errors stay in the server log) — surfaced through the
            chip's existing friendly-error + Details pattern, and the model
            sees the same sentence to relay. No data part is written on
            failure, so no stale "queued" chip renders.
          */
          let send: EditorToolOutput["send"];
          let command = result.command;
          if (command.type === "sendTestEmail") {
            /*
              The agent path is single-recipient: wrap the one address in the
              array the module now takes, and let subject/preview fall back to
              derivation (the studio dialog is the only caller that sets them).
            */
            const outcome = await sendTestEmailWithResend({ doc, to: [command.to] });
            if (!outcome.isSent) {
              throw new Error(`The test email to ${command.to} wasn't sent: ${outcome.message}`);
            }
            send = { messageId: outcome.messageId };
          }
          /*
            generateImage is fulfilled HERE (the effectful executor): validate
            the target against THIS request's document, generate + upload the
            binary to Convex storage server-side (no ephemeral phase on the
            agent path), and stream the FULFILLED command (durable https src +
            prompt-derived alt). The client dispatcher commits it as ONE
            updateBlockProperties op through the normal validated spine —
            base64 never reaches the stream, the op log, or Convex.
          */
          if (command.type === "generateImage") {
            const targetBlock = doc[command.blockId];
            if (targetBlock === undefined || targetBlock.type !== "image") {
              /*
                Retryable: the model sees this on the next step and can
                re-target an existing image block (or add one first).
              */
              throw new Error(
                `Block "${command.blockId}" is not an image block in the current document — call generateImage with the id of an existing image block.`,
              );
            }
            const outcome = await generateAndStoreImage({ prompt: command.prompt, sessionId });
            if (!outcome.isOk) {
              throw new Error(
                `The image for ${command.blockId} wasn't generated: ${outcome.message}`,
              );
            }
            command = { ...command, src: outcome.src, alt: outcome.alt };
          }
          /*
            createPersona is fulfilled HERE too (agent-parity actions): the
            session-owned Convex mutation runs server-side — its markdown
            validation, per-session quota, and advisory-only capability are
            the trust boundary — and the FULFILLED command (slug present)
            streams to the client, which enables the persona locally exactly
            like the picker's own create form.
          */
          if (command.type === "createPersona") {
            const outcome = await createPersonaForSession({ command, sessionId });
            if (!outcome.isOk) {
              /*
                Retryable: the model sees the clean sentence on the next step
                (e.g. the per-session quota message) and relays it.
              */
              throw new Error(`The persona "${command.name}" wasn't created: ${outcome.message}`);
            }
            command = outcome.command;
          }
          /*
            The Phase 3.4 editor-operations channel: one typed data part per
            dispatched command. id = toolCallId so re-writes reconcile.
          */
          writer.write({
            type: "data-editor-command",
            id: toolCallId,
            data: { toolCallId, command },
          });
          /*
            createDraft used to be special-cased here, returning a note composed
            from the PLAN ("Created 2 new drafts (…), each a complete email").
            It is client-result now and never reaches this branch: the note it
            wrote was a claim about drafts the server never saw land, which is
            the whole reason the action moved. The honest note is composed in
            the browser — see lib/create-draft-report.ts.
          */
          return {
            status: "dispatched",
            command,
            ...(send === undefined ? {} : { send }),
          };
        },
      });
    } else if (action.kind === "analysis") {
      /*
        Analysis actions run server-side against the request's document and
        hand their JSON straight back to the model (read-only, in-loop; no
        client application, no data part).
      */
      tools[definition.name] = tool({
        description: definition.description,
        inputSchema: modelInputSchema,
        execute: async (input): Promise<AnalysisToolOutput> => {
          /*
            Through the registry's dispatcher, exactly like the editor branch
            above — NOT `action.run` directly. Calling `run` here open-coded a
            third dispatch path that answered to nothing the registry
            enforces; `dispatchAnalysisAction` re-validates against the FULL
            schema and puts this call behind the same authorization gate every
            other kind passes through.
          */
          const result = dispatchAnalysisAction({
            registry: chatActionRegistry,
            doc,
            name: definition.name,
            input,
            context: actionContext,
          });
          if (!result.isOk) {
            if (result.failureKind === "terminal") {
              /*
                Terminal (an authorization refusal, or a wiring bug): stop the
                turn with a structured error part, then fail the tool call.
                Deliberately NOT surfaced as a retryable tool error — a
                refusal the model can re-ask its way around is not a refusal.
              */
              writer.write({
                type: "error",
                errorText: serializeChatError({
                  kind: "flock-chat-error",
                  failureKind: "terminal",
                  errors: result.errors.map(({ code, message }) => ({ code, message })),
                }),
              });
              throw new TerminalChatError(result.errors);
            }
            /*
              Retryable (a validation failure): the model sees the error as
              the tool result on the next step and can correct itself.
            */
            throw new Error(result.errors.map((error) => error.message).join("; "));
          }
          /*
            Analysis runs may be async (readWebPage does network I/O), and
            the dispatcher hands the value back unawaited; awaiting a sync
            result (getBlockDetails) is a no-op.
          */
          const data = await result.data;
          if (data === null || data === undefined) {
            return {
              isFound: false,
              message: `No result — the requested id does not exist in the current document. Use ids exactly as they appear in the document context.`,
            };
          }
          return { isFound: true, data };
        },
      });
    } else {
      /*
        Content actions: no execute — the tool call streams to the client,
        which validates and applies it.
      */
      tools[definition.name] = schemaOnlyTool;
    }

    /*
      Approval mapping: registry `needsApproval` → streamText `toolApproval`.
    */
    if (definition.needsApproval === true) {
      toolApproval[definition.name] = "user-approval";
    } else if (typeof definition.needsApproval === "function") {
      const needsApprovalPredicate = definition.needsApproval;
      toolApproval[definition.name] = (input: unknown) =>
        needsApprovalPredicate(input, actionContext) ? "user-approval" : undefined;
    }
  }

  return { tools, schemaOnlyTools, toolApproval };
}
