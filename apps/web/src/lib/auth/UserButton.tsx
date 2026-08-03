"use client";

import { UserIcon, UserRoundCheckIcon } from "lucide-react";
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
import { useFlockAuth } from "./use-flock-auth";

/**
 * The account control in the canvas header.
 *
 * It carries the claim flow, because the claim flow needed somewhere a person
 * would actually find it. "Save your work" buried in a settings panel is a
 * feature nobody uses; sitting in the chrome next to the collaborator avatars,
 * showing an unclaimed state, it is an open loop the user wants to close.
 *
 * Three jobs, in the order they matter:
 *   1. Say whether this work is anchored to anything (anonymous vs claimed).
 *   2. Offer the one action that changes that — email me a link.
 *   3. Show what is left of today's AI allowance, since that is the other
 *      number a person needs and has nowhere else to live.
 *
 * Renders nothing when auth is disabled, so mounting it is unconditional at
 * the call site.
 */
export function UserButton() {
  const { isEnabled, identity, isUnclaimed, credits, magicLinkRequest, sendMagicLink, signOut } =
    useFlockAuth();
  const [email, setEmail] = useState("");

  if (!isEnabled || identity === undefined || identity === null) {
    return null;
  }

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
