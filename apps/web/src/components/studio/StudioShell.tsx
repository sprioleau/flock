"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useConvex, useQuery } from "convex/react";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import type { EmailDocument } from "@tandem/email-sdk";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { useEditorStore } from "@/lib/editor-store";
import { getOrCreateSessionId } from "@/lib/session";
import { ChatPanel } from "./chat/ChatPanel";
import { EditorCanvas } from "./EditorCanvas";
import { HtmlPreviewDialog } from "./HtmlPreviewDialog";
import { PropertyPanelSlot } from "./PropertyPanelSlot";
import { StudioToolbar } from "./StudioToolbar";

/**
 * The /studio product surface: AI chat panel | toolbar + canvas | property
 * panel slot — now gated on a live Convex document.
 *
 * Document lifecycle: `/studio?doc=<id>` loads that document (the id is the
 * capability). No param → create one for this browser's anonymous session
 * (seeded sample, "Draft 1") and replaceState the URL so a reload restores
 * it. An invalid or deleted id → a clean error state with a create-new
 * action. The reactive `getDocumentByKey` subscription is THE live feed:
 * every snapshot (own ops confirming, other tabs, agent edits) flows into
 * the store, which rebases its pending local overlay on top.
 */
export function StudioShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedDocumentKey = searchParams.get("doc");
  const convexClient = useConvex();

  const [createdDocumentKey, setCreatedDocumentKey] = useState<string | null>(null);
  const [hasCreateFailed, setHasCreateFailed] = useState(false);
  const [createAttempt, setCreateAttempt] = useState(0);
  const isCreateRequestedRef = useRef(false);
  const documentKey = requestedDocumentKey ?? createdDocumentKey;

  // No ?doc= param → create a fresh seeded draft once, then adopt its id.
  useEffect(() => {
    if (documentKey !== null || isCreateRequestedRef.current) {
      return;
    }
    isCreateRequestedRef.current = true;
    convexClient
      .mutation(api.documents.createDocument, {
        sessionId: getOrCreateSessionId(),
        name: "Draft 1",
        shouldSeedSample: true,
      })
      .then(({ documentId }) => {
        window.history.replaceState(null, "", `/studio?doc=${documentId}`);
        setCreatedDocumentKey(documentId);
      })
      .catch((error: unknown) => {
        console.error("createDocument failed", error);
        setHasCreateFailed(true);
      });
  }, [documentKey, convexClient, createAttempt]);

  /** The gate's "create new" escape hatch: detach and start a fresh draft. */
  const startNewDraft = (): void => {
    useEditorStore.getState().resetDocumentState();
    isCreateRequestedRef.current = false;
    setHasCreateFailed(false);
    setCreatedDocumentKey(null);
    setCreateAttempt((attempt) => attempt + 1);
    router.push("/studio");
  };

  // The live document feed. undefined = loading, null = invalid/missing id.
  const snapshot = useQuery(
    api.documents.getDocumentByKey,
    documentKey !== null ? { documentKey } : "skip",
  );

  const documentId = snapshot?.documentId ?? null;
  const authorId = useEditorStore((state) => state.authorId);
  const isDocumentReady = useEditorStore((state) => state.isDocumentReady);

  // Feed every snapshot into the store (connect on the first one).
  useEffect(() => {
    if (snapshot === undefined || snapshot === null) {
      return;
    }
    const store = useEditorStore.getState();
    if (store.documentId !== snapshot.documentId) {
      store.connectDocument({
        convexClient,
        documentId: snapshot.documentId,
        authorId: getOrCreateSessionId(),
      });
    }
    store.applyServerSnapshot({
      doc: snapshot.doc as EmailDocument,
      headVersion: snapshot.headVersion,
    });
  }, [snapshot, convexClient]);

  // Reactive undo/redo enablement for THIS author, fed into the store.
  const historyAvailability = useQuery(
    api.history.canUndoRedo,
    documentId !== null && authorId !== null ? { documentId, authorId } : "skip",
  );
  useEffect(() => {
    if (historyAvailability !== undefined) {
      useEditorStore.getState().setHistoryAvailability(historyAvailability);
    }
  }, [historyAvailability]);

  if (hasCreateFailed || snapshot === null) {
    return (
      <StudioGateScreen>
        <TriangleAlertIcon className="size-8 text-destructive" />
        <div>
          <p className="text-sm font-medium">
            {snapshot === null ? "This document doesn't exist" : "Couldn't create a document"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {snapshot === null
              ? "The link may be wrong, or the draft was deleted."
              : "Check your connection and try again."}
          </p>
        </div>
        <Button size="sm" onClick={startNewDraft}>
          Create a new draft
        </Button>
      </StudioGateScreen>
    );
  }

  if (!isDocumentReady) {
    return (
      <StudioGateScreen>
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
        <p className="text-xs text-muted-foreground">Loading your draft…</p>
      </StudioGateScreen>
    );
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <ChatPanel />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <StudioToolbar>
          <HtmlPreviewDialog />
        </StudioToolbar>
        <EditorCanvas />
        <EditorNotice />
      </main>
      <PropertyPanelSlot />
    </div>
  );
}

/** Centered full-viewport frame for the loading / error gate states. */
function StudioGateScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center gap-3 text-center">
      {children}
    </div>
  );
}

/** Transient store notice (undo/redo conflicts, rolled-back saves). */
function EditorNotice() {
  const notice = useEditorStore((state) => state.notice);
  const dismissNotice = useEditorStore((state) => state.dismissNotice);
  if (notice === null) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={dismissNotice}
      className="absolute bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-xs shadow-md"
      data-testid="editor-notice"
    >
      {notice}
    </button>
  );
}
