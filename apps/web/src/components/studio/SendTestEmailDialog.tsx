"use client";

import { useRef, useState } from "react";
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
import { useEditorStore } from "@/lib/editor-store";
import { useUiSurfaceOpenRequest } from "@/lib/ui-surfaces";
import { useCanvasDrafts } from "./drafts/use-canvas-drafts";
import { requestEmailRender } from "./html-preview-client";
import { SendTestEmailForm } from "./SendTestEmailForm";
import { useSendTestEmail, type SendTestEmailControl } from "./use-send-test-email";

export type TestSendEmailRenderState =
  | { status: "loading"; documentId: string | null }
  | { status: "ok"; documentId: string; html: string }
  | { status: "error"; documentId: string | null; message: string };

/*
  The layout keeps the send controls and the actual output adjacent on desktop,
  while the single-column default keeps the dialog usable at narrow widths.
*/
export function TestSendEmailDialogContent({
  control,
  activeDocumentId,
  renderState,
}: {
  control: SendTestEmailControl;
  activeDocumentId: string | null;
  renderState: TestSendEmailRenderState;
}) {
  const isCurrentRender =
    renderState.status === "ok" && renderState.documentId === activeDocumentId;

  return (
    <div className="grid min-h-0 gap-5 md:grid-cols-2">
      <div className="min-w-0 overflow-y-auto pr-1">
        <SendTestEmailForm control={control} />
      </div>
      <section
        aria-label="Rendered email preview"
        className="min-h-72 overflow-hidden rounded-lg border bg-muted/30"
      >
        {isCurrentRender ? (
          <iframe
            title="Rendered test email preview"
            sandbox=""
            srcDoc={renderState.html}
            className="h-full min-h-72 w-full bg-white"
          />
        ) : renderState.status === "error" && renderState.documentId === activeDocumentId ? (
          <div className="flex min-h-72 items-center justify-center p-6 text-center text-sm text-destructive">
            {renderState.message}
          </div>
        ) : (
          <div className="flex min-h-72 items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Refreshing rendered preview…
          </div>
        )}
      </section>
    </div>
  );
}

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
  const [renderState, setRenderState] = useState<TestSendEmailRenderState>({
    status: "loading",
    documentId: null,
  });
  const renderRequestIdRef = useRef(0);
  const sendControl = useSendTestEmail();
  const { drafts, activeDocumentId, activeIndex } = useCanvasDrafts();
  const activeDraftName = activeIndex === -1 ? undefined : drafts?.[activeIndex]?.name;

  function requestRenderedPreview(): void {
    const documentId = activeDocumentId;
    const requestId = renderRequestIdRef.current + 1;
    renderRequestIdRef.current = requestId;
    setRenderState({ status: "loading", documentId });
    if (documentId === null) {
      return;
    }
    void requestEmailRender(useEditorStore.getState().doc).then((outcome) => {
      if (renderRequestIdRef.current !== requestId) {
        return;
      }
      setRenderState(
        outcome.isOk
          ? { status: "ok", documentId, html: outcome.render.html }
          : { status: "error", documentId, message: outcome.message },
      );
    });
  }

  function handleOpenChange(nextIsOpen: boolean): void {
    setIsOpen(nextIsOpen);
    if (nextIsOpen) {
      sendControl.prepareToSend();
      requestRenderedPreview();
    } else {
      renderRequestIdRef.current += 1;
      sendControl.discardInFlightSend();
    }
  }

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
      <DialogContent className="h-[min(86vh,58rem)] w-[min(96vw,72rem)] max-w-none grid-rows-[auto_1fr] overflow-hidden sm:max-w-[72rem]">
        <DialogHeader>
          <DialogTitle>Send a test email</DialogTitle>
          <DialogDescription>
            {activeDraftName === undefined
              ? "Send the current draft as a test email to any inbox."
              : `Send “${activeDraftName}” as a test email to any inbox.`}
          </DialogDescription>
        </DialogHeader>
        <TestSendEmailDialogContent
          control={sendControl}
          activeDocumentId={activeDocumentId}
          renderState={renderState}
        />
      </DialogContent>
    </Dialog>
  );
}
