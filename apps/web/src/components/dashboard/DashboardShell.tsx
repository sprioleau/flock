"use client";

import { api } from "@convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { LogInIcon, PaletteIcon, PlusIcon, SparklesIcon } from "lucide-react";
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
import { BRAND_PATH, LOGIN_PATH, STUDIO_PATH } from "@/lib/auth/config";
import { UserButton } from "@/lib/auth/UserButton";
import { useFlockAuth } from "@/lib/auth/use-flock-auth";
import { getOrCreateSessionId } from "@/lib/session";
import { CanvasCard, type CanvasCardEntry } from "./CanvasCard";
import {
  resolveDashboardAttribution,
  resolveDashboardListState,
  type DashboardAttribution,
} from "./dashboard-attribution";

/*
  The dashboard: everything a signed-in person has made, and the way back into
  any of it.

  This is the app's front door — before it existed the only route was
  `/studio`, and work you did not bookmark was work you could not find again.
  So the page is judged on one thing: does a returning user see their own
  emails immediately, and can they get back into one in a single click.

  WHAT IT DELIBERATELY DOES NOT DO. It never gates anything. The list is a
  convenience index over `canvasOwners` (convex/canvases.ts) — share links
  keep working for people who are not signed in and never appear here, because
  ownership answers "whose list is this" and not "who may open it".

  That non-gating stance is exactly why the page has to be careful with its
  WORDS. A visitor the server cannot attribute anything to still gets in, still
  gets the full page, and still gets an empty list — so the copy is the only
  thing that can tell them the list is empty because nobody is named, not
  because they have made nothing. See ./dashboard-attribution.ts.
*/
export function DashboardShell() {
  const { credits, identity, isEnabled, isSessionPending } = useFlockAuth();
  const attribution = resolveDashboardAttribution({
    isAuthEnabled: isEnabled,
    isAuthSessionPending: isSessionPending,
    identity,
    credits,
  });

  /*
    Read once and lazily: this component also renders on the server, where
    there is no localStorage. The value is only the PRE-AUTH fallback key —
    a verified identity always wins server-side (convex/authIdentity.ts) — so
    sending it is safe and it is what keeps the page working with auth off.
  */
  const [sessionId] = useState(() =>
    typeof window === "undefined" ? "" : getOrCreateSessionId(),
  );
  const canvases = useQuery(
    api.canvases.listMyCanvases,
    attribution === "resolving" ? "skip" : { sessionId },
  );
  const dashboardListState = resolveDashboardListState({ attribution, canvases });

  const renameCanvas = useMutation(api.canvases.renameCanvas);
  const deleteCanvas = useMutation(api.canvases.deleteCanvas);

  const [renameTarget, setRenameTarget] = useState<CanvasCardEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<CanvasCardEntry | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  /*
    One clock for every card on a render, rather than each formatting call
    reading a slightly different `Date.now()`.
  */
  const [nowMs] = useState(() => Date.now());

  const handleRenameRequested = useCallback((entry: CanvasCardEntry) => {
    setActionError(null);
    setRenameTarget(entry);
    /*
      Seed with the CURRENT display name, including a derived one: the user is
      being asked to confirm or adjust what they already see, not to invent a
      name from an empty box.
    */
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
      /*
        Close immediately and let the reactive query repaint the card. The
        mutation is optimistic from the user's point of view (standing law:
        instant feedback); a failure re-opens the problem as a message rather
        than blocking the whole page behind a spinner.
      */
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
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Your emails</h1>
          <p className="text-sm text-muted-foreground">
            {/*
              "…in this browser" is a PROMISE about where the list comes from,
              and it is false for a caller the server cannot name: nothing in
              this browser is being read on their behalf. Say what is actually
              true instead.
            */}
            {attribution === "unattributed"
              ? "Sign in and the emails saved to your account show up here."
              : identity !== null && identity !== undefined && !identity.isAnonymous
                ? "Everything you've made, on every device you sign in from."
                : "Everything you've made in this browser."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/*
            UserButton renders nothing without an identity, so a signed-out
            visitor who reached this URL directly (a bookmark, a link) would
            otherwise have no way in from the page that is telling them to
            sign in. This is an offer, never a gate — "New email" stays right
            next to it and still works.
          */}
          {attribution === "unattributed" ? (
            <Button variant="outline" nativeButton={false} render={<Link href={LOGIN_PATH} />}>
              Sign in
            </Button>
          ) : (
            <UserButton />
          )}
          {/*
            nativeButton={false}: this renders an <a>, not a <button>. Base UI
            warns otherwise, and in a production build that warning throws.
          */}
          <Button variant="outline" nativeButton={false} render={<Link href={BRAND_PATH} />}>
            <PaletteIcon />
            Brand
          </Button>
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

      {/*
        An empty list is held on the skeleton until we know WHY it is empty.
        The two empty states say opposite things ("you've made nothing" vs
        "we can't tell whose this is"), so flashing one and replacing it with
        the other reads as a glitch. A non-empty list needs no such wait: rows
        coming back is itself proof the server named an owner.
      */}
      {dashboardListState === "loading" ? (
        <LoadingGrid />
      ) : dashboardListState === "empty" ? (
        <EmptyState credits={credits} isAuthEnabled={isEnabled} attribution={attribution} />
      ) : (
        <div
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="canvas-grid"
        >
          {(canvases ?? []).map((entry) => (
            <CanvasCard
              key={entry.canvasId}
              entry={entry}
              nowMs={nowMs}
              onRename={handleRenameRequested}
              onDelete={handleDeleteRequested}
              sessionId={sessionId}
            />
          ))}
        </div>
      )}

      {/*
        `open` is derived from the target rather than tracked separately, so
        there is no state pair that can disagree about whether a dialog is up.
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
                Name the cost precisely — how many drafts, and that shared
                links die with it. "Are you sure?" is not information.
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
    </main>
  );
}

/*
  Skeleton cards while the list resolves. Same shape and count as a small real
  grid so the page does not jump when the data lands.
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

/*
  The first thing a brand-new account ever sees.

  A blank page with a "New email" button would be a dead end dressed as a
  dashboard, so this states what the product does, gives one unmistakable way
  in, and — because the allowance is real and low (convex/authCredits.ts) —
  says up front how much AI work today's balance covers. Finding that out by
  hitting a wall mid-draft is the worse version of the same information.
*/
function EmptyState({
  credits,
  isAuthEnabled,
  attribution,
}: {
  credits: ReturnType<typeof useFlockAuth>["credits"];
  isAuthEnabled: boolean;
  attribution: DashboardAttribution;
}) {
  if (attribution === "unattributed") {
    return <UnattributedState />;
  }
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
      {/*
        See the header button: an <a> render target needs nativeButton={false}.
      */}
      <Button nativeButton={false} render={<Link href={STUDIO_PATH} />}>
        <PlusIcon />
        Write your first email
      </Button>
      {/*
        Null is not "still loading" — it is the server saying it can attribute
        no allowance to this caller (convex/authCredits.ts). Printing a
        fabricated "5 of 5" under a sentence that promises a real number is
        the one thing this line must not do, so it simply is not shown.
      */}
      {isAuthEnabled && credits !== undefined && credits !== null ? (
        <p className="text-xs text-muted-foreground">
          {credits.remaining} of {credits.limit} AI requests left today
          {credits.isClaimedTier ? "." : " — saving your work to an email raises this."}
        </p>
      ) : null}
    </div>
  );
}

/*
  What a signed-out visitor sees on a deployment that will not accept a
  client-supplied ownership key (see ./dashboard-attribution.ts for how we
  know we are in that state).

  It is NOT the empty state with different words. The empty state's whole
  message — "everything you make shows up here" — is the one thing that is not
  true here, so this replaces it rather than dressing it. Three facts, in the
  order they matter to the person reading:

    1. WHY it is blank. Not "you have nothing"; "we don't know who you are".
       Getting this wrong is what makes someone think their work was deleted.
    2. WHAT IS SAFE. Nothing was lost and no link stopped working — the
       document id is the capability and never consulted identity
       (convex/canvases.ts). The blank list is a listing problem, not a data
       problem, and that distinction is the whole reason not to panic.
    3. WHAT WRITING NOW ACTUALLY GETS THEM. A canvas created with no owner id
       records no `canvasOwners` row at all (`recordCanvasOwner`), so it will
       never appear here — not now, and not later after they sign in. Offering
       "Write your first email" under a promise it cannot keep is exactly the
       failure this whole page is being fixed for, so the button stays (never
       gate) and the sentence above it tells the truth about it.

  Sign in leads, because it is the action that makes the page work. But it is
  an offer: there is no redirect, no interstitial, and the studio is one click
  away for someone who genuinely just wants to write something.
*/
function UnattributedState() {
  return (
    <div
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-border px-6 py-16 text-center"
      data-testid="dashboard-signed-out-state"
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <LogInIcon className="size-5" aria-hidden="true" />
      </div>
      <div className="flex max-w-sm flex-col gap-1.5">
        <h2 className="text-base font-semibold">Sign in to see your emails</h2>
        <p className="text-sm text-muted-foreground">
          You&rsquo;re not signed in, so we can&rsquo;t tell which emails are
          yours. Nothing has been lost — any link you saved still opens the
          draft it points to.
        </p>
        <p className="text-sm text-muted-foreground">
          You can still write one now without signing in; it just won&rsquo;t be
          listed here.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {/*
          See the header buttons: an <a> render target needs nativeButton={false}.
        */}
        <Button nativeButton={false} render={<Link href={LOGIN_PATH} />}>
          Sign in
        </Button>
        <Button variant="outline" nativeButton={false} render={<Link href={STUDIO_PATH} />}>
          <PlusIcon />
          Write one anyway
        </Button>
      </div>
    </div>
  );
}
