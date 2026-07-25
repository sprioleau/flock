import { z } from "zod";
import type { UIMessage } from "ai";

/**
 * Spike C — shared operation schema module.
 *
 * This mirrors the future `email-sdk` operation envelope (Phase 1.3 / §9.3):
 * a Zod discriminated union on `name`, with `.describe()` on every field so
 * the schema doubles as the LLM's documentation. For the spike there is a
 * single op, `echoOperation`.
 *
 * The SAME schema object is used in three places, which is the point of the
 * spike:
 *   1. Server: `inputSchema` of the AI SDK tool (drives the model's JSON).
 *   2. Server: runtime validation inside streamText before the tool call is
 *      accepted (the SDK validates tool inputs against `inputSchema`).
 *   3. Client: re-validation of the received op before "applying" it — the
 *      Phase 3.3 validation-gate pattern.
 */

export const echoOperationSchema = z.object({
  kind: z
    .literal("content")
    .describe(
      'Operation category. "content" ops mutate the email document; "editor" ops (future) drive the editor UI.',
    ),
  name: z
    .literal("echoOperation")
    .describe("The operation name. Discriminator for the operation union."),
  blockId: z
    .string()
    .min(1)
    .describe(
      'Short human-readable ID of the target block, e.g. "txt_a1" or "btn_x9".',
    ),
  message: z
    .string()
    .min(1)
    .describe("The message to echo back into the target block."),
});

export type EchoOperation = z.infer<typeof echoOperationSchema>;

/**
 * The operation envelope: a discriminated union on `name`. Today it has one
 * member; Phase 1.3 grows this to updateBlockProperties, addBlock, etc.
 */
export const operationSchema = z.discriminatedUnion("name", [
  echoOperationSchema,
]);

export type Operation = z.infer<typeof operationSchema>;

/**
 * Editor-operations channel (Phase 3.4 preview): UI commands that are NOT
 * document mutations. They are transported as custom data parts
 * (`data-editor-operation`) on the same UI message stream, and dispatched by
 * the client.
 */
export const editorOperationSchema = z.object({
  kind: z.literal("editor").describe("Editor ops drive the editor UI."),
  name: z
    .literal("showPreview")
    .describe("The editor command name. Discriminator for the editor union."),
  mode: z
    .enum(["desktop", "mobile"])
    .describe("Which preview viewport to show."),
});

export type EditorOperation = z.infer<typeof editorOperationSchema>;

/**
 * Typed UI message for this spike's chat. Generic params:
 *   METADATA = never, DATA_PARTS = custom data-part payloads keyed by name
 *   (rendered as `data-editor-operation` parts), TOOLS = tool input/output
 *   shapes (rendered as `tool-echoOperation` parts).
 */
export type SpikeChatMessage = UIMessage<
  never,
  {
    "editor-operation": EditorOperation;
  },
  {
    echoOperation: {
      input: EchoOperation;
      // No execute() on the tool — the op is applied client-side, so there is
      // never a tool output round-trip in this transport.
      output: never;
    };
  }
>;
