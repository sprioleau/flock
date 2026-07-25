"use client";

import { useTiptapSync } from "@convex-dev/prosemirror-sync/tiptap";
import { EditorContent, EditorProvider } from "@tiptap/react";
import { useMutation } from "convex/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "@convex/_generated/api";
import { editorExtensions } from "@/lib/editorSchema";

const DEFAULT_DOC_ID = "spike-doc";

const INITIAL_CONTENT = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Type here in two tabs. Clicking the button bolds every bold word.",
        },
      ],
    },
  ],
};

function SyncSpike() {
  const searchParams = useSearchParams();
  const docId = searchParams.get("doc") ?? DEFAULT_DOC_ID;

  const sync = useTiptapSync(api.prosemirror, docId);
  const boldWord = useMutation(api.prosemirror.boldWord);
  const [isTransforming, setIsTransforming] = useState(false);

  const handleBoldClick = async () => {
    setIsTransforming(true);
    try {
      await boldWord({ id: docId });
    } finally {
      setIsTransforming(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">
          Spike B: prosemirror-sync
        </h1>
        <p className="text-sm text-neutral-500">
          Document ID: <code className="font-mono">{docId}</code> — open this
          page in a second tab to watch keystrokes sync.
        </p>
      </header>

      {sync.isLoading ? (
        <p className="text-neutral-500">Loading document…</p>
      ) : sync.initialContent !== null ? (
        <>
          <div className="rounded-lg border-2 border-neutral-400 bg-white p-4 text-neutral-900 shadow-sm [&_.tiptap]:min-h-40 [&_.tiptap]:outline-none">
            <EditorProvider
              content={sync.initialContent}
              extensions={[...editorExtensions, sync.extension]}
            >
              <EditorContent editor={null} />
            </EditorProvider>
          </div>
          <button
            type="button"
            onClick={handleBoldClick}
            disabled={isTransforming}
            className="self-start rounded-md bg-sky-600 px-4 py-2 font-medium text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {isTransforming
              ? "Transforming…"
              : "Server transform: bold the word “bold”"}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => sync.create?.(INITIAL_CONTENT)}
          className="self-start rounded-md bg-sky-600 px-4 py-2 font-medium text-white hover:bg-sky-700"
        >
          Create document
        </button>
      )}
    </main>
  );
}

export default function SyncSpikePage() {
  return (
    <Suspense fallback={<p className="p-6 text-neutral-500">Loading…</p>}>
      <SyncSpike />
    </Suspense>
  );
}
