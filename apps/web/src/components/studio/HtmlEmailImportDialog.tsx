"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { AlertTriangleIcon, FileUpIcon, UploadIcon } from "lucide-react";
import {
  MAX_HTML_IMPORT_BYTES,
  type HtmlEmailImportResult,
} from "@/lib/html-email-import";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ReadOnlyEmailPreview } from "./history/ReadOnlyEmailPreview";

interface HtmlImportPreviewContentProps {
  result: HtmlEmailImportResult;
  isConfirmed: boolean;
  onConfirm: () => void;
}

/*
  The conversion result is rendered as SDK blocks and sanitized HTML is kept
  in a text node. This means imported source cannot execute scripts or
  navigate the studio while a person evaluates the conversion.
*/
export function HtmlImportPreviewContent({
  result,
  isConfirmed,
  onConfirm,
}: HtmlImportPreviewContentProps) {
  return (
    <div className="grid min-h-0 gap-4 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.7fr)]">
      <section
        className="min-w-0"
        aria-labelledby="html-import-converted-title"
        data-testid="html-import-converted-email"
      >
        <h3 id="html-import-converted-title" className="mb-2 text-sm font-medium">
          Converted email
        </h3>
        <ReadOnlyEmailPreview doc={result.document} />
      </section>
      <aside className="min-w-0 space-y-4" aria-label="HTML import conversion report">
        <section className="rounded-md border bg-muted/30 p-3">
          <h3 className="text-sm font-medium">Conversion report</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {result.report.blockCount} editable blocks represented · importer v{result.report.importerVersion}
          </p>
          {result.report.warnings.length > 0 ? (
            <ul className="mt-3 space-y-2 text-xs" aria-label="Import warnings">
              {result.report.warnings.map((warning, index) => (
                <li key={`${warning.code}-${index}`} className="flex gap-2">
                  <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                  <span>{warning.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">No conversion warnings.</p>
          )}
          {result.report.unsupportedFeatures.length > 0 && (
            <div className="mt-3 border-t pt-3">
              <h4 className="text-xs font-medium">Unsupported constructs</h4>
              <p className="mt-1 text-xs text-muted-foreground">
                {result.report.unsupportedFeatures.join(", ")}
              </p>
            </div>
          )}
        </section>
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium">Sanitized source HTML</summary>
          <pre
            className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground"
            data-testid="html-import-sanitized-source"
          >
            {result.sanitizedHtml}
          </pre>
        </details>
        <div className="rounded-md border border-amber-300/70 bg-amber-50/60 p-3 text-xs text-amber-950 dark:bg-amber-950/20 dark:text-amber-100">
          Confirming records your review only. No draft or asset is created in this preview-only phase.
        </div>
        <Button type="button" className="w-full" onClick={onConfirm} disabled={isConfirmed}>
          {isConfirmed ? "Import preview confirmed" : "Confirm import preview"}
        </Button>
      </aside>
    </div>
  );
}

export function isHtmlImportFile(file: Pick<File, "name" | "type" | "size">): boolean {
  return (
    file.size <= MAX_HTML_IMPORT_BYTES &&
    (file.name.toLowerCase().endsWith(".html") || file.type === "text/html")
  );
}

export function HtmlEmailImportDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const [sourceHtml, setSourceHtml] = useState("");
  const [result, setResult] = useState<HtmlEmailImportResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPreviewPending, setIsPreviewPending] = useState(false);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const previewRequestIdRef = useRef(0);

  function reset(): void {
    setSourceHtml("");
    setResult(null);
    setErrorMessage(null);
    setIsPreviewPending(false);
    setIsConfirmed(false);
    previewRequestIdRef.current += 1;
  }

  function handleOpenChange(nextIsOpen: boolean): void {
    setIsOpen(nextIsOpen);
    if (!nextIsOpen) {
      reset();
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (file === undefined) {
      return;
    }
    if (!isHtmlImportFile(file)) {
      setErrorMessage("Choose an .html file no larger than 512 KB.");
      event.target.value = "";
      return;
    }
    setErrorMessage(null);
    try {
      setSourceHtml(await file.text());
      setResult(null);
      setIsConfirmed(false);
    } catch {
      setErrorMessage("That HTML file could not be read.");
    }
  }

  function requestPreview(): void {
    if (sourceHtml.trim().length === 0 || isPreviewPending) {
      setErrorMessage("Paste an HTML email or upload a .html file first.");
      return;
    }
    setIsPreviewPending(true);
    setErrorMessage(null);
    setIsConfirmed(false);
    const requestId = previewRequestIdRef.current + 1;
    previewRequestIdRef.current = requestId;
    void fetch("/api/html-import/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html: sourceHtml }),
    })
      .then(async (response) => {
        const payload = (await response.json()) as HtmlEmailImportResult & { message?: string };
        if (!response.ok) {
          throw new Error(payload.message ?? "The HTML could not be converted for preview.");
        }
        if (previewRequestIdRef.current !== requestId) {
          return;
        }
        setResult(payload);
      })
      .catch((error: unknown) => {
        if (previewRequestIdRef.current !== requestId) {
          return;
        }
        setResult(null);
        setErrorMessage(error instanceof Error ? error.message : "The HTML could not be converted for preview.");
      })
      .finally(() => {
        if (previewRequestIdRef.current === requestId) {
          setIsPreviewPending(false);
        }
      });
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label="Import HTML email" title="Import HTML email" />}
        data-testid="html-import-trigger"
      >
        <UploadIcon />
      </DialogTrigger>
      <DialogContent className="grid h-[88vh] w-[min(96vw,78rem)] grid-rows-[auto_minmax(0,1fr)] max-w-none sm:max-w-[78rem]">
        <DialogHeader>
          <DialogTitle>Import HTML email</DialogTitle>
          <DialogDescription>
            Paste HTML or upload a .html file to inspect a best-effort editable conversion. Nothing is saved until a future persistence step.
          </DialogDescription>
        </DialogHeader>
        {result === null ? (
          <div className="min-h-0 overflow-y-auto">
            <div className="mx-auto flex max-w-2xl flex-col gap-4">
              <label htmlFor="html-email-import-source" className="text-sm font-medium">
                Paste HTML
              </label>
              <textarea
                id="html-email-import-source"
                value={sourceHtml}
                onChange={(event) => setSourceHtml(event.target.value)}
                placeholder="<html><body>…</body></html>"
                className="min-h-64 w-full resize-y rounded-md border bg-background p-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                spellCheck={false}
                aria-describedby="html-email-import-limit"
              />
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted">
                  <FileUpIcon className="size-4" />
                  Upload .html
                  <input
                    type="file"
                    accept=".html,text/html"
                    onChange={(event) => void handleFileChange(event)}
                    className="sr-only"
                    aria-label="Upload HTML file"
                  />
                </label>
                <span id="html-email-import-limit" className="text-xs text-muted-foreground">
                  HTML only · maximum 512 KB
                </span>
              </div>
              {errorMessage !== null && <p className="text-sm text-destructive">{errorMessage}</p>}
              <Button type="button" onClick={requestPreview} disabled={isPreviewPending} className="self-start">
                {isPreviewPending ? "Converting…" : "Preview conversion"}
              </Button>
            </div>
          </div>
        ) : (
          <HtmlImportPreviewContent
            result={result}
            isConfirmed={isConfirmed}
            onConfirm={() => setIsConfirmed(true)}
          />
        )}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
