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
 *
 * Document scoping (cross-draft leak fix): the chat panel stays mounted
 * across drafts-bar switches and the transport reads the CURRENT document at
 * send time, so an unscoped queue would fire a message queued in draft A into
 * whichever draft is active when the agent goes idle. Queues are therefore
 * held PER DOCUMENT ID: switching drafts swaps the visible queue to the
 * incoming document's (the outgoing one keeps its items and resumes when
 * reactivated), and {@link UseMessageQueueInput.getActiveDocumentId} (a LIVE
 * check on the editor store) rejects any dispatch that a draft switch raced.
 */

export interface QueuedMessage {
  id: string;
  text: string;
}

export interface UseMessageQueueInput {
  /*
    The connected document — every queue mutation applies to THIS doc's queue.
  */
  documentId: string | null;
  /*
    Live document-id re-check, read at dispatch time (never render-stale).
  */
  getActiveDocumentId: () => string | null;
  /*
    Reactive idle signal: status "ready" and no approval pending.
  */
  isAgentIdle: boolean;
  /*
    True when the last turn errored — the queue holds until the user acts.
  */
  isErrorPaused: boolean;
  /*
    Live idle re-check, read at dispatch time (never render-stale).
  */
  getIsAgentIdle: () => boolean;
  /*
    Sends one message into the thread (also records prompt history).
  */
  sendUserMessage: (text: string) => void;
}

export interface MessageQueue {
  queuedMessages: QueuedMessage[];
  enqueueMessage: (text: string) => void;
  updateQueuedMessage: (input: { id: string; text: string }) => void;
  removeQueuedMessage: (id: string) => void;
  clearQueue: () => void;
  /*
    Manually dispatch the head — the error-pause "Send next" affordance.
  */
  sendNextQueuedMessage: () => void;
}

export function useMessageQueue({
  documentId,
  getActiveDocumentId,
  isAgentIdle,
  isErrorPaused,
  getIsAgentIdle,
  sendUserMessage,
}: UseMessageQueueInput): MessageQueue {
  const [queuedMessages, setQueuedMessagesState] = useState<QueuedMessage[]>([]);
  /*
    Synchronously-updated mirror of EVERY document's queue: the deferred
    dispatch below must see edits and deletions even when its timeout fires
    before React re-renders, and a draft switch must never lose the outgoing
    document's queued items.
  */
  const queuesByDocumentIdRef = useRef(new Map<string | null, QueuedMessage[]>());

  const getQueueForThisDocument = (): QueuedMessage[] =>
    queuesByDocumentIdRef.current.get(documentId) ?? [];

  const setQueueForThisDocument = (nextQueue: QueuedMessage[]): void => {
    queuesByDocumentIdRef.current.set(documentId, nextQueue);
    setQueuedMessagesState(nextQueue);
  };

  /*
    Draft switch: swap the visible queue to the incoming document's. The
    outgoing document's items stay in the map and resume when it reactivates.
  */
  useEffect(() => {
    setQueuedMessagesState(queuesByDocumentIdRef.current.get(documentId) ?? []);
  }, [documentId]);

  const dispatchHead = (): void => {
    if (getActiveDocumentId() !== documentId) {
      /*
        A draft switch raced this dispatch — the queue belongs to a document
        that is no longer connected, and sending now would apply the message
        to the WRONG draft (the transport reads the store at send time).
      */
      return;
    }
    const [head, ...rest] = getQueueForThisDocument();
    if (head === undefined) {
      return;
    }
    setQueueForThisDocument(rest);
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
    /*
      getIsAgentIdle/dispatchHead are stable-by-construction closures over
      refs/the Chat instance; queuedMessages keys rescheduling after edits,
      documentId retargets the dispatch after a draft switch.
    */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAgentIdle, isErrorPaused, queuedMessages, documentId]);

  return {
    queuedMessages,
    enqueueMessage: (text: string): void => {
      setQueueForThisDocument([...getQueueForThisDocument(), { id: crypto.randomUUID(), text }]);
    },
    updateQueuedMessage: ({ id, text }: { id: string; text: string }): void => {
      setQueueForThisDocument(
        getQueueForThisDocument().map((message) =>
          message.id === id ? { ...message, text } : message,
        ),
      );
    },
    removeQueuedMessage: (id: string): void => {
      setQueueForThisDocument(getQueueForThisDocument().filter((message) => message.id !== id));
    },
    clearQueue: (): void => {
      setQueueForThisDocument([]);
    },
    sendNextQueuedMessage: dispatchHead,
  };
}
