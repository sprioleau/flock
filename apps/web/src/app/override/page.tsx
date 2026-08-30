import type { Metadata } from "next";
import Link from "next/link";
import { DASHBOARD_PATH } from "@/lib/auth/config";
import { InteractiveLineGrid } from "@/components/ui/interactive-line-grid";
import { OverridePanel } from "./OverridePanel";

/*
  The owner override's redemption page.

  WHY IT EXISTS: POST /api/auth/override has worked for a while and nothing in
  the app called it. Redeeming the override meant opening the browser console
  and typing a `fetch` by hand — a working feature with no door.

  UNLISTED, NOT SECRET. Nothing links here; you reach it by knowing the path.
  That is a convenience (it keeps an owner-only control out of everyone else's
  navigation), never a security measure — the password is what protects this,
  and the page is useless without it. Anyone who finds the URL sees a form
  that tells them nothing, including whether an override exists on this
  deployment at all.

  `robots: index/follow false` because an unlisted page that a crawler indexes
  is a listed page. There is no robots.ts / public/robots.txt in this repo, so
  the per-route metadata IS the whole convention — if a global one is added
  later this stays correct rather than duplicating it.

  No server-side redirect when the caller already holds an override: the page
  is where you go to GIVE IT BACK too, so bouncing an unlocked visitor away
  would remove the only way out. The panel reads the status and shows whichever
  of the two things there is to do.

  Visual language borrowed wholesale from the front door (app/page.tsx): same
  grid backdrop, same centred card, same semantic tokens. A one-field password
  page already exists in this app and inventing a second look for the second
  one would be gratuitous.
*/
export const metadata: Metadata = {
  title: "Owner access",
  description: "Lift this browser's usage limit.",
  robots: { index: false, follow: false },
};

export default function OverridePage() {
  return (
    <div className="absolute w-full h-full bg-transparent overflow-hidden">
      <InteractiveLineGrid />
      {/*
        z-10 against the grid's z-0, exactly as on the front door: both layers
        are positioned, so without explicit indices the form would sit on top
        only by accident of DOM order.
      */}
      <main className="relative z-10 w-full h-full flex flex-1 flex-col items-center justify-center gap-6 p-8">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-4xl font-semibold tracking-tight">Owner access</h1>
        </div>

        <div className="w-full max-w-xs rounded-xl border border-border bg-card/75 dark:bg-card/60 p-6 shadow-sm backdrop-blur-md">
          <OverridePanel />
        </div>

        <Link
          href={DASHBOARD_PATH}
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          Back to your emails
        </Link>
      </main>
    </div>
  );
}
