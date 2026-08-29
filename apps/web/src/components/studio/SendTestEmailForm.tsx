"use client";

import { useId } from "react";
import { CheckIcon, LoaderCircleIcon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PreSendReviewNotice } from "./PreSendReviewNotice";
import { validateRecipient } from "./send-test-email-client";
import type { SendTestEmailControl } from "./use-send-test-email";

/**
 * The test-send control itself: address field, an explicit statement of where
 * the email is about to go, the submit button, and the result.
 *
 * Shared by the frame toolbar's Send-test dialog and the HTML preview dialog's
 * footer so both read and behave identically. All state lives in the caller's
 * {@link useSendTestEmail} instance — this component only renders it.
 *
 * The destination line is not decoration. A test send leaves the building and
 * lands in someone's inbox, so the address is restated in prose directly above
 * the button that sends it, and it updates as the user types — the address you
 * are about to mail is never more than one line from the click that mails it.
 */
export function SendTestEmailForm({ control }: { control: SendTestEmailControl }) {
  const fieldId = useId();
  const { recipient, updateRecipient, sendState, isSending, submitSend } = control;
  const trimmedRecipient = recipient.trim();
  const isRecipientUsable = validateRecipient(recipient).isValid;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitSend();
      }}
      /**
       * `noValidate` is load-bearing. The field is `type="email"`, so without
       * it the browser silently refuses to fire submit for a malformed address
       * and shows its own native bubble instead — our handler never runs, so
       * the styled `role="alert"` message never appears and the field is never
       * marked invalid. Turning the native pass off leaves exactly one
       * validator (`validateRecipient`, the same rule the server re-runs) and
       * one piece of copy for every bad address.
       */
      noValidate
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={fieldId}>Send to</Label>
        <Input
          id={fieldId}
          type="email"
          autoComplete="email"
          placeholder="name@example.com"
          value={recipient}
          disabled={isSending}
          aria-invalid={
            sendState.status === "error" && sendState.isRecipientInvalid ? true : undefined
          }
          onChange={(event) => {
            updateRecipient(event.target.value);
          }}
          data-testid="send-test-email-recipient"
        />
      </div>

      <p className="text-sm text-muted-foreground" data-testid="send-test-email-destination">
        {isRecipientUsable ? (
          <>
            This sends the current draft to{" "}
            <strong className="font-medium text-foreground">{trimmedRecipient}</strong>.
          </>
        ) : (
          "Enter the inbox this test should land in."
        )}
      </p>

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

      {/* The pre-send review. It sits ABOVE the button so it is read before
          the click rather than after it, and it gates nothing — the button
          below never consults it. */}
      <PreSendReviewNotice />

      <div className="flex justify-end">
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
          {isSending ? "Sending…" : "Send test"}
        </Button>
      </div>
    </form>
  );
}
