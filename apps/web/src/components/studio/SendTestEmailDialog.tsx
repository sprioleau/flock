"use client";

import { useState } from "react";
import { SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useUiSurfaceOpenRequest } from "@/lib/ui-surfaces";
import { useCanvasDrafts } from "./drafts/use-canvas-drafts";
import { SendTestEmailForm } from "./SendTestEmailForm";
import { useSendTestEmail } from "./use-send-test-email";

/**
 * The dedicated "Send test" button + dialog: sends the ACTIVE draft to any
 * inbox through POST /api/send-test-email — the human entry to the SAME
 * Resend machinery the chat approval flow executes (one send path; the
 * payload-hash idempotency key makes a re-click on an unchanged draft a
 * no-op replay, while any edit sends fresh).
 *
 * The identical control is embedded in the HTML preview dialog's footer, so a
 * user who is already looking at the rendered email can send it without
 * leaving the preview. Both mount {@link SendTestEmailForm} over their own
 * {@link useSendTestEmail} instance — this file is now only dialog chrome.
 */
export function SendTestEmailDialog({
  isIconTrigger = false,
}: {
  /*
    The compact icon-only trigger used by the floating per-frame toolbar
    (§10.2 frames UX — a test sends ONE draft, so the entry point rides the
    frame); default is the labeled header-style button.
  */
  isIconTrigger?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const sendControl = useSendTestEmail();
  const { drafts, activeIndex } = useCanvasDrafts();
  const activeDraftName = activeIndex === -1 ? undefined : drafts?.[activeIndex]?.name;

  const handleOpenChange = (nextIsOpen: boolean) => {
    setIsOpen(nextIsOpen);
    if (nextIsOpen) {
      sendControl.prepareToSend();
    } else {
      sendControl.discardInFlightSend();
    }
  };

  /*
    Agent-parity: the chat's openPanel("send-test") command opens this dialog
    through the same reset-and-prefill path as a human click.
  */
  useUiSurfaceOpenRequest("send-test", () => handleOpenChange(true));

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
        /*
          Icon-only below xl (header containment discipline): the label span
          hides and the width collapses to match the icon buttons beside it.
        */
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
        <SendTestEmailForm control={sendControl} />
      </DialogContent>
    </Dialog>
  );
}
