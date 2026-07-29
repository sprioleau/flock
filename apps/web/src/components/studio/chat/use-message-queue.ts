"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The composer's FIFO message queue (Phase: chat-UX upgrade).
 *
 * Submitting while the agent is busy queues the message; every queued item
 * stays editable/deletable until the moment it is dispatched. When the agent
 * goes idle (turn fully finished — streaming done, op application done, and
 * NO approval pending) the head auto-sends, then the next after ITS turn,
 * and so on.
 *
 * Dispatch safety:
 * - The auto-dispatch is deferred one macrotask. Between continuation rounds
 *   (tool-result follow-ups, approval resubmits) the AI SDK flips status
 *   "ready" → "submitted" inside a microtask chain, so a mid-turn "ready"
 *   flicker is already "submitted" again by the time the timeout runs and
 *   {@link UseMessageQueueInput.getIsAgentIdle} (a LIVE check on the Chat
 *   instance) rejects the dispatch. The same live re-check makes StrictMode
 *   double-invoked effects and rapid completion events single-send:
 *   `sendMessage` sets status "submitted" synchronously.
 * - The queue is mirrored into a ref SYNCHRONOUSLY on every mutation, so a
 *   deletion or edit that races the dispatch timeout is always respected.
 * - When a turn ERRORS the queue holds (isErrorPaused) instead of silently
 *   draining — the UI surfaces "queue paused" with send-next/clear actions.
 */

export interface QueuedMessage {
  id: string;
  text: string;
}

export interface UseMessageQueueInput {
  /** Reactive idle signal: status "ready" and no approval pending. */
  isAgentIdle: boolean;
  /** True when the last turn errored — the queue holds until the user acts. */
  isErrorPaused: boolean;
  /** Live idle re-check, read at dispatch time (never render-stale). */
  getIsAgentIdle: () => boolean;
  /** Sends one message into the thread (also records prompt history). */
  sendUserMessage: (text: string) => void;
}

export interface MessageQueue {
  queuedMessages: QueuedMessage[];
  enqueueMessage: (text: string) => void;
  updateQueuedMessage: (input: { id: string; text: string }) => void;
  removeQueuedMessage: (id: string) => void;
  clearQueue: () => void;
  /** Manually dispatch the head — the error-pause "Send next" affordance. */
  sendNextQueuedMessage: () => void;
}

export function useMessageQueue({
  isAgentIdle,
  isErrorPaused,
  getIsAgentIdle,
  sendUserMessage,
}: UseMessageQueueInput): MessageQueue {
  const [queuedMessages, setQueuedMessagesState] = useState<QueuedMessage[]>([]);
  // Synchronously-updated mirror: the deferred dispatch below must see edits
  // and deletions even when its timeout fires before React re-renders.
  const queueRef = useRef<QueuedMessage[]>([]);

  const setQueue = (nextQueue: QueuedMessage[]): void => {
    queueRef.current = nextQueue;
    setQueuedMessagesState(nextQueue);
  };

  const dispatchHead = (): void => {
    const [head, ...rest] = queueRef.current;
    if (head === undefined) {
      return;
    }
    setQueue(rest);
    sendUserMessage(head.text);
  };

  useEffect(() => {
    if (!isAgentIdle || isErrorPaused || queuedMessages.length === 0) {
      return;
    }
    const timeoutId = setTimeout(() => {
      if (getIsAgentIdle()) {
        dispatchHead();
      }
    }, 0);
    return () => clearTimeout(timeoutId);
    // getIsAgentIdle/dispatchHead are stable-by-construction closures over
    // refs/the Chat instance; queuedMessages keys rescheduling after edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAgentIdle, isErrorPaused, queuedMessages]);

  return {
    queuedMessages,
    enqueueMessage: (text: string): void => {
      setQueue([...queueRef.current, { id: crypto.randomUUID(), text }]);
    },
    updateQueuedMessage: ({ id, text }: { id: string; text: string }): void => {
      setQueue(
        queueRef.current.map((message) => (message.id === id ? { ...message, text } : message)),
      );
    },
    removeQueuedMessage: (id: string): void => {
      setQueue(queueRef.current.filter((message) => message.id !== id));
    },
    clearQueue: (): void => {
      setQueue([]);
    },
    sendNextQueuedMessage: dispatchHead,
  };
}
