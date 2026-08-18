"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useConvex } from "convex/react";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { beginDemoSession } from "@/lib/demo/demo-session";
import { getOrCreateSessionId } from "@/lib/session";

/**
 * What /demo actually does: provision a scratch document, write the demo
 * preset into this browser, and hand over to the real studio.
 *
 * A PRESET OVER THE REAL STUDIO, not a second application (demo-mode.md §C).
 * Every surface the demo wants — the two agents on the canvas, time-travel
 * replay, the op inspector — is already gated on localStorage keys that the
 * settings FAB owns, so writing those keys buys the whole demo without a
 * single "…or we're in demo mode" branch anywhere in the studio. The demo is
 * honest about being the real product because it literally is the real route.
 *
 * A FRESH DOCUMENT PER VISIT, which is also the isolation story: presence
 * rooms are keyed per document, so two strangers arriving at the same moment
 * get two documents, two rooms and two sets of agent presence rows, and never
 * see each other. A single shared demo document would have made every visitor
 * an editor of the next visitor's demo. Nothing is added to the cleanup cron:
 * these are ordinary session documents that the existing 30-day sweep already
 * collects, and that cron has a data-loss history that makes new cleverness in
 * it a bad trade for tidiness.
 *
 * THE COST, stated plainly: after the redirect the address bar reads
 * /studio?doc=…, not /demo. Keeping the URL would mean teaching StudioShell's
 * ?doc= bookkeeping about a second route — a change to the most load-bearing
 * component in the app for a cosmetic gain.
 */
export function DemoBootstrap() {
  const router = useRouter();
  const convexClient = useConvex();
  const [hasFailed, setHasFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const isProvisionRequestedRef = useRef(false);

  useEffect(() => {
    if (isProvisionRequestedRef.current) {
      return;
    }
    isProvisionRequestedRef.current = true;
    convexClient
      .mutation(api.documents.createDocument, {
        sessionId: getOrCreateSessionId(),
        name: "Demo draft",
        canvasTitle: "Flock demo",
      })
      .then(({ documentId }) => {
        /* Preset BEFORE the navigation: /studio mounts once, and it has to
           mount with the two agents already enabled and the first-run tour
           already suppressed — a studio that mounted first and was configured
           afterwards would show a tour card over the demo and an empty
           facepile for a beat. */
        beginDemoSession({ documentId });
        router.replace(`/studio?doc=${documentId}`);
      })
      .catch((error: unknown) => {
        console.error("[demo] could not provision a demo document", error);
        setHasFailed(true);
      });
  }, [convexClient, router, attempt]);

  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center gap-3 px-6 text-center">
      {hasFailed ? (
        <>
          <TriangleAlertIcon className="size-8 text-destructive" />
          <div>
            <p className="text-sm font-medium">Couldn&apos;t set up the demo</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Check your connection and try again.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              isProvisionRequestedRef.current = false;
              setHasFailed(false);
              setAttempt((current) => current + 1);
            }}
          >
            Try again
          </Button>
        </>
      ) : (
        <>
          <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Setting up your demo…</p>
            <p className="mt-1 text-xs text-muted-foreground">
              A draft of your own, with two agents already in the room.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
