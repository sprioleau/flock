"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth/auth-client";
import { AUTH_CALLBACK_PATH, STUDIO_PATH } from "@/lib/auth/config";

/**
 * The front door's two ways in.
 *
 * Better Auth ships no prebuilt UI (checked against its docs — there is no
 * official component package), so this is a plain centered form, which is what
 * a one-input flow deserves anyway.
 *
 *   Continue with email     → a magic link. For people COMING BACK, on any
 *                             device, including one that has never seen this
 *                             app before.
 *   Continue without an     → an anonymous session, right now, no fields.
 *   account                   The demo's zero-friction path, kept first-class.
 *
 * The reassurance line under the anonymous option is load-bearing, not
 * decoration: the single reason someone hesitates at "without an account" is
 * fear of losing what they make. Saying up front that they can attach an email
 * later, and that their work follows, is what makes the low-friction path the
 * comfortable one instead of the risky one.
 */
export function LoginPanel() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "sending" }
    | { status: "entering" }
    | { status: "sent" }
    | { status: "failed"; message: string }
  >({ status: "idle" });

  if (state.status === "sent") {
    return (
      <div className="w-full">
        <p className="text-sm font-medium text-foreground">Check your inbox</p>
        <p className="mt-1 text-sm text-muted-foreground">
          We sent a sign-in link to {email}. Open it on any device and your
          drafts, brand kit and images will be waiting.
        </p>
      </div>
    );
  }

  const isBusy = state.status === "sending" || state.status === "entering";

  const handleEmailSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (trimmedEmail.length === 0) {
      setState({
        status: "failed",
        message: "Add the email address you saved your work to.",
      });
      return;
    }
    setState({ status: "sending" });
    try {
      const { error } = await authClient.signIn.magicLink({
        email: trimmedEmail,
        callbackURL: AUTH_CALLBACK_PATH,
      });
      if (error) {
        setState({
          status: "failed",
          message:
            error.message ??
            "We couldn't send that link just now. Give it a moment and try again.",
        });
        return;
      }
      setState({ status: "sent" });
    } catch {
      setState({
        status: "failed",
        message:
          "We couldn't reach the mail service. Check your connection and try again.",
      });
    }
  };

  const handleAnonymousEntry = async () => {
    setState({ status: "entering" });
    try {
      const { error } = await authClient.signIn.anonymous();
      if (error) {
        setState({
          status: "failed",
          message: "We couldn't start a session just now. Try again in a moment.",
        });
        return;
      }
      router.push(STUDIO_PATH);
    } catch {
      setState({
        status: "failed",
        message: "We couldn't start a session just now. Try again in a moment.",
      });
    }
  };

  return (
    <div className="flex w-full flex-col gap-5">
      <form className="flex w-full flex-col gap-3" onSubmit={handleEmailSubmit}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="login-email">Email</Label>
          <Input
            id="login-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={isBusy}
            aria-invalid={state.status === "failed" || undefined}
            aria-describedby={state.status === "failed" ? "login-error" : undefined}
          />
        </div>
        {state.status === "failed" ? (
          <p id="login-error" role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        ) : null}
        <Button type="submit" disabled={isBusy}>
          {state.status === "sending" ? "Sending…" : "Continue with email"}
        </Button>
      </form>

      <div className="flex items-center gap-3" aria-hidden>
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">or</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={isBusy}
          onClick={() => void handleAnonymousEntry()}
        >
          {state.status === "entering" ? "Starting…" : "Continue without an account"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Start building right away. You can add your email whenever you like —
          everything you&rsquo;ve made comes with you, on every device.
        </p>
      </div>
    </div>
  );
}
