"use client";

import { useRef, useState } from "react";
import { useFlockAuth } from "@/lib/auth/use-flock-auth";
import { useEditorStore } from "@/lib/editor-store";
import {
  readLastUsedRecipient,
  requestTestEmailSend,
  resolveDefaultRecipient,
  saveLastUsedRecipient,
  validateRecipient,
} from "./send-test-email-client";

/**
 * The state behind every "send a test" surface.
 *
 * Both entry points — the frame toolbar's Send-test dialog and the HTML
 * preview dialog's inline send row — run this hook and hand the result to
 * {@link SendTestEmailForm}, so the two are the same control in two places
 * rather than two implementations that drift.
 *
 * All of the decisions worth testing (which address to prefill, whether an
 * address is usable, what a given server reply means in English) live in the
 * React-free `send-test-email-client` module; this is just the wiring.
 */

export type SendTestEmailState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent"; recipient: string }
  | { status: "error"; message: string; isRecipientInvalid: boolean };

export interface SendTestEmailControl {
  recipient: string;
  updateRecipient: (next: string) => void;
  sendState: SendTestEmailState;
  isSending: boolean;
  /** Clear the last result and prefill the default address. Call on open. */
  prepareToSend: () => void;
  /** Orphan any in-flight response so it can't land after close. */
  discardInFlightSend: () => void;
  submitSend: () => void;
}

export function useSendTestEmail(): SendTestEmailControl {
  const { identity } = useFlockAuth();
  const [recipient, setRecipient] = useState("");
  const [sendState, setSendState] = useState<SendTestEmailState>({ status: "idle" });
  // Once the user types, no prefill may overwrite them again.
  const [hasUserEditedRecipient, setHasUserEditedRecipient] = useState(false);
  const requestIdRef = useRef(0);

  // The identity query resolves asynchronously, so a dialog opened on a cold
  // load can be prefilled before the signed-in address is known. Seed it the
  // moment it arrives — DURING RENDER, not in an effect: React re-runs this
  // component with the new state before painting, so the field never flashes
  // empty-then-filled (and react-hooks/set-state-in-effect stays satisfied).
  // No localStorage here: this path must be safe during prerendering, and a
  // resolved identity only ever exists in the browser.
  const signedInRecipient = resolveDefaultRecipient({ identity, lastUsedRecipient: "" });
  const [seededFrom, setSeededFrom] = useState(signedInRecipient);
  if (seededFrom !== signedInRecipient) {
    setSeededFrom(signedInRecipient);
    if (!hasUserEditedRecipient && signedInRecipient !== "") {
      setRecipient(signedInRecipient);
    }
  }

  const updateRecipient = (next: string): void => {
    setRecipient(next);
    setHasUserEditedRecipient(true);
    // Instant feedback: the moment they change the address, the stale result
    // stops applying to what's on screen.
    if (sendState.status !== "idle") {
      setSendState({ status: "idle" });
    }
  };

  const prepareToSend = (): void => {
    setSendState({ status: "idle" });
    if (hasUserEditedRecipient) {
      return;
    }
    // Read here rather than at mount: this runs from an open handler, so the
    // browser definitely exists (a client component still renders on the
    // server, where touching localStorage would throw).
    setRecipient(
      resolveDefaultRecipient({ identity, lastUsedRecipient: readLastUsedRecipient() }),
    );
  };

  const discardInFlightSend = (): void => {
    requestIdRef.current += 1;
  };

  const submitSend = (): void => {
    if (sendState.status === "sending") {
      return;
    }
    const validation = validateRecipient(recipient);
    if (!validation.isValid) {
      setSendState({ status: "error", message: validation.message, isRecipientInvalid: true });
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const isCurrent = (): boolean => requestIdRef.current === requestId;
    setSendState({ status: "sending" });
    requestTestEmailSend({
      // The store's doc at submit time — always the ACTIVE draft, and exactly
      // what the preview beside this form is showing.
      document: useEditorStore.getState().doc,
      to: validation.recipient,
    })
      .then((result) => {
        if (!isCurrent()) {
          return;
        }
        if (result.isSent) {
          saveLastUsedRecipient(validation.recipient);
          setSendState({ status: "sent", recipient: result.recipient });
          return;
        }
        setSendState({
          status: "error",
          message: result.message,
          isRecipientInvalid: result.kind === "invalid_recipient",
        });
      })
      .catch(() => {
        if (isCurrent()) {
          setSendState({
            status: "error",
            message: "The test email couldn’t be sent — please try again.",
            isRecipientInvalid: false,
          });
        }
      });
  };

  return {
    recipient,
    updateRecipient,
    sendState,
    isSending: sendState.status === "sending",
    prepareToSend,
    discardInFlightSend,
    submitSend,
  };
}
