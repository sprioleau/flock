import { describe, expect, it, vi } from "vitest";
import type { FlockChatMessage } from "@/lib/chat-contract";
import {
  getChatMessageText,
  getVisibleThreadProvisioningError,
  isChatLifecycleCurrent,
  isInterruptedTurnRetrySafe,
  mergePersistedChatMessages,
  shouldApplyChatHydration,
  toPersistedChatMessages,
} from "./durable-chat";

function message(
  input: { id: string; role: "user" | "assistant"; text: string },
): FlockChatMessage {
  return { id: input.id, role: input.role, parts: [{ type: "text", text: input.text }] } as FlockChatMessage;
}

describe("durable canvas chat mapping", () => {
  it("hydrates ordered persisted turns as text parts", () => {
    const messages = toPersistedChatMessages([
      { turnId: "assistant-1", role: "assistant", content: "Done", sequence: 2 },
      { turnId: "user-1", role: "user", content: "Make it bold", sequence: 1 },
    ]);

    expect(messages).toEqual([
      message({ id: "user-1", role: "user", text: "Make it bold" }),
      message({ id: "assistant-1", role: "assistant", text: "Done" }),
    ]);
    expect(getChatMessageText(messages[1]!)).toBe("Done");
  });

  it("merges server hydration without duplicating live messages", () => {
    const persisted = [
      message({ id: "user-1", role: "user", text: "Hello" }),
      message({ id: "assistant-1", role: "assistant", text: "Hi" }),
    ];
    const live = [
      message({ id: "user-1", role: "user", text: "Hello" }),
      message({ id: "assistant-2", role: "assistant", text: "New" }),
    ];

    expect(mergePersistedChatMessages(persisted, live).map((item) => item.id)).toEqual([
      "user-1",
      "assistant-1",
      "assistant-2",
    ]);
  });

  it("applies one hydration snapshot once, then allows a changed snapshot", () => {
    const persistedTurns = [
      { turnId: "user-1", role: "user" as const, content: "Hello", sequence: 1 },
    ];

    expect(
      shouldApplyChatHydration({
        currentThreadKey: "canvas-1:thread-1",
        hydratedThreadKey: null,
        persistedTurns,
        isSamePersistedSnapshot: false,
      }),
    ).toBe(true);
    expect(
      shouldApplyChatHydration({
        currentThreadKey: "canvas-1:thread-1",
        hydratedThreadKey: "canvas-1:thread-1",
        persistedTurns,
        isSamePersistedSnapshot: true,
      }),
    ).toBe(false);
    expect(
      shouldApplyChatHydration({
        currentThreadKey: "canvas-1:thread-1",
        hydratedThreadKey: "canvas-1:thread-1",
        persistedTurns: [...persistedTurns],
        isSamePersistedSnapshot: false,
      }),
    ).toBe(true);
  });

  it("rejects lifecycle callbacks from a previous canvas or thread", () => {
    expect(
      isChatLifecycleCurrent({
        originCanvasId: "canvas-1",
        originSessionId: "session-1",
        originThreadKey: "canvas-1:thread-1",
        currentCanvasId: "canvas-2",
        currentSessionId: "session-1",
        currentThreadKey: "canvas-2:thread-2",
      }),
    ).toBe(false);
    expect(
      isChatLifecycleCurrent({
        originCanvasId: "canvas-1",
        originSessionId: "session-1",
        originThreadKey: "canvas-1:thread-1",
        currentCanvasId: "canvas-1",
        currentSessionId: "session-1",
        currentThreadKey: "canvas-1:thread-1",
      }),
    ).toBe(true);
  });

  it("shows provisioning retry only for the current canvas without a thread", () => {
    expect(
      getVisibleThreadProvisioningError({
        error: "Retry me",
        errorKey: "canvas-1",
        currentCanvasKey: "canvas-1",
        hasThread: false,
      }),
    ).toBe("Retry me");
    expect(
      getVisibleThreadProvisioningError({
        error: "Stale",
        errorKey: "canvas-1",
        currentCanvasKey: "canvas-2",
        hasThread: false,
      }),
    ).toBeUndefined();
    expect(
      getVisibleThreadProvisioningError({
        error: "Already loaded",
        errorKey: "canvas-1",
        currentCanvasKey: "canvas-1",
        hasThread: true,
      }),
    ).toBeUndefined();
  });

  it("defers tool persistence only while a continuation can still settle", async () => {
    const { shouldDeferAssistantPersistence } = await import("./use-flock-chat");
    const completedToolMessage = {
      id: "assistant-1",
      role: "assistant" as const,
      parts: [
        {
          type: "tool-updateBlockProperties",
          toolCallId: "call-1",
          state: "output-available",
          input: {},
          output: { status: "applied" },
        },
      ],
    } as FlockChatMessage;
    expect(
      shouldDeferAssistantPersistence({
        message: completedToolMessage,
        messages: [completedToolMessage],
        finishReason: "tool-calls",
        isMockEnabled: false,
        autoContinuationCount: 0,
      }),
    ).toBe(true);
    expect(
      shouldDeferAssistantPersistence({
        message: completedToolMessage,
        messages: [completedToolMessage],
        finishReason: "tool-calls",
        isMockEnabled: false,
        autoContinuationCount: 1,
      }),
    ).toBe(false);
  });

  it("settles a rejected client executor with one safe terminal error", async () => {
    const { settleClientToolCall } = await import("./use-flock-chat");
    const outputs: unknown[] = [];

    settleClientToolCall({
      tool: "createDraft",
      toolCallId: "call-rejected",
      execute: async () => {
        throw new Error("provider secret should not reach the model");
      },
      toOutput: () => ({ status: "created" }),
      addToolOutput: (output) => {
        outputs.push(output);
      },
    });

    await vi.waitFor(() => expect(outputs).toHaveLength(1));
    expect(outputs[0]).toMatchObject({
      state: "output-error",
      tool: "createDraft",
      toolCallId: "call-rejected",
    });
    expect(JSON.parse(String((outputs[0] as { errorText: string }).errorText))).toEqual({
      kind: "flock-chat-error",
      failureKind: "retryable",
      errors: [
        {
          code: "client_executor_failed",
          message: "Flock couldn't complete that action. Try again.",
        },
      ],
    });
  });

  it("turns a successful executor formatting failure into one terminal error", async () => {
    const { settleClientToolCall } = await import("./use-flock-chat");
    const outputs: unknown[] = [];

    settleClientToolCall({
      tool: "applyThemeToDraft",
      toolCallId: "call-format-failed",
      execute: async () => ({ status: "applied" }),
      toOutput: () => {
        throw new Error("formatter secret should not escape");
      },
      addToolOutput: (output) => {
        outputs.push(output);
      },
    });

    await vi.waitFor(() => expect(outputs).toHaveLength(1));
    expect(outputs[0]).toMatchObject({
      state: "output-error",
      tool: "applyThemeToDraft",
      toolCallId: "call-format-failed",
    });
  });

  it("allows replay only when the interrupted turn is proven tool-free", () => {
    expect(
      isInterruptedTurnRetrySafe({
        userMessageId: "user-1",
        messages: [message({ id: "user-1", role: "user", text: "Make it warmer." })],
      }),
    ).toBe(true);
  });

  it.each([
    "tool-updateBlockProperties",
    "tool-createDraft",
    "tool-sendTestEmail",
    "tool-generateImage",
  ])("blocks replay after a %s signal", (toolType) => {
    expect(
      isInterruptedTurnRetrySafe({
        userMessageId: "user-1",
        messages: [
          message({ id: "user-1", role: "user", text: "Do the requested change." }),
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: toolType,
                toolCallId: "call-1",
                state: "output-available",
                input: {},
                output: { status: "applied" },
              },
            ],
          },
        ] as FlockChatMessage[],
      }),
    ).toBe(false);
  });

  it("blocks replay when an approval or editor command may have run", () => {
    expect(
      isInterruptedTurnRetrySafe({
        userMessageId: "user-1",
        messages: [
          message({ id: "user-1", role: "user", text: "Send a test email." }),
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-sendTestEmail",
                toolCallId: "call-1",
                state: "approval-requested",
                input: { to: "person@example.com" },
                approval: { id: "approval-1" },
              },
              {
                type: "data-editor-command",
                id: "command-1",
                data: {
                  type: "data-editor-command",
                  toolCallId: "call-1",
                  command: { type: "sendTestEmail", to: "person@example.com" },
                },
              },
            ],
          },
        ] as FlockChatMessage[],
      }),
    ).toBe(false);
  });

  it("blocks replay even when a tool only streamed partial input", () => {
    expect(
      isInterruptedTurnRetrySafe({
        userMessageId: "user-1",
        messages: [
          message({ id: "user-1", role: "user", text: "Make it warmer." }),
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-updateBlockProperties",
                toolCallId: "call-1",
                state: "input-streaming",
                input: {},
              },
            ],
          },
        ] as FlockChatMessage[],
      }),
    ).toBe(false);
  });
});
