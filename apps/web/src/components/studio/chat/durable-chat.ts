import {
  GENERATION_REQUEST_DATA_PART_TYPE,
  type FlockChatMessage,
  type GenerationRequestDataPart,
} from "@/lib/chat-contract";
import { isStaticToolUIPart } from "ai";

export interface PersistedChatTurn {
  turnId: string;
  role: "user" | "assistant";
  content: string;
  sequence: number;
}

/*
  Build a new user message for AI SDK Chat.sendMessage.

  `sendMessage({ messageId })` is the SDK's replacement/regeneration path: it
  looks for an already-present user message with that id and throws when this
  is the first message in a thread. New messages must carry their stable id
  on the CreateUIMessage itself, while retries deliberately use messageId.
*/
export function createUserChatMessage({
  id,
  text,
  generationRequest,
}: {
  id: string;
  text: string;
  generationRequest?: GenerationRequestDataPart;
}): FlockChatMessage {
  const parts: FlockChatMessage["parts"] = [{ type: "text", text }];
  if (generationRequest !== undefined) {
    parts.push({
      type: GENERATION_REQUEST_DATA_PART_TYPE,
      data: generationRequest,
    });
  }
  return { id, role: "user", parts };
}

export function shouldApplyChatHydration({
  currentThreadKey,
  hydratedThreadKey,
  persistedTurns,
  isSamePersistedSnapshot,
}: {
  currentThreadKey: string | null;
  hydratedThreadKey: string | null;
  persistedTurns: readonly PersistedChatTurn[] | undefined;
  isSamePersistedSnapshot: boolean;
}): boolean {
  return (
    currentThreadKey !== null &&
    persistedTurns !== undefined &&
    (hydratedThreadKey !== currentThreadKey || !isSamePersistedSnapshot)
  );
}

export function isChatLifecycleCurrent({
  originCanvasId,
  originSessionId,
  originThreadKey,
  currentCanvasId,
  currentSessionId,
  currentThreadKey,
}: {
  originCanvasId: string | null;
  originSessionId: string | null;
  originThreadKey: string | null;
  currentCanvasId: string | null;
  currentSessionId: string | null;
  currentThreadKey: string | null;
}): boolean {
  return (
    originCanvasId === currentCanvasId &&
    originSessionId === currentSessionId &&
    originThreadKey === currentThreadKey
  );
}

export function getVisibleThreadProvisioningError({
  error,
  errorKey,
  currentCanvasKey,
  hasThread,
}: {
  error: string | undefined;
  errorKey: string | undefined;
  currentCanvasKey: string | null;
  hasThread: boolean;
}): string | undefined {
  return !hasThread && errorKey === currentCanvasKey ? error : undefined;
}

export function toPersistedChatMessages(turns: readonly PersistedChatTurn[]): FlockChatMessage[] {
  return [...turns]
    .sort((left, right) => left.sequence - right.sequence)
    .map((turn) => ({
      id: turn.turnId,
      role: turn.role,
      parts: [{ type: "text", text: turn.content }],
    })) as FlockChatMessage[];
}

export function getChatMessageText(message: Pick<FlockChatMessage, "parts">): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function mergePersistedChatMessages(
  persistedMessages: readonly FlockChatMessage[],
  liveMessages: readonly FlockChatMessage[],
): FlockChatMessage[] {
  const byId = new Map<string, FlockChatMessage>();
  for (const message of persistedMessages) {
    byId.set(message.id, message);
  }
  for (const message of liveMessages) {
    byId.set(message.id, message);
  }
  return [...byId.values()];
}

/*
  Replaying an interrupted model request is safe only while the interrupted
  logical turn is provably tool-free. Once a tool reached input-available, an
  approval was requested, or an editor command arrived, the browser or server
  may already have performed a side effect. Re-running the user's message
  could therefore apply an edit twice, create a second draft, or send a second
  email. The policy is deliberately conservative: even an input-streaming
  tool part blocks replay because the interrupted point is not durable proof
  that no executor received the call.
*/
export function isInterruptedTurnRetrySafe({
  messages,
  userMessageId,
}: {
  messages: readonly FlockChatMessage[];
  userMessageId: string;
}): boolean {
  const userMessageIndex = messages.findIndex(
    (message) => message.role === "user" && message.id === userMessageId,
  );
  if (userMessageIndex === -1) {
    return false;
  }

  return !messages.slice(userMessageIndex + 1).some((message) =>
    message.parts.some((part) => {
      return isStaticToolUIPart(part) || part.type === "data-editor-command";
    }),
  );
}
