"use client";

import { EmailEditor, type EmailEditorRef } from "@react-email/editor";
import { Inspector } from "@react-email/editor/ui";
import { useRef, useState } from "react";

const initialContent = `
  <h1>Welcome to Flock</h1>
  <p>Start typing — or press "/" for blocks.</p>
`;

export function EmailEditorPanel() {
  const editorRef = useRef<EmailEditorRef>(null);
  const [exportedHtml, setExportedHtml] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    if (!editorRef.current) return;
    setIsExporting(true);
    try {
      const html = await editorRef.current.getEmailHTML();
      setExportedHtml(html);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h1 className="text-sm font-medium tracking-tight">Flock — Email Editor</h1>
        <button
          type="button"
          onClick={handleExport}
          disabled={isExporting}
          className="rounded border px-3 py-1 text-xs font-medium uppercase tracking-wide hover:bg-accent disabled:opacity-50"
        >
          {isExporting ? "Exporting…" : "Export →"}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <EmailEditor
          ref={editorRef}
          content={initialContent}
          className="min-w-0 flex-1 overflow-y-auto p-6"
        >
          <Inspector.Root className="w-72 shrink-0 overflow-y-auto border-l p-4">
            <Inspector.Breadcrumb />
            <Inspector.Document />
            <Inspector.Node />
            <Inspector.Text />
          </Inspector.Root>
        </EmailEditor>
      </div>

      {exportedHtml !== null && (
        <details open className="max-h-64 overflow-y-auto border-t p-4 text-xs">
          <summary className="cursor-pointer font-medium">
            Exported email HTML ({exportedHtml.length.toLocaleString()} chars)
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-all text-muted-foreground">
            {exportedHtml}
          </pre>
        </details>
      )}
    </div>
  );
}
