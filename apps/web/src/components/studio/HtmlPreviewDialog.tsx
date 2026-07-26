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

type RenderState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; html: string }
  | { status: "error"; message: string };

/**
 * The "HTML" toolbar button + dialog: renders the current document to
 * email-safe HTML through the SDK (via the existing POST /api/render route,
 * which runs renderToHTML server-side) and shows it in a sandboxed iframe.
 */
export function HtmlPreviewDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const [renderState, setRenderState] = useState<RenderState>({ status: "idle" });
  const requestIdRef = useRef(0);

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
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button variant="outline" size="sm" className="gap-1.5" />}>
        <CodeIcon className="size-4" />
        HTML
      </DialogTrigger>
      <DialogContent className="grid h-[85vh] grid-rows-[auto_1fr] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Email HTML</DialogTitle>
          <DialogDescription>
            renderToHTML output — previewed in a sandboxed iframe.
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
      </DialogContent>
    </Dialog>
  );
}
