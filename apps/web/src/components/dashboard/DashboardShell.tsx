"use client";

import { api } from "@convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { PlusIcon, SparklesIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { STUDIO_PATH } from "@/lib/auth/config";
import { UserButton } from "@/lib/auth/UserButton";
import { useFlockAuth } from "@/lib/auth/use-flock-auth";
import { getOrCreateSessionId } from "@/lib/session";
import { CanvasCard, type CanvasCardEntry } from "./CanvasCard";

/**
 * The dashboard: everything a signed-in person has made, and the way back into
 * any of it.
 *
 * This is the app's front door — before it existed the only route was
 * `/studio`, and work you did not bookmark was work you could not find again.
 * So the page is judged on one thing: does a returning user see their own
 * emails immediately, and can they get back into one in a single click.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never gates anything. The list is a
 * convenience index over `canvasOwners` (convex/canvases.ts) — share links
 * keep working for people who are not signed in and never appear here, because
 * ownership answers "whose list is this" and not "who may open it".
 */
export function DashboardShell() {
  const { credits, identity, isEnabled } = useFlockAuth();

  // Read once and lazily: this component also renders on the server, where
  // there is no localStorage. The value is only the PRE-AUTH fallback key —
  // a verified identity always wins server-side (convex/authIdentity.ts) — so
  // sending it is safe and it is what keeps the page working with auth off.
  const [sessionId] = useState(() =>
    typeof window === "undefined" ? "" : getOrCreateSessionId(),
  );
  const canvases = useQuery(api.canvases.listMyCanvases, { sessionId });

  const renameCanvas = useMutation(api.canvases.renameCanvas);
  const deleteCanvas = useMutation(api.canvases.deleteCanvas);

  const [renameTarget, setRenameTarget] = useState<CanvasCardEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<CanvasCardEntry | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // One clock for every card on a render, rather than each formatting call
  // reading a slightly different `Date.now()`.
  const [nowMs] = useState(() => Date.now());

  const handleRenameRequested = useCallback((entry: CanvasCardEntry) => {
    setActionError(null);
    setRenameTarget(entry);
    // Seed with the CURRENT display name, including a derived one: the user is
    // being asked to confirm or adjust what they already see, not to invent a
    // name from an empty box.
    setRenameValue(entry.title);
  }, []);

  const handleDeleteRequested = useCallback((entry: CanvasCardEntry) => {
    setActionError(null);
    setDeleteTarget(entry);
  }, []);

  const handleRenameSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const entry = renameTarget;
      if (entry === null) {
        return;
      }
      const title = renameValue.trim();
      if (title.length === 0) {
        setActionError("Give it a name first.");
        return;
      }
      // Close immediately and let the reactive query repaint the card. The
      // mutation is optimistic from the user's point of view (standing law:
      // instant feedback); a failure re-opens the problem as a message rather
      // than blocking the whole page behind a spinner.
      setRenameTarget(null);
      void renameCanvas({ canvasId: entry.canvasId, title, sessionId }).catch(() => {
        setActionError("We couldn't rename that just now. Try again.");
      });
    },
    [renameCanvas, renameTarget, renameValue, sessionId],
  );

  const handleDeleteConfirmed = useCallback(() => {
    const entry = deleteTarget;
    if (entry === null) {
      return;
    }
    setDeleteTarget(null);
    void deleteCanvas({ canvasId: entry.canvasId, sessionId }).catch(() => {
      setActionError("We couldn't delete that just now. Try again.");
    });
  }, [deleteCanvas, deleteTarget, sessionId]);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Your emails</h1>
          <p className="text-sm text-muted-foreground">
            {identity !== null && identity !== undefined && !identity.isAnonymous
              ? "Everything you've made, on every device you sign in from."
              : "Everything you've made in this browser."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <UserButton />
          {/* nativeButton={false}: this renders an <a>, not a <button>. Base UI
              warns otherwise, and in a production build that warning throws. */}
          <Button nativeButton={false} render={<Link href={STUDIO_PATH} />}>
            <PlusIcon />
            New email
          </Button>
        </div>
      </header>

      {actionError !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {canvases === undefined ? (
        <LoadingGrid />
      ) : canvases.length === 0 ? (
        <EmptyState credits={credits} isAuthEnabled={isEnabled} />
      ) : (
        <div
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="canvas-grid"
        >
          {canvases.map((entry) => (
            <CanvasCard
              key={entry.canvasId}
              entry={entry}
              nowMs={nowMs}
              onRename={handleRenameRequested}
              onDelete={handleDeleteRequested}
            />
          ))}
        </div>
      )}

      {/*
       * `open` is derived from the target rather than tracked separately, so
       * there is no state pair that can disagree about whether a dialog is up.
       */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setRenameTarget(null);
          }
        }}
      >
        <DialogContent>
          <form className="flex flex-col gap-4" onSubmit={handleRenameSubmit}>
            <DialogHeader>
              <DialogTitle>Rename email</DialogTitle>
              <DialogDescription>
                This is the name you&rsquo;ll see here. It doesn&rsquo;t change the
                drafts inside.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="canvas-rename-input">Name</Label>
              <Input
                id="canvas-rename-input"
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                autoFocus
                data-testid="canvas-rename-input"
              />
            </div>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancel
              </DialogClose>
              <Button type="submit">Save name</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setDeleteTarget(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this email?</DialogTitle>
            <DialogDescription>
              {/*
               * Name the cost precisely — how many drafts, and that shared
               * links die with it. "Are you sure?" is not information.
               */}
              &ldquo;{deleteTarget?.title}&rdquo; and its{" "}
              {deleteTarget?.draftCount === 1
                ? "draft"
                : `${deleteTarget?.draftCount ?? 0} drafts`}{" "}
              will be permanently deleted, and any link you shared will stop
              working. This can&rsquo;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDeleteConfirmed}
              data-testid="canvas-delete-confirm"
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Skeleton cards while the list resolves. Same shape and count as a small real
 * grid so the page does not jump when the data lands.
 */
