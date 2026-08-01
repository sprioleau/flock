"use client";

import { useRef, useState } from "react";
import { CheckIcon, LoaderCircleIcon, SendIcon } from "lucide-react";
import { z } from "zod";
import {
  SEND_TEST_EMAIL_API_PATH,
  type SendTestEmailErrorResponseBody,
  type SendTestEmailResponseBody,
} from "@/app/api/send-test-email/contract";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEditorStore } from "@/lib/editor-store";
import { useUiSurfaceOpenRequest } from "@/lib/ui-surfaces";
import { useCanvasDrafts } from "./drafts/use-canvas-drafts";

/**
 * The header's "Send test" button + dialog: sends the ACTIVE draft to any
 * inbox through POST /api/send-test-email — the human entry to the SAME
 * Resend machinery the chat approval flow executes (one send path; the
 * payload-hash idempotency key makes a re-click on an unchanged draft a
 * no-op replay, while any edit sends fresh).
 *
 * Reads the store's doc at submit time, so it always sends the ACTIVE draft
 * (the HtmlPreviewDialog pattern). The last-used recipient is remembered in
 * localStorage and prefilled on the next open.
 */

const LAST_RECIPIENT_STORAGE_KEY = "flock:send-test-email:last-recipient";

/** Empty string when unset or when storage is unavailable (private mode). */
function readLastUsedRecipient(): string {
  try {
    return window.localStorage.getItem(LAST_RECIPIENT_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastUsedRecipient(recipient: string): void {
  try {
    window.localStorage.setItem(LAST_RECIPIENT_STORAGE_KEY, recipient);
  } catch {
    // Storage unavailable — the prefill nicety is skipped, the send stands.
  }
}

type SendState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent"; recipient: string }
  | { status: "error"; message: string; isRecipientInvalid: boolean };

export function SendTestEmailDialog({
  isIconTrigger = false,
}: {
  /**
   * The compact icon-only trigger used by the floating per-frame toolbar
   * (§10.2 frames UX — a test sends ONE draft, so the entry point rides the
   * frame); default is the labeled header-style button.
   */
  isIconTrigger?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [sendState, setSendState] = useState<SendState>({ status: "idle" });
  const requestIdRef = useRef(0);
  const { drafts, activeIndex } = useCanvasDrafts();
  const activeDraftName = activeIndex === -1 ? undefined : drafts?.[activeIndex]?.name;

  const isSending = sendState.status === "sending";

  const handleOpenChange = (nextIsOpen: boolean) => {
    setIsOpen(nextIsOpen);
    if (nextIsOpen) {
      setSendState({ status: "idle" });
      // Prefill the last-used address unless something is already typed
      // (read here, not at mount — the dialog body only exists when open,
      // and mount-time window access would break prerendering).
      if (recipient === "") {
        setRecipient(readLastUsedRecipient());
      }
    } else {
      // Orphan any in-flight response so it can't set state after close.
      requestIdRef.current += 1;
    }
  };

  // Agent-parity: the chat's openPanel("send-test") command opens this dialog
  // through the same reset-and-prefill path as a human click.
  useUiSurfaceOpenRequest("send-test", () => handleOpenChange(true));

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSending) {
      return;
    }
    const trimmedRecipient = recipient.trim();
    // Same validator the server module runs — bad addresses never leave the
    // dialog (the route re-validates for scripted callers).
    const isRecipientValid = z.email().safeParse(trimmedRecipient).success;
    if (!isRecipientValid) {
      setSendState({
        status: "error",
        message:
          trimmedRecipient === ""
            ? "Enter the email address to send this test to."
            : `"${trimmedRecipient}" doesn't look like a valid email address.`,
        isRecipientInvalid: true,
      });
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const isCurrent = () => requestIdRef.current === requestId;
    setSendState({ status: "sending" });
    fetch(SEND_TEST_EMAIL_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The store's doc at submit time — always the ACTIVE draft.
      body: JSON.stringify({ document: useEditorStore.getState().doc, to: trimmedRecipient }),
    })
      .then(async (response) => {
        const payload = (await response.json()) as Partial<
          SendTestEmailResponseBody & SendTestEmailErrorResponseBody
        >;
        if (!isCurrent()) {
          return;
        }
        if (!response.ok || payload.messageId === undefined) {
          setSendState({
            status: "error",
            message: payload.message ?? "The test email wasn't sent — please try again.",
            isRecipientInvalid: payload.error === "invalid_recipient",
          });
          return;
        }
        saveLastUsedRecipient(trimmedRecipient);
        setSendState({ status: "sent", recipient: payload.to ?? trimmedRecipient });
      })
      .catch(() => {
        if (isCurrent()) {
          setSendState({
            status: "error",
            message: "The test email couldn't be sent — check your connection and try again.",
            isRecipientInvalid: false,
          });
        }
      });
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {isIconTrigger ? (
        <DialogTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Send a test email"
              title="Send test email"
            />
          }
          data-testid="send-test-email-trigger"
        >
          <SendIcon className="size-4" />
        </DialogTrigger>
      ) : (
        /* Icon-only below xl (header containment discipline): the label span
           hides and the width collapses to match the icon buttons beside it. */
        <DialogTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 max-xl:w-7 max-xl:px-0"
              aria-label="Send a test email"
              title="Send test"
            />
          }
          data-testid="send-test-email-trigger"
        >
          <SendIcon className="size-3.5" />
          <span className="hidden xl:inline">Send test</span>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send a test email</DialogTitle>
          <DialogDescription>
            {activeDraftName === undefined
              ? "Send the current draft as a test email to any inbox."
              : `Send “${activeDraftName}” as a test email to any inbox.`}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="send-test-email-recipient">Send to</Label>
            <Input
              id="send-test-email-recipient"
              type="email"
              autoComplete="email"
              placeholder="name@example.com"
              value={recipient}
              disabled={isSending}
              aria-invalid={
                sendState.status === "error" && sendState.isRecipientInvalid ? true : undefined
              }
              onChange={(event) => {
                setRecipient(event.target.value);
                if (sendState.status !== "idle") {
                  setSendState({ status: "idle" });
                }
              }}
              data-testid="send-test-email-recipient"
            />
          </div>
          {sendState.status === "error" ? (
            <p className="text-sm text-destructive" role="alert" data-testid="send-test-email-error">
              {sendState.message}
            </p>
          ) : null}
          {sendState.status === "sent" ? (
            <p
              className="flex items-center gap-1.5 text-sm text-muted-foreground"
              role="status"
              data-testid="send-test-email-success"
            >
              <CheckIcon className="size-4 shrink-0" aria-hidden />
              Sent to {sendState.recipient}.
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="submit"
              disabled={isSending}
              className="gap-1.5"
              data-testid="send-test-email-submit"
            >
              {isSending ? (
                <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <SendIcon className="size-3.5" aria-hidden />
              )}
              {isSending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
