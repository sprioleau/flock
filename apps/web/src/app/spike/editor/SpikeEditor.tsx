"use client";

import { EmailEditor, type EmailEditorRef } from "@react-email/editor";
import { StarterKit } from "@react-email/editor/extensions";
import { EmailTheming } from "@react-email/editor/plugins";
import { BubbleMenu } from "@react-email/editor/ui";
import "@react-email/editor/themes/default.css";
import type { JSONContent } from "@tiptap/core";
import { EditorProvider } from "@tiptap/react";
import { useRef, useState } from "react";
import { CalloutNode } from "./callout-node";

/**
 * Spike A — what role can `@react-email/editor` play inside the hybrid model?
 *
 * Probes:
 * 1. Render `<EmailEditor />` with the default theme CSS.
 * 2. JSON document access: read (getJSON) and replace (commands.setContent).
 * 3. External transactions: drive edits from outside the editor chrome —
 *    both a raw ProseMirror transaction and a Tiptap command chain.
 * 4. Extension API: custom `EmailNode` (callout) round-trips through
 *    insert → serialize → renderToReactEmail export.
 * 5. Separability: mount a text-only editing surface (StarterKit with all
 *    structural nodes disabled) inside our own "canvas" chrome.
 */

// Probe 4: `extensions` fully replaces EmailEditor's defaults, so we
// recompose its own stack (StarterKit + EmailTheming) plus our custom node.
const fullEditorExtensions = [
  StarterKit.configure(),
  EmailTheming.configure({ theme: "basic" }),
  CalloutNode,
];

// Probe 5: the same StarterKit reduced to a per-text-block schema — every
// structural/email-chrome node disabled, inline marks + paragraph/heading kept.
const textBlockExtensions = [
  StarterKit.configure({
    Body: false,
    Container: false,
    Div: false,
    Section: false,
    TwoColumns: false,
    ThreeColumns: false,
    FourColumns: false,
    ColumnsColumn: false,
    Table: false,
    TableRow: false,
    TableCell: false,
    TableHeader: false,
    Button: false,
    Divider: false,
    CodeBlockPrism: false,
    PreviewText: false,
    GlobalContent: false,
    MaxNesting: false,
    TrailingNode: false,
  }),
];

const REPLACEMENT_DOC: JSONContent = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Replaced from outside" }],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "This entire document was set programmatically via commands.setContent(json).",
        },
      ],
    },
  ],
};

const INITIAL_CONTENT = `
  <h1>Spike A canvas</h1>
  <p>This is the full <strong>EmailEditor</strong> with a custom callout EmailNode registered.</p>
`;

interface ProbeResult {
  label: string;
  isSuccess: boolean;
  detail: string;
}

