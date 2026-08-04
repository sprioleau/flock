"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useOwnerOverride } from "@/lib/auth/use-owner-override";
import {
  OVERRIDE_EMPTY_PASSWORD_MESSAGE,
  redeemOwnerOverride,
  releaseOwnerOverride,
} from "./override-client";

/**
 * The redemption form.
 *
 * Shaped after the front door's LoginPanel (app/LoginPanel.tsx) on purpose:
 * one field, one button, a single line of plain result copy. A page that asks
 * for a password should look like the other page that asks for a password.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 * - No hint about whether an override exists on this deployment. The server
 *   answers a wrong password and an unconfigured deployment identically, and
 *   this page must not undo that by phrasing them differently. See
 *   ./override-client.ts.
 * - No mention of the secret's name, the cookie, or the endpoint anywhere a
 *   user can read.
 * - No client-side validation of the password's shape. Length, charset and
 *   "looks like ours" checks are all disclosure.
 *
 * The empty-field check IS client-side, and is the one exception worth making:
 * submitting nothing spends one of five attempts per minute against a limiter
 * whose whole job is to bound guessing, and an empty box was never a guess.
 */
export function OverridePanel() {
  const { isChecking, isUnlocked, setUnlocked } = useOwnerOverride();
  const [password, setPassword] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "error" | "success";
    message: string;
  } | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (password.length === 0) {
      setNotice({ tone: "error", message: OVERRIDE_EMPTY_PASSWORD_MESSAGE });
      return;
    }
    setIsBusy(true);
    setNotice(null);
    void redeemOwnerOverride(password)
      .then((outcome) => {
        if (outcome.status === "unlocked") {
          // Clear the field first: the value is spent, and leaving it sitting
          // in a form on a screen someone else may see is careless.
          setPassword("");
          setUnlocked(true);
          setNotice({ tone: "success", message: outcome.message });
          return;
        }
        // Rejected, throttled and failed all render the same way — the server's
        // own words, unedited. Only the wording differs, and that is the
        // server's call, not this component's.
        setNotice({ tone: "error", message: outcome.message });
      })
      .finally(() => {
        setIsBusy(false);
      });
  };

  const handleRelease = (): void => {
    setIsBusy(true);
    setNotice(null);
    void releaseOwnerOverride()
      .then((outcome) => {
        if (outcome.status === "released") {
          setUnlocked(false);
        }
        setNotice({
          tone: outcome.status === "released" ? "success" : "error",
          message: outcome.message,
        });
      })
      .finally(() => {
        setIsBusy(false);
      });
  };

  return (
    <OverridePanelView
      isChecking={isChecking}
      isUnlocked={isUnlocked}
      isBusy={isBusy}
      password={password}
      notice={notice}
      onPasswordChange={(value) => {
        setPassword(value);
        // Owner law: instant feedback. A stale "that didn't match" sitting
        // under a field the user is already retyping is feedback about the
        // past, so it goes the moment the input changes.
        setNotice(null);
      }}
      onSubmit={handleSubmit}
      onRelease={handleRelease}
    />
  );
}

export interface OverridePanelViewProps {
  /** No answer yet about this browser — distinct from "answered: locked". */
  isChecking: boolean;
  isUnlocked: boolean;
  isBusy: boolean;
  password: string;
  notice: { tone: "error" | "success"; message: string } | null;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRelease: () => void;
}

/**
 * Every visible state, as a pure function of props — the reason the stateful
 * shell above delegates rather than rendering inline. It is what the tests
 * render, so what the tests assert is literally what ships.
 */
export function OverridePanelView(props: OverridePanelViewProps) {
  if (props.isChecking) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Checking this browser…
      </p>
    );
  }

  if (props.isUnlocked) {
    return (
      <div className="flex w-full flex-col gap-4">
        <div>
          <p className="text-sm font-medium text-foreground">
            This browser has owner access.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            AI requests made here aren&rsquo;t counted against the daily limit,
            and the settings menu lets you choose which service answers your
            chat messages.
          </p>
        </div>
        {props.notice === null ? null : (
          <p
            role="status"
            className={
              props.notice.tone === "error"
                ? "text-sm text-destructive"
                : "text-sm text-muted-foreground"
            }
          >
            {props.notice.message}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={props.isBusy}
          onClick={props.onRelease}
          data-testid="override-release"
        >
          {props.isBusy ? "Giving it back…" : "Give it back"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Giving it back puts this browser back on the normal daily limit. You
          can come here and unlock it again whenever you like.
        </p>
      </div>
    );
  }

  return (
    <form className="flex w-full flex-col gap-4" onSubmit={props.onSubmit}>
      <p className="text-sm text-muted-foreground">
        Enter the owner password to lift the daily limit on AI requests in this
        browser.
      </p>
      <div className="flex flex-col gap-2">
        <Label htmlFor="override-password">Password</Label>
        <Input
          id="override-password"
          name="override-password"
          type="password"
          autoComplete="off"
          value={props.password}
          onChange={(event) => props.onPasswordChange(event.target.value)}
          disabled={props.isBusy}
          aria-invalid={props.notice?.tone === "error" || undefined}
          aria-describedby={props.notice === null ? undefined : "override-notice"}
          data-testid="override-password"
        />
      </div>
      {props.notice === null ? null : (
        <p
          id="override-notice"
          role={props.notice.tone === "error" ? "alert" : "status"}
          className={
            props.notice.tone === "error"
              ? "text-sm text-destructive"
              : "text-sm text-muted-foreground"
          }
        >
          {props.notice.message}
        </p>
      )}
      <Button type="submit" disabled={props.isBusy} data-testid="override-submit">
        {props.isBusy ? "Unlocking…" : "Unlock"}
      </Button>
    </form>
  );
}
