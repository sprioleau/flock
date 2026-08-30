"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { MAX_TEST_SEND_RECIPIENTS } from "@/app/api/send-test-email/contract";
import { useFlockAuth } from "@/lib/auth/use-flock-auth";
import { useEditorStore } from "@/lib/editor-store";
import {
  deriveSubjectFromDocument,
  readLastUsedRecipient,
  requestTestEmailSend,
  resolveDefaultRecipient,
  saveLastUsedRecipient,
  validateRecipients,
} from "./send-test-email-client";

/**
 * The state behind every "send a test" surface.
 *
 * Both entry points — the frame toolbar's Send-test dialog and the HTML
 * preview dialog's inline send row — run this hook and hand the result to
 * {@link SendTestEmailForm}, so the two are the same control in two places
 * rather than two implementations that drift.
 *
 * All of the decisions worth testing (which addresses to prefill, whether a
 * recipient LIST is usable, what a given server reply means in English, the
 * subject we derive from the draft) live in the React-free
 * `send-test-email-client` module; this is just the wiring.
 *
 * Subject and preview text are CANVAS-level, not send-level: they are read from
 * `canvases.getCanvasEmailMeta` and written back with
 * `canvases.setCanvasEmailMeta`, keyed by the active canvas the same way the
 * brand-kit panel reads `brandKits.getBrandKitForCanvas`. The `canvasId` comes
 * from the editor store, which is populated for both dialogs (they both live in
 * the studio). When there is no canvas yet — a cold prerender, or before a doc
 * is connected — the fields still work as plain inputs (subject prefilled from
 * the draft's first heading) and still ride the wire on send; they simply are
 * not persisted. That is the graceful-degradation path, not a special case.
 */

export type SendTestEmailState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent"; recipients: string[] }
  | { status: "error"; message: string; isRecipientInvalid: boolean };

export interface SendTestEmailControl {
  /*
    One-to-five ordered rows; always at least one (possibly blank) row.
  */
  recipients: string[];
  updateRecipientAt: (index: number, next: string) => void;
  addRecipient: () => void;
  removeRecipientAt: (index: number) => void;
  /** False once the list is at {@link MAX_TEST_SEND_RECIPIENTS} rows. */
  canAddRecipient: boolean;
  subject: string;
  updateSubject: (next: string) => void;
  /*
    Persist the subject to the canvas. Call on blur (see below).
  */
  persistSubject: () => void;
  previewText: string;
  updatePreviewText: (next: string) => void;
  /*
    Persist the preview text to the canvas. Call on blur.
  */
  persistPreviewText: () => void;
  sendState: SendTestEmailState;
  isSending: boolean;
  /*
    Clear the last result and prefill the defaults. Call on open.
  */
  prepareToSend: () => void;
  /*
    Orphan any in-flight response so it can't land after close.
  */
  discardInFlightSend: () => void;
  submitSend: () => void;
}

