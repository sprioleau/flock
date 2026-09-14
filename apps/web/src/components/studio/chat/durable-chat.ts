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
  createdAtMs?: number;
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
  return { id, role: "user", metadata: { createdAtMs: Date.now() }, parts };
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
      ...(turn.createdAtMs === undefined
        ? {}
        : { metadata: { createdAtMs: turn.createdAtMs } }),
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
  /*
    The live transcript is the only source that contains ephemeral parts such
    as clarification widgets. Persisted assistant turns intentionally keep
    text only, so a clarification can be live-only while the turns around it
    already exist in the persisted snapshot. Merge by the live order wherever
    the two snapshots share an id, then place missing live messages in the
    corresponding gap instead of appending them to the transcript's end.
  */
  const persistedIndexById = new Map<string, number>();
  const uniquePersistedMessages: FlockChatMessage[] = [];
  for (const message of persistedMessages) {
    if (persistedIndexById.has(message.id)) {
      continue;
    }
    persistedIndexById.set(message.id, uniquePersistedMessages.length);
    uniquePersistedMessages.push(message);
  }

  const liveById = new Map<string, FlockChatMessage>();
  for (const message of liveMessages) {
    liveById.set(message.id, message);
  }

  const liveOnlyBySlot = Array.from(
    { length: uniquePersistedMessages.length + 1 },
    () => [] as FlockChatMessage[],
  );
  const seenLiveOnlyIds = new Set<string>();
  for (let liveIndex = 0; liveIndex < liveMessages.length; liveIndex += 1) {
    const message = liveMessages[liveIndex]!;
    const persistedIndex = persistedIndexById.get(message.id);
    if (persistedIndex !== undefined || seenLiveOnlyIds.has(message.id)) {
      continue;
    }

    let nextPersistedIndex: number | undefined;
    for (
      let nextLiveIndex = liveIndex + 1;
      nextLiveIndex < liveMessages.length;
      nextLiveIndex += 1
    ) {
      const candidateIndex = persistedIndexById.get(liveMessages[nextLiveIndex]!.id);
      if (candidateIndex !== undefined) {
        nextPersistedIndex = candidateIndex;
        break;
      }
    }
    let previousPersistedIndex = -1;
    for (
      let previousLiveIndex = liveIndex - 1;
      previousLiveIndex >= 0;
      previousLiveIndex -= 1
    ) {
      const candidateIndex = persistedIndexById.get(liveMessages[previousLiveIndex]!.id);
      if (candidateIndex !== undefined) {
        previousPersistedIndex = candidateIndex;
        break;
      }
    }
    const slot =
      nextPersistedIndex === undefined
        ? uniquePersistedMessages.length
        : previousPersistedIndex >= 0
          ? previousPersistedIndex + 1
          : nextPersistedIndex;
    liveOnlyBySlot[slot]!.push(message);
    seenLiveOnlyIds.add(message.id);
  }

  const merged: FlockChatMessage[] = [];
  for (let slot = 0; slot <= uniquePersistedMessages.length; slot += 1) {
    merged.push(...liveOnlyBySlot[slot]!);
    const persistedMessage = uniquePersistedMessages[slot];
    if (persistedMessage !== undefined) {
      merged.push(liveById.get(persistedMessage.id) ?? persistedMessage);
    }
  }
  return merged;
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
