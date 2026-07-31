import {
  dispatchEditorAction,
  getAction,
  toAISDKToolDefinitions,
  type ActionContext,
  type ActionDispatchError,
  type EmailDocument,
} from "@tandem/email-sdk";
import { tool, type ToolApprovalStatus, type ToolSet, type UIMessageStreamWriter } from "ai";
import {
  serializeChatError,
  type AnalysisToolOutput,
  type EditorToolOutput,
  type TandemChatMessage,
} from "@/lib/chat-contract";
import { generateAndStoreImage } from "../generate-image/generation";
import { toModelInputSchema } from "./model-schema";
import { chatActionRegistry } from "./registry";
import { sendTestEmailWithResend } from "./send-test-email";

/**
 * Registry → AI SDK toolset (Phase 3.2/3.3, agent registry since Phase 3
 * integration).
 *
 * Every action in `chatActionRegistry` (email-sdk built-ins + agent analysis
 * actions) is advertised to the model as a tool (name, description, compact
 * agentInputSchema straight from `toAISDKToolDefinitions`). The kinds diverge
 * on execution:
 *
 * - CONTENT actions get NO execute(). The validated tool call streams to the
 *   client as a `tool-<name>` part; the CLIENT applies it optimistically
 *   (validateAndClassifyOp gate) and Phase 4 makes Convex authoritative.
 *   Server-side, streamText already validates the input against the tool's
 *   inputSchema before `tool-input-available` is emitted (gate layer 1).
 *
 * - EDITOR actions execute server-side: `dispatchEditorAction` re-validates
 *   against the FULL schema and produces the typed EditorCommand, which is
 *   written onto the stream as a `data-editor-command` part for the Phase 3.4
 *   frontend dispatcher. The tool output ({status:"dispatched"}) closes the
 *   tool-call loop so the model can confirm the result.
 *
 * - ANALYSIS actions (getBlockDetails, §9.4 catalog-lookup) execute
 *   server-side against THIS REQUEST'S document and return their JSON result
 *   straight to the model in-loop. Read-only: nothing is applied client-side
 *   and no data part is written.
 */

/** Thrown for terminal dispatch failures — see pipeline onError handling. */
export class TerminalChatError extends Error {
  readonly errors: ActionDispatchError[];

  constructor(errors: ActionDispatchError[]) {
    super(errors.map((error) => error.message).join("; "));
    this.name = "TerminalChatError";
    this.errors = errors;
  }
}

export interface BuildChatToolsInput {
  writer: UIMessageStreamWriter<TandemChatMessage>;
  actionContext: ActionContext;
  /** This request's document — what analysis actions read (never mutated). */
  doc: EmailDocument;
  /**
   * The calling browser's anonymous session id (session cookie), or null.
   * generateImage registers what it uploads under this session's library
   * (Content Studio Stage S — every generation registers unconditionally).
   */
  sessionId: string | null;
}

export interface BuiltChatTools {
  /** The toolset streamText advertises and executes. */
  tools: ToolSet;
  /**
   * The same tools WITHOUT execute() — passed to the repair re-ask call so a
   * repair round can never re-trigger editor side effects.
   */
  schemaOnlyTools: ToolSet;
  /**
   * streamText-level approval config (tool-level needsApproval is deprecated
   * in AI SDK v7). Registry predicates are adapted by closing over the
   * request's ActionContext.
   */
  toolApproval: Record<string, ToolApprovalStatus | ((input: unknown) => ToolApprovalStatus)>;
}

