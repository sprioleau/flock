"use client";

import { MailIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DASHBOARD_PATH } from "./config";
import { useFlockAuth } from "./use-flock-auth";
import { willRenderUserMenu } from "./user-menu-visibility";

/*
  THE WAY OUT OF THE STUDIO WHEN THERE IS NO USER MENU.

  Yes, this duplicates the "Your emails" item inside `UserButton`'s dropdown.
  That is deliberate — do not delete it as redundant.

  The link lives in the account menu because that is where a person looks for
  it, but `UserButton` renders null whenever there is no identity to talk
  about: on every deploy with auth disabled (the default), and on the first
  paint of every deploy where it is enabled, while the identity query is still
  in flight. In those states the editor has no header link, no nav, and no
  back button that goes anywhere useful — /dashboard exists and is simply
  unreachable. A duplicate that only appears when the original cannot is
  cheaper than either of the alternatives: pulling the link out of the account
  menu (where it belongs) or letting the studio stay a one-way door.

  NO DOUBLE-UP: this and `UserButton` share one predicate and take opposite
  sides of it (./user-menu-visibility.ts), so exactly one of them is on screen
  at any moment. There is never a moment with two "Your emails" affordances.

  NO LAYOUT JUMP: mounted as the immediate sibling of `UserButton` in the
  toolbar's right cluster, it occupies the same slot in the same flex row and
  wears the same skin — outline, size sm, one icon, no label — as the claimed
  `UserButton` trigger it hands over to. When the identity query lands, this
  unmounts and that mounts at the same index with the same footprint, so
  nothing to the right of it slides.

  Icon-only with a tooltip because that is the toolbar's idiom (undo, redo,
  comments, replay are all icon + tooltip); the accessible name carries the
  words. `nativeButton={false}` because the render target is an <a> and Base
  UI throws in production when a button renders a non-button element without
  being told.
*/
export function DashboardLinkFallback() {
  const auth = useFlockAuth();

  if (willRenderUserMenu(auth)) {
    return null;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              aria-label="Your emails"
              nativeButton={false}
              render={<Link href={DASHBOARD_PATH} />}
              data-testid="dashboard-link-fallback"
            />
          }
        >
          <MailIcon />
        </TooltipTrigger>
        <TooltipContent side="bottom">Your emails</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
