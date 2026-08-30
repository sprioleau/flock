import { OWNER_OVERRIDE_STATUS_PATH } from "@/lib/auth/use-owner-override";

/*
  Talking to /api/auth/override, and deciding what to say about the answer.

  Split out of the panel so both halves are testable without a DOM, and so the
  ONE rule that matters here is stated in one place:

    THE SERVER'S REJECTION MESSAGE IS SHOWN VERBATIM, NEVER SPECIALISED.

  "That password didn't match." is deliberately ambiguous — a wrong password
  and a deployment with no override configured return the identical 403 with
  identical text, so probing this page cannot reveal whether an override
  exists here at all (see lib/auth/owner-override.ts). Being more helpful
  ("no override is set up on this deployment", "check your password") would
  hand that answer straight back. The fallbacks below exist only for a
  response that carried no message, and they say no more than the server's own
  wording does.

  Neither request function throws. A page that asks for a password has exactly
  two useful shapes of answer — "you're in" and "here is what went wrong" —
  and an exception escaping into a click handler is neither.
*/

export type OverrideOutcome =
  | { status: "unlocked"; message: string }
  | { status: "rejected"; message: string }
  | { status: "throttled"; message: string }
  | { status: "failed"; message: string };

export type OverrideReleaseOutcome =
  | { status: "released"; message: string }
  | { status: "failed"; message: string };

/*
  Used only when a 403 arrives with no message; matches the server's text.
*/
export const OVERRIDE_REJECTED_FALLBACK_MESSAGE = "That password didn't match.";

/*
  Used only when a 429 arrives with no message; matches the server's text.
*/
export const OVERRIDE_THROTTLED_FALLBACK_MESSAGE =
  "Too many attempts. Wait a minute and try again.";

/*
  Used only when a success response carried no message.
*/
export const OVERRIDE_UNLOCKED_FALLBACK_MESSAGE = "Credit limit lifted on this browser.";

/*
  Used only when a release response carried no message.
*/
export const OVERRIDE_RELEASED_FALLBACK_MESSAGE = "Credit limit restored.";

/*
  Any other status, and anything that never reached the server at all.
*/
export const OVERRIDE_UNAVAILABLE_MESSAGE =
  "We couldn't reach the server just now. Try again in a moment.";

/*
  Shown instead of submitting an empty field — no round trip, no attempt spent.
*/
export const OVERRIDE_EMPTY_PASSWORD_MESSAGE = "Enter the password to continue.";

function readMessage(body: unknown): string | null {
  const candidate = (body as { message?: unknown } | null)?.message;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : null;
}

function isUnlockedBody(body: unknown): boolean {
  return (body as { isUnlocked?: unknown } | null)?.isUnlocked === true;
}

/*
  Non-JSON bodies (a proxy's HTML error page) become null rather than throwing.
*/
async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/*
  Map a redeem (POST) response to what the page should show and become.

  `body` is whatever parsing produced — `null` when it was not JSON at all,
  which is treated as "no message", never as an error to describe in its own
  words.
*/
export function resolveRedeemOutcome(args: { httpStatus: number; body: unknown }): OverrideOutcome {
  if (args.httpStatus === 429) {
    return {
      status: "throttled",
      message: readMessage(args.body) ?? OVERRIDE_THROTTLED_FALLBACK_MESSAGE,
    };
  }
  if (args.httpStatus === 403) {
    return {
      status: "rejected",
      message: readMessage(args.body) ?? OVERRIDE_REJECTED_FALLBACK_MESSAGE,
    };
  }
  if (args.httpStatus >= 200 && args.httpStatus < 300 && isUnlockedBody(args.body)) {
    return {
      status: "unlocked",
      message: readMessage(args.body) ?? OVERRIDE_UNLOCKED_FALLBACK_MESSAGE,
    };
  }
  /*
    A 500, a gateway's HTML error page, a 200 that somehow says nothing — none
    of these are "wrong password", and claiming they were would be a lie the
    user acts on by retyping a password that was fine.
  */
  return { status: "failed", message: OVERRIDE_UNAVAILABLE_MESSAGE };
}

/*
  Map a release (DELETE) response. Only "did it come back?" matters.
*/
export function resolveReleaseOutcome(args: {
  httpStatus: number;
  body: unknown;
}): OverrideReleaseOutcome {
  if (args.httpStatus >= 200 && args.httpStatus < 300) {
    return {
      status: "released",
      message: readMessage(args.body) ?? OVERRIDE_RELEASED_FALLBACK_MESSAGE,
    };
  }
  return { status: "failed", message: OVERRIDE_UNAVAILABLE_MESSAGE };
}

/*
  Submit a password. The value goes in the body, never the URL.
*/
export async function redeemOwnerOverride(password: string): Promise<OverrideOutcome> {
  try {
    const response = await fetch(OWNER_OVERRIDE_STATUS_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ password }),
    });
    return resolveRedeemOutcome({
      httpStatus: response.status,
      body: await readJsonBody(response),
    });
  } catch {
    return { status: "failed", message: OVERRIDE_UNAVAILABLE_MESSAGE };
  }
}

/*
  Hand the override back.
*/
export async function releaseOwnerOverride(): Promise<OverrideReleaseOutcome> {
  try {
    const response = await fetch(OWNER_OVERRIDE_STATUS_PATH, {
      method: "DELETE",
      credentials: "same-origin",
    });
    return resolveReleaseOutcome({
      httpStatus: response.status,
      body: await readJsonBody(response),
    });
  } catch {
    return { status: "failed", message: OVERRIDE_UNAVAILABLE_MESSAGE };
  }
}
