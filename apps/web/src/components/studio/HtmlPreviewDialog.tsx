"use client";

import { useRef, useState } from "react";
import { CodeIcon, LoaderCircleIcon } from "lucide-react";
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
import { SendTestEmailForm } from "./SendTestEmailForm";
import { useSendTestEmail } from "./use-send-test-email";

type RenderState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; html: string }
  | { status: "error"; message: string };

/**
 * The "HTML" button + dialog: renders the current document to email-safe
 * HTML through the SDK (via the existing POST /api/render route, which runs
 * renderToHTML server-side) and shows it in a sandboxed iframe. Reads the
 * store's doc at open time, so it always exports the ACTIVE draft.
 *
 * The footer carries the SAME test-send control as the dedicated Send-test
 * dialog ({@link SendTestEmailForm} over {@link useSendTestEmail}): seeing the
 * email as it will arrive and mailing it to yourself are one gesture, so the
 * preview does not have to be closed to act on it. Both surfaces read the same
 * store doc at submit time and POST to the same route, so what gets sent is
 * what the iframe above is showing.
 *
 * `isIconTrigger` renders the compact icon-only trigger used by the floating
 * per-frame toolbar (§10.2 frames UX); default is the labeled header button.
 */
export function HtmlPreviewDialog({ isIconTrigger = false }: { isIconTrigger?: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const [renderState, setRenderState] = useState<RenderState>({ status: "idle" });
  const requestIdRef = useRef(0);
  const sendControl = useSendTestEmail();

  const startRender = () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const isCurrent = () => requestIdRef.current === requestId;
    setRenderState({ status: "loading" });
    fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document: useEditorStore.getState().doc }),
    })
      .then(async (response) => {
        const payload = (await response.json()) as { html?: string; error?: string };
        if (!isCurrent()) {
          return;
        }
        if (!response.ok || payload.html === undefined) {
          setRenderState({ status: "error", message: payload.error ?? "Render failed." });
          return;
        }
        setRenderState({ status: "ok", html: payload.html });
      })
      .catch((error: unknown) => {
        if (isCurrent()) {
          setRenderState({ status: "error", message: String(error) });
        }
      });
  };

  const handleOpenChange = (nextIsOpen: boolean) => {
    setIsOpen(nextIsOpen);
    if (nextIsOpen) {
      startRender();
      sendControl.prepareToSend();
    } else {
      // Orphan both in-flight responses so neither can set state after close.
      requestIdRef.current += 1;
      sendControl.discardInFlightSend();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {isIconTrigger ? (
        <DialogTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label="Email HTML" title="HTML" />}
          data-testid="html-preview-trigger"
        >
          <CodeIcon className="size-4" />
        </DialogTrigger>
      ) : (
        <DialogTrigger
          render={<Button variant="outline" size="sm" className="gap-1.5" />}
          data-testid="html-preview-trigger"
        >
          <CodeIcon className="size-4" />
          HTML
        </DialogTrigger>
      )}
      <DialogContent className="grid h-[85vh] grid-rows-[auto_1fr_auto] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Email HTML</DialogTitle>
          <DialogDescription>
            The email as it will be sent — a safe preview of the exported HTML.
          </DialogDescription>
        </DialogHeader>
        {renderState.status === "ok" ? (
          <iframe
            title="Rendered email HTML preview"
            sandbox=""
            srcDoc={renderState.html}
            className="h-full w-full rounded-md border bg-white"
            data-testid="html-preview-iframe"
          />
        ) : renderState.status === "error" ? (
          <p className="text-sm text-destructive">{renderState.message}</p>
        ) : (
          <div className="flex items-center justify-center text-muted-foreground">
            <LoaderCircleIcon className="size-5 animate-spin" />
          </div>
        )}
        <div className="border-t pt-4" data-testid="html-preview-send-test">
          <SendTestEmailForm control={sendControl} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