/** Build the per-request toolset. The writer is this request's stream writer. */
export function buildChatTools({
  writer,
  actionContext,
  doc,
  sessionId,
}: BuildChatToolsInput): BuiltChatTools {
  const tools: ToolSet = {};
  const schemaOnlyTools: ToolSet = {};
  const toolApproval: BuiltChatTools["toolApproval"] = {};

  for (const definition of toAISDKToolDefinitions(chatActionRegistry)) {
    const action = getAction(chatActionRegistry, definition.name);
    if (action === undefined) continue; // unreachable: definitions come from the registry

    // Gemini-compatible JSON Schema declaration; validation still runs the
    // registry's Zod schema (see model-schema.ts).
    const modelInputSchema = toModelInputSchema(definition.inputSchema);

    const schemaOnlyTool = tool({
      description: definition.description,
      inputSchema: modelInputSchema,
    });
    schemaOnlyTools[definition.name] = schemaOnlyTool;

    if (action.kind === "editor") {
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
              // Terminal (e.g. wrong_action_kind — a wiring bug): stop the
              // turn with a structured error part, then fail the tool call.
              writer.write({
                type: "error",
                errorText: serializeChatError({
                  kind: "tandem-chat-error",
                  failureKind: "terminal",
                  errors: result.errors.map(({ code, message }) => ({ code, message })),
                }),
              });
              throw new TerminalChatError(result.errors);
            }
            // Retryable: surface as a tool execution error — the model sees it
            // on the next step (stopWhen allows one) and can correct itself.
            throw new Error(result.errors.map((error) => error.message).join("; "));
          }
          // Phase 8.1: an approved sendTestEmail performs the REAL send here,
          // server-side, against THIS request's document. The module's
          // payload-hash idempotency key makes approval-loop double-fires
          // no-ops. Failures throw with the module's clean human copy (raw
          // provider errors stay in the server log) — surfaced through the
          // chip's existing friendly-error + Details pattern, and the model
          // sees the same sentence to relay. No data part is written on
          // failure, so no stale "queued" chip renders.
          let send: EditorToolOutput["send"];
          let command = result.command;
          if (command.type === "sendTestEmail") {
            const outcome = await sendTestEmailWithResend({ doc, to: command.to });
            if (!outcome.isSent) {
              throw new Error(`The test email to ${command.to} wasn't sent: ${outcome.message}`);
            }
            send = { messageId: outcome.messageId };
          }
          // generateImage is fulfilled HERE (the effectful executor): validate
          // the target against THIS request's document, generate + upload the
          // binary to Convex storage server-side (no ephemeral phase on the
          // agent path), and stream the FULFILLED command (durable https src +
          // prompt-derived alt). The client dispatcher commits it as ONE
          // updateBlockProperties op through the normal validated spine —
          // base64 never reaches the stream, the op log, or Convex.
          if (command.type === "generateImage") {
            const targetBlock = doc[command.blockId];
            if (targetBlock === undefined || targetBlock.type !== "image") {
              // Retryable: the model sees this on the next step and can
              // re-target an existing image block (or add one first).
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
          // The Phase 3.4 editor-operations channel: one typed data part per
          // dispatched command. id = toolCallId so re-writes reconcile.
          writer.write({
            type: "data-editor-command",
            id: toolCallId,
            data: { toolCallId, command },
          });
          return {
            status: "dispatched",
            command,
            ...(send === undefined ? {} : { send }),
          };
        },
      });
    } else if (action.kind === "analysis") {
      // Analysis actions run server-side against the request's document and
      // hand their JSON straight back to the model (read-only, in-loop; no
      // client application, no data part).
      tools[definition.name] = tool({
        description: definition.description,
        inputSchema: modelInputSchema,
        execute: async (input): Promise<AnalysisToolOutput> => {
          const parsedInput = action.schema.safeParse(input);
          if (!parsedInput.success) {
            // Retryable, mirroring the dispatchers: the model sees the error
            // as the tool result on the next step and can correct itself.
            throw new Error(
              `Input for action "${definition.name}" failed validation: ${parsedInput.error.message}`,
            );
          }
          // Analysis runs may be async (fetchWebContent does network I/O);
          // awaiting a sync result (getBlockDetails) is a no-op.
          const data = await action.run(doc, parsedInput.data);
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
      // Content actions: no execute — the tool call streams to the client,
      // which validates and applies it.
      tools[definition.name] = schemaOnlyTool;
    }

    // Approval mapping: registry `needsApproval` → streamText `toolApproval`.
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