export function SpikeEditor() {
  const editorRef = useRef<EmailEditorRef>(null);
  const [docJson, setDocJson] = useState<JSONContent | null>(null);
  const [exportedHtml, setExportedHtml] = useState<string | null>(null);
  const [textBlockJson, setTextBlockJson] = useState<JSONContent | null>(null);
  const [probeResults, setProbeResults] = useState<ProbeResult[]>([]);

  const logProbe = (label: string, isSuccess: boolean, detail: string) => {
    setProbeResults((previousResults) => [
      ...previousResults,
      { label, isSuccess, detail },
    ]);
  };

  // Probe 2a — read the document as Tiptap JSON.
  const handleDumpJson = () => {
    const ref = editorRef.current;
    if (!ref) return;
    const json = ref.getJSON();
    setDocJson(json);
    logProbe(
      "getJSON",
      Boolean(json.type === "doc"),
      `top-level nodes: ${json.content?.length ?? 0}`,
    );
  };

  // Probe 2b — replace the document programmatically.
  const handleReplaceDoc = () => {
    const editor = editorRef.current?.editor;
    if (!editor) return;
    const isReplaced = editor.commands.setContent(REPLACEMENT_DOC);
    logProbe(
      "setContent(json)",
      isReplaced,
      isReplaced ? "document replaced from JSON" : "setContent returned false",
    );
  };

  // Probe 3a — external edit via a RAW ProseMirror transaction (no Tiptap
  // command sugar): dispatch directly against editor.view.
  const handleInsertTextExternally = () => {
    const editor = editorRef.current?.editor;
    if (!editor) return;
    const { state, view } = editor;
    let insertPos: number | null = null;
    state.doc.descendants((node, pos) => {
      if (insertPos === null && node.isTextblock) {
        insertPos = pos + 1;
        return false;
      }
      return insertPos === null;
    });
    if (insertPos === null) {
      logProbe("raw PM transaction", false, "no textblock found");
      return;
    }
    view.dispatch(state.tr.insertText("[external] ", insertPos));
    logProbe(
      "raw PM transaction",
      true,
      `state.tr.insertText dispatched at pos ${insertPos}`,
    );
  };

  // Probe 3b — external edit via a Tiptap command chain: select the first
  // textblock and toggle bold, all without touching the editor UI.
  const handleToggleBoldExternally = () => {
    const editor = editorRef.current?.editor;
    if (!editor) return;
    let from: number | null = null;
    let to: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (from === null && node.isTextblock) {
        from = pos + 1;
        to = pos + node.nodeSize - 1;
        return false;
      }
      return from === null;
    });
    if (from === null || to === null) {
      logProbe("chained toggleBold", false, "no textblock found");
      return;
    }
    const isApplied = editor
      .chain()
      .setTextSelection({ from, to })
      .toggleBold()
      .run();
    logProbe(
      "chained toggleBold",
      isApplied,
      isApplied ? `bold toggled on range ${from}-${to}` : "command failed",
    );
  };

  // Probe 4a — insert the custom EmailNode block programmatically.
  const handleInsertCallout = () => {
    const editor = editorRef.current?.editor;
    if (!editor) return;
    const isInserted = editor
      .chain()
      .insertContentAt(editor.state.doc.content.size, {
        type: "callout",
        content: [
          {
            type: "text",
            text: "Custom EmailNode callout — inserted programmatically.",
          },
        ],
      })
      .run();
    logProbe(
      "insert custom EmailNode",
      isInserted,
      isInserted ? "callout node inserted" : "insertContentAt failed",
    );
  };

  // Probe 4b — export through composeReactEmail and verify the callout's
  // renderToReactEmail output made it into the email HTML.
  const handleExportHtml = async () => {
    const ref = editorRef.current;
    if (!ref) return;
    const html = await ref.getEmailHTML();
    setExportedHtml(html);
    const hasCalloutInExport = html.includes("data-callout");
    logProbe(
      "renderToReactEmail round-trip",
      hasCalloutInExport,
      hasCalloutInExport
        ? "exported HTML contains the custom callout markup"
        : "callout markup missing from export (insert a callout first)",
    );
  };

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Spike A — Resend editor role
        </h1>
        <p className="text-sm text-neutral-500">
          Probing @react-email/editor: JSON access, external transactions,
          custom EmailNode round-trip, and text-block separability.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">1 · Full EmailEditor canvas</h2>
        <div className="rounded-lg border border-neutral-200 p-4">
          <EmailEditor
            ref={editorRef}
            content={INITIAL_CONTENT}
            extensions={fullEditorExtensions}
            onUpdate={(ref) => setDocJson(ref.getJSON())}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="dump-json"
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
            onClick={handleDumpJson}
          >
            Dump doc JSON
          </button>
          <button
            type="button"
            data-testid="replace-doc"
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
            onClick={handleReplaceDoc}
          >
            Replace doc from JSON
          </button>
          <button
            type="button"
            data-testid="insert-text-externally"
            className="rounded bg-blue-700 px-3 py-1.5 text-sm text-white"
            onClick={handleInsertTextExternally}
          >
            Insert text (raw PM transaction)
          </button>
          <button
            type="button"
            data-testid="toggle-bold-externally"
            className="rounded bg-blue-700 px-3 py-1.5 text-sm text-white"
            onClick={handleToggleBoldExternally}
          >
            Toggle bold (command chain)
          </button>
          <button
            type="button"
            data-testid="insert-callout"
            className="rounded bg-amber-600 px-3 py-1.5 text-sm text-white"
            onClick={handleInsertCallout}
          >
            Insert custom callout
          </button>
          <button
            type="button"
            data-testid="export-html"
            className="rounded bg-emerald-700 px-3 py-1.5 text-sm text-white"
            onClick={handleExportHtml}
          >
            Export email HTML
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">
          2 · Text-block-only surface (our canvas, its text core)
        </h2>
        <p className="text-sm text-neutral-500">
          Same StarterKit with every structural node disabled — the shape of a
          per-text-block editor mounted inside our own canvas.
        </p>
        <div
          data-testid="text-block-surface"
          className="rounded-lg border-2 border-dashed border-violet-300 bg-violet-50/50 p-4"
        >
          <EditorProvider
            extensions={textBlockExtensions}
            content="<p>A tiny per-block doc. Select text to get the bubble menu.</p>"
            immediatelyRender={false}
            onUpdate={({ editor }) => setTextBlockJson(editor.getJSON())}
          >
            <BubbleMenu />
          </EditorProvider>
        </div>
        {textBlockJson ? (
          <pre
            data-testid="text-block-json"
            className="max-h-48 overflow-auto rounded bg-neutral-950 p-3 text-xs text-violet-200"
          >
            {JSON.stringify(textBlockJson, null, 2)}
          </pre>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Probe log</h2>
        <ul data-testid="probe-log" className="flex flex-col gap-1 text-sm">
          {probeResults.map((result, index) => (
            <li key={index} data-probe-success={result.isSuccess}>
              <span
                className={
                  result.isSuccess ? "text-emerald-700" : "text-red-700"
                }
              >
                {result.isSuccess ? "PASS" : "FAIL"}
              </span>{" "}
              <strong>{result.label}</strong> — {result.detail}
            </li>
          ))}
        </ul>
      </section>

      {docJson ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-medium">Canvas doc JSON</h2>
          <pre
            data-testid="doc-json"
            className="max-h-64 overflow-auto rounded bg-neutral-950 p-3 text-xs text-emerald-200"
          >
            {JSON.stringify(docJson, null, 2)}
          </pre>
        </section>
      ) : null}

      {exportedHtml ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-medium">Exported email HTML</h2>
          <iframe
            title="Exported email preview"
            className="h-64 w-full rounded border border-neutral-200 bg-white"
            srcDoc={exportedHtml}
          />
          <details>
            <summary className="cursor-pointer text-sm text-neutral-500">
              Raw HTML
            </summary>
            <pre
              data-testid="exported-html"
              className="max-h-64 overflow-auto rounded bg-neutral-950 p-3 text-xs text-amber-100"
            >
              {exportedHtml}
            </pre>
          </details>
        </section>
      ) : null}
    </main>
  );
}