function LoadingGrid() {
  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      aria-busy="true"
      aria-label="Loading your emails"
    >
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="h-32 animate-pulse rounded-xl border border-border bg-muted/40"
        />
      ))}
    </div>
  );
}

/**
 * The first thing a brand-new account ever sees.
 *
 * A blank page with a "New email" button would be a dead end dressed as a
 * dashboard, so this states what the product does, gives one unmistakable way
 * in, and — because the allowance is real and low (convex/authCredits.ts) —
 * says up front how much AI work today's balance covers. Finding that out by
 * hitting a wall mid-draft is the worse version of the same information.
 */
function EmptyState({
  credits,
  isAuthEnabled,
}: {
  credits: ReturnType<typeof useFlockAuth>["credits"];
  isAuthEnabled: boolean;
}) {
  return (
    <div
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-border px-6 py-16 text-center"
      data-testid="dashboard-empty-state"
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <SparklesIcon className="size-5" aria-hidden="true" />
      </div>
      <div className="flex max-w-sm flex-col gap-1.5">
        <h2 className="text-base font-semibold">Nothing here yet</h2>
        <p className="text-sm text-muted-foreground">
          Describe the email you want and Flock builds it — then you edit it on
          the canvas like a document. Everything you make shows up here.
        </p>
      </div>
      {/* See the header button: an <a> render target needs nativeButton={false}. */}
      <Button nativeButton={false} render={<Link href={STUDIO_PATH} />}>
        <PlusIcon />
        Write your first email
      </Button>
      {isAuthEnabled && credits !== undefined ? (
        <p className="text-xs text-muted-foreground">
          {credits.remaining} of {credits.limit} AI requests left today
          {credits.isClaimedTier ? "." : " — saving your work to an email raises this."}
        </p>
      ) : null}
    </div>
  );
}
