"use client";

import { useRef, useState } from "react";
import { DefaultChatTransport, readUIMessageStream } from "ai";
import {
  echoOperationSchema,
  editorOperationSchema,
  type SpikeChatMessage,
} from "./schema";

/**
 * Spike C — client for the ops-streaming transport.
 *
 * NOTE: `@ai-sdk/react` (useChat) is not installed in this workspace, so this
 * page uses the same primitives useChat wraps: `DefaultChatTransport` (POST +
 * SSE parsing → UIMessageChunk stream) and `readUIMessageStream` (chunks →
 * incrementally-updated UIMessage snapshots). Swapping to useChat later is a
 * drop-in: `useChat({ transport: new DefaultChatTransport({ api: ... }) })`.
 *
 * The page renders three things to prove the transport:
 *   1. Streamed text parts, incrementally.
 *   2. The `tool-echoOperation` part through its states
 *      (input-streaming → input-available), including partial JSON input.
 *   3. Client-side Zod RE-validation of the received op (Phase 3.3 validation
 *      gate) — a valid op is "applied" to a mini canvas block; the
 *      `data-editor-operation` part flips the canvas viewport (Phase 3.4).
 */

const transport = new DefaultChatTransport<SpikeChatMessage>({
  api: "/api/spike/echo",
});

type CanvasState = {
  blockId: string;
  content: string;
  viewport: "desktop" | "mobile";
};

export default function SpikeAiPage() {
  const [messages, setMessages] = useState<SpikeChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("Hello, streamed ops!");
  const [isStreaming, setIsStreaming] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [canvas, setCanvas] = useState<CanvasState>({
    blockId: "txt_a1",
    content: "(empty block)",
    viewport: "desktop",
  });
  const appliedToolCallIdsRef = useRef<Set<string>>(new Set());

  async function handleSend() {
    if (isStreaming || inputValue.trim() === "") return;
    setErrorText(null);

    const userMessage: SpikeChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: inputValue }],
    };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setIsStreaming(true);

    try {
      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "spike-chat",
        messageId: undefined,
        messages: nextMessages,
        abortSignal: undefined,
      });

      // NOTE: data parts written before the model's `start` chunk cause
      // `readUIMessageStream` to yield snapshots under a temporary id first,
      // then under the server-generated messageId. Track the previous
      // snapshot's id so we replace (not duplicate) across the id change —
      // useChat does this internally.
      let previousSnapshotId: string | null = null;
      for await (const assistantMessage of readUIMessageStream<SpikeChatMessage>(
        { stream },
      )) {
        const replaceableId = previousSnapshotId ?? assistantMessage.id;
        previousSnapshotId = assistantMessage.id;
        setMessages((current) => {
          const hasMessage = current.some(
            (message) => message.id === replaceableId,
          );
          return hasMessage
            ? current.map((message) =>
                message.id === replaceableId ? assistantMessage : message,
              )
            : [...current, assistantMessage];
        });
        applyIncomingParts(assistantMessage);
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setIsStreaming(false);
    }
  }

  /** Phase 3.3 validate→apply loop, client side. */
  function applyIncomingParts(message: SpikeChatMessage) {
    for (const part of message.parts) {
      if (
        part.type === "tool-echoOperation" &&
        part.state === "input-available" &&
        !appliedToolCallIdsRef.current.has(part.toolCallId)
      ) {
        const parsed = echoOperationSchema.safeParse(part.input);
        if (parsed.success) {
          appliedToolCallIdsRef.current.add(part.toolCallId);
          setCanvas((current) => ({
            ...current,
            blockId: parsed.data.blockId,
            content: parsed.data.message,
          }));
        }
      }
      if (part.type === "data-editor-operation") {
        const parsed = editorOperationSchema.safeParse(part.data);
        if (parsed.success && parsed.data.name === "showPreview") {
          setCanvas((current) =>
            current.viewport === parsed.data.mode
              ? current
              : { ...current, viewport: parsed.data.mode },
          );
        }
      }
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Spike C — AI SDK ops streaming
        </h1>
        <p className="text-sm text-neutral-500">
          Natural language → streamed tool calls → Zod validation gate →
          incremental apply. Mock model streams when ANTHROPIC_API_KEY is
          absent.
        </p>
      </header>

      {/* Mini canvas: where validated ops land */}
      <section
        className={`rounded-lg border border-neutral-300 p-4 transition-all ${
          canvas.viewport === "mobile" ? "max-w-xs" : "max-w-full"
        }`}
        data-testid="canvas"
      >
        <p className="mb-1 text-xs font-medium uppercase text-neutral-400">
          Canvas · viewport: {canvas.viewport} · block: {canvas.blockId}
        </p>
        <p className="text-lg" data-testid="canvas-block">
          {canvas.content}
        </p>
      </section>

      {/* Conversation */}
      <section className="flex flex-col gap-4" data-testid="messages">
        {messages.map((message) => (
          <article
            key={message.id}
            className="rounded-lg bg-neutral-100 p-4 dark:bg-neutral-900"
          >
            <p className="mb-2 text-xs font-medium uppercase text-neutral-400">
              {message.role}
            </p>
            <div className="flex flex-col gap-2">
              {message.parts.map((part, partIndex) => (
                <MessagePart key={partIndex} part={part} />
              ))}
            </div>
          </article>
        ))}
      </section>

      {errorText && (
        <p className="text-sm text-red-600" data-testid="error">
          {errorText}
        </p>
      )}

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSend();
        }}
      >
        <input
          className="flex-1 rounded-md border border-neutral-300 px-3 py-2"
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
          placeholder="Say something to echo…"
          data-testid="chat-input"
        />
        <button
          type="submit"
          disabled={isStreaming}
          className="rounded-md bg-black px-4 py-2 text-white disabled:opacity-40 dark:bg-white dark:text-black"
          data-testid="send-button"
        >
          {isStreaming ? "Streaming…" : "Send"}
        </button>
      </form>
    </main>
  );
}

