"use client";

import { useId } from "react";
import { CheckIcon, LoaderCircleIcon, PlusIcon, SendIcon, XIcon } from "lucide-react";
import { MAX_TEST_SEND_RECIPIENTS } from "@/app/api/send-test-email/contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PreSendReviewNotice } from "./PreSendReviewNotice";
import { describeSentRecipients, validateRecipients } from "./send-test-email-client";
import type { SendTestEmailControl } from "./use-send-test-email";

/**
 * The test-send control itself: subject and inbox-preview fields, one-to-five
 * recipient rows, an explicit statement of where the email is about to go, the
 * submit button, and the result.
 *
 * Shared by the frame toolbar's Send-test dialog and the HTML preview dialog's
 * footer so both read and behave identically. All state lives in the caller's
 * {@link useSendTestEmail} instance — this component only renders it.
 *
 * The destination line is not decoration. A test send leaves the building and
 * lands in someone's inbox, so where it is going is restated in prose directly
 * above the button that sends it, and it updates as the user types — the
 * addresses you are about to mail are never more than one line from the click
 * that mails them.
 */
export function SendTestEmailForm({ control }: { control: SendTestEmailControl }) {
  const baseId = useId();
  const subjectId = `${baseId}-subject`;
  const previewId = `${baseId}-preview`;
  const recipientsLabelId = `${baseId}-recipients-label`;
  const {
    recipients,
    updateRecipientAt,
    addRecipient,
    removeRecipientAt,
    canAddRecipient,
    subject,
    updateSubject,
    persistSubject,
    previewText,
    updatePreviewText,
    persistPreviewText,
    sendState,
    isSending,
    submitSend,
  } = control;

  const recipientsValidation = validateRecipients(recipients);
  const isRecipientInvalidError = sendState.status === "error" && sendState.isRecipientInvalid;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitSend();
      }}
      /*
        `noValidate` is load-bearing. The recipient fields are `type="email"`,
        so without it the browser silently refuses to fire submit for a
        malformed address and shows its own native bubble instead — our handler
        never runs, so the styled `role="alert"` message never appears and the
        field is never marked invalid. Turning the native pass off leaves
        exactly one validator (`validateRecipients`, the same rule the server
        re-runs) and one piece of copy for every bad address.
      */
      noValidate
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={subjectId}>Subject</Label>
        <Input
          id={subjectId}
          placeholder="What the recipient sees in their inbox"
          value={subject}
          disabled={isSending}
          onChange={(event) => {
            updateSubject(event.target.value);
          }}
          onBlur={persistSubject}
          data-testid="send-test-email-subject"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={previewId}>Preview text</Label>
        <Input
          id={previewId}
          placeholder="The preview line shown after the subject (optional)"
          value={previewText}
          disabled={isSending}
          onChange={(event) => {
            updatePreviewText(event.target.value);
          }}
          onBlur={persistPreviewText}
          data-testid="send-test-email-preview"
        />
      </div>

      <div className="flex flex-col gap-2" role="group" aria-labelledby={recipientsLabelId}>
        <div className="flex items-center justify-between">
          <span id={recipientsLabelId} className="text-sm font-medium">
            Send to
          </span>
          <span className="text-xs text-muted-foreground">
            {recipients.length}/{MAX_TEST_SEND_RECIPIENTS}
          </span>
        </div>
        {recipients.map((recipient, index) => (
          /*
            A recipient row has no stable id of its own; its position IS its
            identity — rows are only ever appended or removed by index.
          */
          <div key={index} className="flex items-center gap-2">
            <Input
              type="email"
              autoComplete="email"
              placeholder="name@example.com"
              aria-label={`Recipient ${index + 1}`}
              value={recipient}
              disabled={isSending}
              aria-invalid={isRecipientInvalidError ? true : undefined}
              onChange={(event) => {
                updateRecipientAt(index, event.target.value);
              }}
              data-testid={`send-test-email-recipient-${index}`}
            />
            {recipients.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove recipient ${index + 1}`}
                disabled={isSending}
                onClick={() => {
                  removeRecipientAt(index);
                }}
                data-testid={`send-test-email-remove-${index}`}
              >
                <XIcon className="size-4" aria-hidden />
              </Button>
            ) : null}
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5"
            disabled={isSending || !canAddRecipient}
            onClick={addRecipient}
            data-testid="send-test-email-add-recipient"
          >
            <PlusIcon className="size-3.5" aria-hidden />
            Add recipient
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground" data-testid="send-test-email-destination">
        {recipientsValidation.isValid ? (
          recipientsValidation.recipients.length === 1 ? (
            <>
              This sends the current draft to{" "}
              <strong className="font-medium text-foreground">
                {recipientsValidation.recipients[0]}
              </strong>
              .
            </>
          ) : (
            <>
              This sends the current draft to{" "}
              <strong className="font-medium text-foreground">
                {recipientsValidation.recipients.length} recipients
              </strong>
              .
            </>
          )
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
          {describeSentRecipients(sendState.recipients)}
        </p>
      ) : null}

      {/*
        The pre-send review. It sits ABOVE the button so it is read before
        the click rather than after it, and it gates nothing — the button
        below never consults it.
      */}
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
