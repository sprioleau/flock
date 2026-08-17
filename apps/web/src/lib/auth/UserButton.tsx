"use client";

import { UserIcon, UserRoundCheckIcon } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DASHBOARD_PATH } from "./config";
import { useFlockAuth } from "./use-flock-auth";
import { willRenderUserMenu } from "./user-menu-visibility";

/*
 * The account control in the canvas header.
 *
 * It carries the claim flow, because the claim flow needed somewhere a person
 * would actually find it. "Save your work" buried in a settings panel is a
 * feature nobody uses; sitting in the chrome next to the collaborator avatars,
 * showing an unclaimed state, it is an open loop the user wants to close.
 *
 * Four jobs, in the order they matter:
 *   1. Say whether this work is anchored to anything (anonymous vs claimed).
 *   2. Offer the one action that changes that — email me a link.
 *   3. Show what is left of today's AI allowance, since that is the other
 *      number a person needs and has nowhere else to live.
 *   4. Lead back to the emails this identity owns. That link used to hang off
 *      the presence avatar next door, which is a collaborator control, not an
 *      account one — nobody looked for the way out of the studio there.
 *
 * Renders nothing when auth is disabled, so mounting it is unconditional at
 * the call site.
 *
 * Job 4 is the catch: on a deploy with auth OFF this whole control is absent,
 * which took the ONLY way out of the studio with it. `DashboardLinkFallback`
 * covers exactly those gaps and is gated on the same predicate, so the two
 * are mutually exclusive by construction — see ./user-menu-visibility.ts.
 */
export function UserButton() {
  const auth = useFlockAuth();
  const [email, setEmail] = useState("");

  /*
    The one gate, shared with DashboardLinkFallback so the two can never both
    be on screen and never both be off it. See ./user-menu-visibility.ts —
    this early return is half of a pair.
  */
  if (!willRenderUserMenu(auth)) {
    return null;
  }

  const { identity, isUnclaimed, credits, magicLinkRequest, sendMagicLink, signOut } = auth;
  const isSending = magicLinkRequest.status === "sending";
  const label = isUnclaimed ? "Save your work" : identity.email;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendMagicLink({ email });
  };

  return (
    <DropdownMenu>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={<Button variant="outline" size="sm" aria-label={label} />}
                data-testid="user-button-trigger"
              >
                {isUnclaimed ? <UserIcon /> : <UserRoundCheckIcon />}
                {/* The unclaimed state gets words, the claimed state gets an
                    icon: one is a call to action, the other is just status. */}
                {isUnclaimed ? (
                  <span className="hidden max-w-32 truncate lg:inline">Save your work</span>
                ) : null}
              </DropdownMenuTrigger>
            }
          />
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <DropdownMenuContent align="end" sideOffset={6} className="w-72 p-1.5">
        {isUnclaimed ? (
          /**
           * DropdownMenuGroup is not optional dressing: DropdownMenuLabel
           * renders Base UI's Menu.GroupLabel, which reads its group from
           * context and THROWS without one. Dev only warns, so a bare label
           * ships looking fine and then takes the whole page down in
           * production as "Base UI error #31".
           */
          <DropdownMenuGroup className="px-2 py-1.5">
            <DropdownMenuLabel className="px-0 pt-0 pb-1 text-sm font-semibold text-foreground">
              Save your work
            </DropdownMenuLabel>
            {magicLinkRequest.status === "sent" ? (
              <p className="text-sm text-muted-foreground">
                Check {magicLinkRequest.email} — open the link and everything
                you&rsquo;ve made comes with you, on every device.
              </p>
            ) : (
              <form className="flex flex-col gap-2" onSubmit={handleSubmit}>
                <p className="text-sm text-muted-foreground">
                  Right now your drafts, brand kit and images live in this
                  browser only. Add an email and we&rsquo;ll send a link that keeps
                  them — no password.
                </p>
                <Label htmlFor="user-button-email" className="sr-only">
                  Email
                </Label>
                <Input
                  id="user-button-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={isSending}
                />
                <Button type="submit" size="sm" disabled={isSending}>
                  {isSending ? "Sending…" : "Email me a link"}
                </Button>
                {magicLinkRequest.status === "failed" ? (
                  <p role="alert" className="text-sm text-destructive">
                    {magicLinkRequest.message}
                  </p>
                ) : null}
              </form>
            )}
          </DropdownMenuGroup>
        ) : (
          <DropdownMenuGroup className="px-2 py-1.5">
            <DropdownMenuLabel className="px-0 pt-0 pb-0.5 text-sm font-semibold text-foreground">
              Signed in
            </DropdownMenuLabel>
            <p className="truncate text-sm text-muted-foreground">{identity.email}</p>
          </DropdownMenuGroup>
        )}

        {/* Null means the server could attribute no allowance to this caller
            (convex/authCredits.ts). There is no honest number to print, so the
            section AND its separator go, rather than leaving a rule above a
            made-up number. In practice this pairs with the early return above —
            a caller with no identity has no menu to open — so it is a
            belt-and-braces branch, not a state a person is expected to reach. */}
        {credits === null ? null : (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5">
              <p className="text-sm font-medium text-foreground">Today&rsquo;s AI allowance</p>
              {credits === undefined ? (
                <p className="text-sm text-muted-foreground">Checking…</p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    {credits.remaining} of {credits.limit} left
                  </p>
                  {!credits.isClaimedTier ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Saving your work to an email raises this.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </>
        )}

        {/* The way OUT of the studio, and the reason this menu is where it
            belongs: the editor was a one-way door — no link back to the
            dashboard anywhere — so work you had not bookmarked was reachable
            only via browser back. It sits with the account, above Sign out,
            and OUTSIDE the claimed-only branch below: an anonymous visitor has
            drafts to get back to too.

            nativeButton={false} because the render target is an <a>: Base UI
            throws in production when a button renders a non-button element
            without being told. */}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            nativeButton={false}
            render={<Link href={DASHBOARD_PATH} />}
            data-testid="user-button-dashboard-link"
          >
            Your emails
          </Button>
        </div>

        {!isUnclaimed ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5">
              {/* Offered only to claimed accounts: signing out of an anonymous
                  identity would strand that work behind a key nothing can
                  reach again. */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => void signOut()}
              >
                Sign out
              </Button>
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
