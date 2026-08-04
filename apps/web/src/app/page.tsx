import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DASHBOARD_PATH, isAuthEnabled } from "@/lib/auth/config";
import { isAuthenticatedSafely } from "@/lib/auth/auth-server";
import { LoginPanel } from "./LoginPanel";
import { InteractiveLineGrid } from "@/components/ui/interactive-line-grid";

export const metadata: Metadata = {
  title: "Flock",
  description: "An AI-powered collaborative email editor.",
};

/**
 * The front door.
 *
 * WHAT HAPPENED TO THE ACCESS GATE (the owner asked for one mechanism, not two
 * half-overlapping ones — this is the decision):
 *
 *   The FLOCK_ACCESS_PASSWORD gate is RETIRED. It answered "may you start
 *   using Flock?" with a single shared password and no notion of who you were.
 *   Now that anyone may start with one click ("Continue without an account"),
 *   that question has no teeth left to keep — a password in front of a button
 *   marked "continue without an account" is theatre. Keeping both would mean
 *   two access-control surfaces disagreeing about who is allowed in, which is
 *   exactly what we were asked not to leave behind.
 *
 *   Deleted with it: apps/web/src/proxy.ts (the gate proxy and its per-doc /
 *   per-canvas capability cookies, which existed only to let share links past
 *   the password), apps/web/src/lib/access-gate.ts, and apps/web/src/app/gate.
 *   FLOCK_ACCESS_PASSWORD is now unused and can be removed from the
 *   deployment. `documents.documentExists` / `documents.canvasExists` lose
 *   their only caller but are left in place — pruning Convex functions is not
 *   this change's business.
 *
 *   What this costs, stated plainly: the deployment is no longer invite-only.
 *   Anyone with the URL can start a session. That is the direct consequence of
 *   making anonymous entry a first-class button, and the credit allowance
 *   (convex/authCredits.ts) — not a shared password — is now what protects the
 *   API spend behind it.
 *
 *   Share-by-link is UNAFFECTED and got simpler: `?doc=`/`?canvas=` URLs now
 *   open with nothing in front of them at all. The id is still the capability.
 *
 * Anyone who already has a session skips this page rather than being asked to
 * identify themselves twice.
 *
 * They land on the DASHBOARD, not the studio. Sending a returning user into a
 * fresh blank draft was the single biggest hole in the product: it was the
 * only route, so work you had not bookmarked was work you could not find.
 * Starting something new is one button from the dashboard; the reverse was not
 * true.
 */
export default async function Home() {
  if (!isAuthEnabled() || (await isAuthenticatedSafely())) {
    // Flag off: no identity exists to establish, so there is nothing to ask.
    redirect(DASHBOARD_PATH);
  }

  return (
    <div className="absolute w-full h-full bg-transparent overflow-hidden">
      <InteractiveLineGrid />
      {/*
       * z-10 against the grid's z-0: both layers are positioned, so without
       * explicit indices the sign-in UI would sit on top only by accident of
       * DOM order — one reorder away from being painted over by the backdrop.
       */}
      <main className="relative z-10 w-full h-full flex flex-1 flex-col items-center justify-center gap-6 p-8">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-4xl font-semibold tracking-tight">Flock</h1>
          <p className="max-w-xs text-center text-sm text-muted-foreground">
            An AI-powered collaborative email editor. You describe, your flock
            builds.
          </p>
        </div>

        <div className="w-full max-w-xs rounded-xl border border-border bg-card/75 dark:bg-card/60 p-6 shadow-sm backdrop-blur-md">
          <LoginPanel />
        </div>

        <p className="max-w-xs text-center text-xs text-muted-foreground">
          Have a shared email link? Open it directly — it takes you straight to
          the draft.
        </p>
      </main>
    </div>
  );
}
