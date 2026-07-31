"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useConvex, useQuery } from "convex/react";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import type { EmailDocument } from "@tandem/email-sdk";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { useEditorStore } from "@/lib/editor-store";
import { PresenceProvider } from "@/lib/presence";
import { getOrCreateSessionId } from "@/lib/session";
import { ChatPanel } from "./chat/ChatPanel";
import { CanvasDndContext } from "./dnd/CanvasDndContext";
import { DraftFramesCanvas } from "./drafts/DraftFramesCanvas";
import { DraftSelector } from "./drafts/DraftSelector";
import { HistoryPanel } from "./history/HistoryPanel";
import { PropertyPanelSlot } from "./PropertyPanelSlot";
import { StudioToolbar } from "./StudioToolbar";

/**
 * The /studio product surface: AI chat panel | toolbar + canvas | property
 * panel slot — now gated on a live Convex document.
 *
 * Document lifecycle: `/studio?doc=<id>` loads that document (the id is the
 * capability). No param → create one for this browser's anonymous session
 * (seeded with the designed starter email, "Draft 1") and replaceState the
 * URL so a reload restores
 * it. An invalid or deleted id → a clean error state with a create-new
 * action. The reactive `getDocumentByKey` subscription is THE live feed:
 * every snapshot (own ops confirming, other tabs, agent edits) flows into
 * the store, which rebases its pending local overlay on top.
 *
 * Draft ACTIVATION (§10.2 frames UX — clicking a sibling frame, the selector
 * dropdown, or a nav arrow): pushes the new ?doc= via the native history API
 * (Next syncs useSearchParams with pushState — a SHALLOW navigation, no
 * server round-trip, back/forward walks drafts), the query re-subscribes,
 * and when the new draft's first snapshot arrives the store is reset +
 * reconnected in ONE synchronous batch — the shell (chat panel, presence
 * provider) never unmounts and no loading gate flashes; the active frame
 * simply moves. "Last frame clicked" = the store-connected document = what
 * the preview toggle, HTML export, history, presence, and chat all target.
 * `isDocumentReady` only gates the INITIAL load.
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

  // The connected draft. Sourced from the store (not `snapshot`, which goes
  // undefined while a switch's new subscription loads) so presence/history/
  // the drafts bar hold the outgoing draft until the incoming one is live.
  const documentId = useEditorStore((state) => state.documentId);
  const authorId = useEditorStore((state) => state.authorId);
  const isDocumentReady = useEditorStore((state) => state.isDocumentReady);

  // Feed every snapshot into the store (connect on the first one; reset +
  // reconnect when the snapshot is a DIFFERENT draft — i.e. a tab switch).
  useEffect(() => {
    if (snapshot === undefined || snapshot === null) {
      return;
    }
    const store = useEditorStore.getState();
    if (store.documentId !== snapshot.documentId) {
      if (store.documentId !== null) {
        // Draft switch: drop the outgoing draft's pending overlay, selection,
        // and notices so nothing replays onto the incoming draft. The reset
        // and the snapshot below land in one render batch (this effect is
        // synchronous), so `isDocumentReady` never flickers false.
        store.resetDocumentState();
      }
      store.connectDocument({
        convexClient,
        documentId: snapshot.documentId,
        canvasId: snapshot.canvasId,
        authorId: getOrCreateSessionId(),
      });
    }
    store.applyServerSnapshot({
      doc: snapshot.doc as EmailDocument,
      headVersion: snapshot.headVersion,
    });
  }, [snapshot, convexClient]);

  /** Drafts-bar switch: shallow ?doc= update; the snapshot effect does the rest. */
  const switchToDraft = (nextDocumentId: Id<"documents">): void => {
    if (nextDocumentId === documentKey) {
      return;
    }
    window.history.pushState(null, "", `/studio?doc=${nextDocumentId}`);
  };

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

  // The dnd context wraps the WHOLE studio row — not just the canvas — so
  // the right rail's Blocks-tab palette tiles and the canvas blocks register
  // against ONE @dnd-kit context (palette → canvas drags need both ends).
  const studioLayout = (
    <CanvasDndContext>
      <div className="flex h-dvh w-full overflow-hidden">
        <ChatPanel />
        <main className="relative flex min-w-0 flex-1 flex-col">
          <StudioToolbar leading={<DraftSelector onActivateDraft={switchToDraft} />}>
            <HistoryPanel />
          </StudioToolbar>
          <DraftFramesCanvas onActivateDraft={switchToDraft} />
          <EditorNotice />
        </main>
        <PropertyPanelSlot />
      </div>
    </CanvasDndContext>
  );

  // Phase 6.2 presence: one room per open document (roomId = the document id).
  return documentId !== null ? (
    <PresenceProvider documentId={documentId}>{studioLayout}</PresenceProvider>
  ) : (
    studioLayout
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
