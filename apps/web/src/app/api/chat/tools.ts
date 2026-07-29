import {
  dispatchEditorAction,
  emailActionRegistry,
  getAction,
  toAISDKToolDefinitions,
  type ActionContext,
  type ActionDispatchError,
} from "@tandem/email-sdk";
import { tool, type ToolApprovalStatus, type ToolSet, type UIMessageStreamWriter } from "ai";
import {
  serializeChatError,
  type EditorToolOutput,
  type TandemChatMessage,
} from "@/lib/chat-contract";
import { toModelInputSchema } from "./model-schema";

/**
 * Registry → AI SDK toolset (Phase 3.2/3.3).
 *
 * Every action in `emailActionRegistry` is advertised to the model as a tool
 * (name, description, compact agentInputSchema straight from
 * `toAISDKToolDefinitions`). The two kinds diverge on execution:
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
export function buildChatTools({ writer, actionContext }: BuildChatToolsInput): BuiltChatTools {
  const tools: ToolSet = {};
  const schemaOnlyTools: ToolSet = {};
  const toolApproval: BuiltChatTools["toolApproval"] = {};

  for (const definition of toAISDKToolDefinitions(emailActionRegistry)) {
    const action = getAction(emailActionRegistry, definition.name);
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
            registry: emailActionRegistry,
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
          // The Phase 3.4 editor-operations channel: one typed data part per
          // dispatched command. id = toolCallId so re-writes reconcile.
          writer.write({
            type: "data-editor-command",
            id: toolCallId,
            data: { toolCallId, command: result.command },
          });
          return { status: "dispatched", command: result.command };
        },
      });
    } else {
      // Content (and future analysis) actions: no execute — client-applied.
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