export function useSendTestEmail(): SendTestEmailControl {
  const { identity } = useFlockAuth();
  const canvasId = useEditorStore((state) => state.canvasId);
  const sessionId = useEditorStore((state) => state.authorId);

  /*
    The canvas-level subject / preview for the active canvas. Subscribed here
    (the hook runs even while the dialog is closed), so by the time a user can
    open the dialog this has almost always resolved. `"skip"` while there is no
    canvas — the fields then fall back to the draft-derived subject.
  */
  const emailMeta = useQuery(
    api.canvases.getCanvasEmailMeta,
    canvasId !== null ? { canvasId } : "skip",
  );
  const setCanvasEmailMeta = useMutation(api.canvases.setCanvasEmailMeta);

  const [recipients, setRecipients] = useState<string[]>([""]);
  const [subject, setSubject] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [sendState, setSendState] = useState<SendTestEmailState>({ status: "idle" });
  /*
    Once the user touches a field, no prefill may overwrite it again.
  */
  const [hasUserEditedRecipients, setHasUserEditedRecipients] = useState(false);
  const [hasUserEditedSubject, setHasUserEditedSubject] = useState(false);
  const [hasUserEditedPreviewText, setHasUserEditedPreviewText] = useState(false);
  const requestIdRef = useRef(0);

  /*
    The identity query resolves asynchronously, so a dialog opened on a cold
    load can be prefilled before the signed-in address is known. Seed it the
    moment it arrives — DURING RENDER, not in an effect: React re-runs this
    component with the new state before painting, so the field never flashes
    empty-then-filled (and react-hooks/set-state-in-effect stays satisfied).
    No localStorage here: this path must be safe during prerendering, and a
    resolved identity only ever exists in the browser.
  */
  const signedInRecipient = resolveDefaultRecipient({ identity, lastUsedRecipient: "" });
  const [seededFrom, setSeededFrom] = useState(signedInRecipient);
  if (seededFrom !== signedInRecipient) {
    setSeededFrom(signedInRecipient);
    if (!hasUserEditedRecipients && signedInRecipient !== "") {
      setRecipients([signedInRecipient]);
    }
  }

  /*
    The canvas metadata resolves asynchronously too. Seed subject / preview the
    moment it lands, on the SAME during-render pattern as the recipient above,
    so a dialog opened before the query settled still fills from the canvas
    rather than being stuck on the draft-derived fallback — and never clobbers
    a value the user has already edited.
  */
  const [seededMeta, setSeededMeta] = useState(emailMeta);
  if (seededMeta !== emailMeta) {
    setSeededMeta(emailMeta);
    if (emailMeta !== undefined && emailMeta !== null) {
      if (!hasUserEditedSubject) {
        setSubject(emailMeta.subject ?? deriveSubjectFromDocument(useEditorStore.getState().doc));
      }
      if (!hasUserEditedPreviewText) {
        setPreviewText(emailMeta.previewText ?? "");
      }
    }
  }

  const clearStaleResult = (): void => {
    /*
      Instant feedback: the moment they change the send, a stale result stops
      applying to what's on screen.
    */
    if (sendState.status !== "idle") {
      setSendState({ status: "idle" });
    }
  };

  const updateRecipientAt = (index: number, next: string): void => {
    setRecipients((current) => current.map((value, i) => (i === index ? next : value)));
    setHasUserEditedRecipients(true);
    clearStaleResult();
  };

  const addRecipient = (): void => {
    setRecipients((current) =>
      current.length >= MAX_TEST_SEND_RECIPIENTS ? current : [...current, ""],
    );
    setHasUserEditedRecipients(true);
  };

  const removeRecipientAt = (index: number): void => {
    /*
      Never drop the last row — the form always shows at least one field.
    */
    setRecipients((current) =>
      current.length <= 1 ? current : current.filter((_, i) => i !== index),
    );
    setHasUserEditedRecipients(true);
    clearStaleResult();
  };

  const updateSubject = (next: string): void => {
    setSubject(next);
    setHasUserEditedSubject(true);
  };

  const updatePreviewText = (next: string): void => {
    setPreviewText(next);
    setHasUserEditedPreviewText(true);
  };

  /*
    Persistence is on BLUR, not per keystroke: a keystroke-level save would fire
    a mutation for every letter typed. Blur is also the right grain for a
    canvas-level property — the user has finished stating what the subject IS —
    and it means an edit is kept even if they close the dialog without sending.

    It only writes when the field was actually edited AND the value differs from
    what the canvas already holds, so tabbing through an untouched (draft-
    derived) field never stamps that fallback onto the canvas, and a re-blur
    with no change is a no-op. A missing canvas or session means there is
    nothing to attribute the write to; the value still rides the wire on send,
    it just isn't stored (the graceful-degradation path). The write is
    fire-and-forget — a failure leaves the local value intact and the send
    unaffected, so it is swallowed rather than surfaced.
  */
  const persistEmailMetaField = (field: "subject" | "previewText", value: string): void => {
    if (canvasId === null || sessionId === null) {
      return;
    }
    const storedValue = (field === "subject" ? emailMeta?.subject : emailMeta?.previewText) ?? "";
    if (value.trim() === storedValue) {
      return;
    }
    void setCanvasEmailMeta({ canvasId, [field]: value, sessionId }).catch(() => {
      /*
        Persisting is a nicety; the value still sends. Swallow and move on.
      */
    });
  };

  const persistSubject = (): void => {
    if (hasUserEditedSubject) {
      persistEmailMetaField("subject", subject);
    }
  };

  const persistPreviewText = (): void => {
    if (hasUserEditedPreviewText) {
      persistEmailMetaField("previewText", previewText);
    }
  };

  const prepareToSend = (): void => {
    setSendState({ status: "idle" });

    /*
      Subject / preview reset to the canvas value (their persisted source of
      truth), falling back to the draft's first heading for the subject.
    */
    const document = useEditorStore.getState().doc;
    setSubject(emailMeta?.subject ?? deriveSubjectFromDocument(document));
    setPreviewText(emailMeta?.previewText ?? "");
    setHasUserEditedSubject(false);
    setHasUserEditedPreviewText(false);

    if (hasUserEditedRecipients) {
      return;
    }
    /*
      Read here rather than at mount: this runs from an open handler, so the
      browser definitely exists (a client component still renders on the
      server, where touching localStorage would throw).
    */
    setRecipients([
      resolveDefaultRecipient({ identity, lastUsedRecipient: readLastUsedRecipient() }),
    ]);
  };

  const discardInFlightSend = (): void => {
    requestIdRef.current += 1;
  };

  const submitSend = (): void => {
    if (sendState.status === "sending") {
      return;
    }
    const validation = validateRecipients(recipients);
    if (!validation.isValid) {
      setSendState({ status: "error", message: validation.message, isRecipientInvalid: true });
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const isCurrent = (): boolean => requestIdRef.current === requestId;
    setSendState({ status: "sending" });
    requestTestEmailSend({
      /*
        The store's doc at submit time — always the ACTIVE draft, and exactly
        what the preview beside this form is showing.
      */
      document: useEditorStore.getState().doc,
      to: validation.recipients,
      subject,
      previewText,
    })
      .then((result) => {
        if (!isCurrent()) {
          return;
        }
        if (result.isSent) {
          /*
            The first row seeds the next open; the rest are not remembered.
          */
          saveLastUsedRecipient(validation.recipients[0]!);
          setSendState({ status: "sent", recipients: result.recipients });
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
    recipients,
    updateRecipientAt,
    addRecipient,
    removeRecipientAt,
    canAddRecipient: recipients.length < MAX_TEST_SEND_RECIPIENTS,
    subject,
    updateSubject,
    persistSubject,
    previewText,
    updatePreviewText,
    persistPreviewText,
    sendState,
    isSending: sendState.status === "sending",
    prepareToSend,
    discardInFlightSend,
    submitSend,
  };
}
