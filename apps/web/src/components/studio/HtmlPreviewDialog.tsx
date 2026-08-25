"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, CodeIcon, CopyIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { RenderResponseBody } from "@/app/api/render/contract";
import { useEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";
import {
  copyTextToClipboard,
  DEFAULT_PREVIEW_VIEW_ID,
  PREVIEW_VIEWS,
  type PreviewViewId,
  requestEmailRender,
  selectCopyText,
} from "./html-preview-client";
import { SendTestEmailForm } from "./SendTestEmailForm";
import { useSendTestEmail } from "./use-send-test-email";

export type RenderState =
  | { status: "loading" }
  | { status: "ok"; render: RenderResponseBody }
  | { status: "error"; message: string };

/** How long the "Copied" confirmation stays up before the button resets. */
const COPY_CONFIRMATION_MS = 2000;

type CopyStatus = "idle" | "copied" | "failed";

/**
 * The "Email preview" button + dialog: renders the current document through the
 * SDK (via POST /api/render) and shows the result three ways —
 *
 *   Preview     the email as it will arrive, in a sandboxed iframe
 *   HTML        the pretty-printed source, so you can always see what HTML
 *               your email generates
 *   Plain text  the text/plain alternative a text-only client shows
 *
 * — all read-only. One request returns all three (see the route's contract), so
 * switching tabs is instant and no tab can ever show a different version of the
 * draft than its neighbour. Reads the store's doc at open time, so it always
 * exports the ACTIVE draft.
 *
 * The footer carries the SAME test-send control as the dedicated Send-test
 * dialog ({@link SendTestEmailForm} over {@link useSendTestEmail}): seeing the
 * email as it will arrive and mailing it to yourself are one gesture, so the
 * preview does not have to be closed to act on it. Both surfaces read the same
 * store doc at submit time and POST to the same route, so what gets sent is
 * what the preview above is showing.
 *
 * `isIconTrigger` renders the compact icon-only trigger used by the floating
 * per-frame toolbar (§10.2 frames UX); default is the labeled header button.
 */
export function HtmlPreviewDialog({ isIconTrigger = false }: { isIconTrigger?: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const [renderState, setRenderState] = useState<RenderState>({ status: "loading" });
  const [activeViewId, setActiveViewId] = useState<PreviewViewId>(DEFAULT_PREVIEW_VIEW_ID);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const requestIdRef = useRef(0);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendControl = useSendTestEmail();

  // The confirmation is the only thing on a timer; it must not outlive the
  // dialog (or fire into an unmounted tree) if the user closes it mid-glow.
  useEffect(() => {
    return () => {
      if (copyResetRef.current !== null) {
        clearTimeout(copyResetRef.current);
      }
    };
  }, []);

  const startRender = () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setRenderState({ status: "loading" });
    void requestEmailRender(useEditorStore.getState().doc).then((result) => {
      if (requestIdRef.current !== requestId) {
        return;
      }
      setRenderState(
        result.isOk
          ? { status: "ok", render: result.render }
          : { status: "error", message: result.message },
      );
    });
  };

  const handleOpenChange = (nextIsOpen: boolean) => {
    setIsOpen(nextIsOpen);
    if (nextIsOpen) {
      setActiveViewId(DEFAULT_PREVIEW_VIEW_ID);
      setCopyStatus("idle");
      startRender();
      sendControl.prepareToSend();
    } else {
      // Orphan both in-flight responses so neither can set state after close.
      requestIdRef.current += 1;
      sendControl.discardInFlightSend();
    }
  };

  const selectView = (viewId: PreviewViewId) => {
    setActiveViewId(viewId);
    // Each tab owns its own Copy button; a stale "Copied" on arrival would be
    // confirming something the user never did here.
    setCopyStatus("idle");
  };

  const activeView = PREVIEW_VIEWS.find((view) => view.id === activeViewId) ?? PREVIEW_VIEWS[0];
  const copyText =
    renderState.status === "ok"
      ? selectCopyText({ view: activeViewId, render: renderState.render })
      : null;

  const copyActiveView = () => {
    if (copyText === null) {
      return;
    }
    if (copyResetRef.current !== null) {
      clearTimeout(copyResetRef.current);
    }
    void copyTextToClipboard(copyText).then((isCopied) => {
      setCopyStatus(isCopied ? "copied" : "failed");
      copyResetRef.current = setTimeout(() => setCopyStatus("idle"), COPY_CONFIRMATION_MS);
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {isIconTrigger ? (
        <DialogTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Email preview" title="Preview" />
          }
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
          Preview
        </DialogTrigger>
      )}
      <DialogContent className="grid h-[85vh] grid-rows-[auto_auto_1fr_auto] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Email preview</DialogTitle>
          <DialogDescription>
            Your email as it will arrive, the HTML it generates, and the plain-text version.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-stretch gap-1 border-b">
          <div role="tablist" aria-label="Email preview" className="flex items-stretch gap-1">
            {PREVIEW_VIEWS.map((view) => (
              <button
                key={view.id}
                type="button"
                role="tab"
                aria-selected={view.id === activeViewId}
                aria-controls="html-preview-panel"
                onClick={() => selectView(view.id)}
                className={cn(
                  "cursor-pointer rounded-t-md border-b-2 px-3 py-1.5 text-sm font-medium transition-colors",
                  view.id === activeViewId
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
                data-testid={`html-preview-tab-${view.id}`}
              >
                {view.label}
              </button>
            ))}
          </div>
          {activeView.copyLabel !== null && copyText !== null ? (
            <div className="ml-auto flex items-center pb-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={copyActiveView}
                className="gap-1.5"
                data-testid="html-preview-copy"
              >
                {copyStatus === "copied" ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
                {copyStatus === "copied"
                  ? "Copied"
                  : copyStatus === "failed"
                    ? "Couldn't copy"
                    : activeView.copyLabel}
              </Button>
            </div>
          ) : null}
        </div>

        <PreviewViewPanel renderState={renderState} activeViewId={activeViewId} />

        <div className="border-t pt-4" data-testid="html-preview-send-test">
          <SendTestEmailForm control={sendControl} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The body of whichever tab is selected: the render in flight, the failure, or
 * one of the three views of a finished render.
 *
 * Split out of the dialog as a prop-driven view so it can be tested at all —
 * the app's vitest environment is `node`, so the stateful dialog above cannot
 * be mounted, but this takes the two things that decide what appears and
 * returns a tree a test can walk (the convention {@link SendTestEmailForm}'s
 * neighbours in `demo/` already follow). The branch it guards is worth pinning:
 * `prettyHtml` and `plainText` arrive in the same object, so transposing them
 * would leave every clipboard test green while the Plain text tab showed HTML.
 */
export function PreviewViewPanel({
  renderState,
  activeViewId,
}: {
  renderState: RenderState;
  activeViewId: PreviewViewId;
}) {
  return (
    <div id="html-preview-panel" role="tabpanel" className="min-h-0">
      {renderState.status === "error" ? (
        <p className="text-sm text-destructive" data-testid="html-preview-error">
          {renderState.message}
        </p>
      ) : renderState.status === "loading" ? (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <LoaderCircleIcon className="size-5 animate-spin" />
        </div>
      ) : activeViewId === "preview" ? (
        <iframe
          title="Rendered email preview"
          sandbox=""
          srcDoc={renderState.render.html}
          className="h-full w-full rounded-md border bg-white"
          data-testid="html-preview-iframe"
        />
      ) : (
        /*
          `overflow-wrap: anywhere` breaks only the lines that cannot fit —
          email HTML carries very long inline `style` attributes, and without it
          the source would push the dialog wider than the screen. The plain-text
          view shares the treatment: `whitespace-pre-wrap` keeps the blank lines
          and indentation that ARE the text version's formatting, and the box
          scrolls because a real email's text part runs well past the dialog.
        */
        <pre
          className="h-full overflow-auto rounded-md border bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]"
          data-testid={activeViewId === "html" ? "html-preview-source" : "html-preview-plain-text"}
        >
          {activeViewId === "html" ? renderState.render.prettyHtml : renderState.render.plainText}
        </pre>
      )}
    </div>
  );
}