function MessagePart({
  part,
}: {
  part: SpikeChatMessage["parts"][number];
}) {
  switch (part.type) {
    case "text":
      return (
        <p data-testid="text-part">
          {part.text}
          {part.state === "streaming" && (
            <span className="animate-pulse text-neutral-400"> ▍</span>
          )}
        </p>
      );

    case "tool-echoOperation": {
      const isInputComplete =
        part.state === "input-available" ||
        part.state === "output-available" ||
        part.state === "output-error";
      const validation = isInputComplete
        ? echoOperationSchema.safeParse(part.input)
        : null;
      return (
        <div
          className="rounded-md border border-neutral-300 p-3 font-mono text-xs"
          data-testid="tool-part"
          data-state={part.state}
        >
          <p className="mb-1 font-sans font-medium">
            tool: echoOperation · state:{" "}
            <span data-testid="tool-state">{part.state}</span>
            {validation && (
              <span
                className={
                  validation.success ? "text-green-600" : "text-red-600"
                }
                data-testid="validation-result"
              >
                {" "}
                · client re-validation:{" "}
                {validation.success ? "valid ✓" : "INVALID ✗"}
              </span>
            )}
          </p>
          <pre className="whitespace-pre-wrap break-all">
            {JSON.stringify(part.input ?? "(streaming input…)", null, 2)}
          </pre>
          {validation && !validation.success && (
            <pre className="mt-1 whitespace-pre-wrap text-red-600">
              {JSON.stringify(validation.error.issues, null, 2)}
            </pre>
          )}
        </div>
      );
    }

    case "data-editor-operation": {
      const validation = editorOperationSchema.safeParse(part.data);
      return (
        <div
          className="rounded-md border border-dashed border-blue-400 p-3 font-mono text-xs"
          data-testid="editor-op-part"
        >
          <p className="mb-1 font-sans font-medium">
            editor-operations channel (data part)
            <span
              className={
                validation.success ? "text-green-600" : "text-red-600"
              }
            >
              {" "}
              · {validation.success ? "valid ✓" : "INVALID ✗"}
            </span>
          </p>
          <pre>{JSON.stringify(part.data, null, 2)}</pre>
        </div>
      );
    }

    case "step-start":
      return null;

    default:
      return (
        <p className="text-xs text-neutral-400">
          [unrendered part: {part.type}]
        </p>
      );
  }
}
