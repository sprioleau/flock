import "server-only";
import { createHmac } from "node:crypto";
import { api } from "@convex/_generated/api";
import { deriveOriginKey } from "./origin-key";
import { fetchAuthMutation } from "./auth-server";

/*
  THE ONE LINE A SEND ROUTE ADDS TO METER ITSELF.

  Usage, immediately before dispatching a real send:

    const reservation = await reserveTestSend({ request, to });
    if (!reservation.isAllowed) {
      return Response.json(
        { error: "send_limit_reached", message: reservation.message },
        { status: 429 },
      );
    }

  The buckets, the limits and the copy all live in convex/authTestSends.ts, which
  is where the reasoning is written down. This module's whole job is the part
  that CANNOT live in Convex: deriving the two salted bucket keys, because Convex
  functions cannot see the client address and must never be handed a recipient
  address in the clear.

  FAILS CLOSED — the opposite of `chargeCreditForRequest` next door, and the same
  posture as `resolveCaller` in the route this serves.

  The credit meter fails open because a metering outage must not take the demo
  down, and because the provider's own quota is still a hard ceiling behind it.
  Neither half of that argument survives here. There is no ceiling behind this
  one: Resend will cheerfully deliver every message we hand it, and the cost of
  the ones that should not have gone out is a domain reputation we cannot buy
  back. And the route this guards ALREADY refuses when it cannot reach Convex —
  the identity gate is fail-closed and runs first — so on an auth-enabled
  deployment a Convex outage stops sends whether or not this module agrees. Being
  the one fail-open link in a fail-closed chain would buy nothing and cost
  exactly the hole this exists to close.
*/

export interface TestSendReservation {
  isAllowed: boolean;
  /*
    Empty when allowed; otherwise the exact words to show the person.
  */
  message: string;
  /*
    When the blocking allowance refills, or null when nothing blocked.
  */
  retryAtMs: number | null;
}

/*
  What the person sees when the meter itself cannot be consulted. Says the true
  thing — we could not check — rather than claiming an allowance was spent, and
  it is retryable, because a blip is exactly what this usually is.
*/
const METER_UNAVAILABLE_MESSAGE =
  "This Flock couldn't check its send allowance just now — try again in a moment.";

/*
  Cheap, non-secret fallback so a missing secret degrades rather than throws —
  mirrored from origin-key.ts rather than imported, because that module keeps its
  salt reader private and reaching in to share four lines would couple two
  guards that should be free to diverge.
*/
const FALLBACK_SALT = "flock-send-meter";

function readSalt(): string {
  /*
    The auth secret: already required, already high-entropy, already server-only.
  */
  const secret = process.env.BETTER_AUTH_SECRET;
  return secret !== undefined && secret.length > 0 ? secret : FALLBACK_SALT;
}

/*
  The address as a bucket identity: trimmed and lowercased, so "Sam@Site.com "
  and "sam@site.com" cannot each buy their own allowance. Deliberately NOT
  clever about plus-addressing or dotted Gmail locals — collapsing those would
  merge inboxes that some providers genuinely treat as distinct, and the bucket
  is generous enough that the extra rotation it allows is not the binding risk.
*/
export function normalizeRecipient(raw: string): string {
  return raw.trim().toLowerCase();
}

/*
  The opaque per-recipient bucket key. Domain-separated from the origin key by a
  context prefix, so a recipient digest and an origin digest can never collide or
  be compared against one another even in principle.
*/
export function deriveRecipientKey(recipient: string): string {
  return createHmac("sha256", readSalt())
    .update(`test-send-recipient\n${normalizeRecipient(recipient)}`)
    .digest("hex")
    .slice(0, 32);
}

export async function reserveTestSend(args: {
  request: Request;
  /*
    The recipients exactly as the request asked for them (1–5).
  */
  to: string[];
}): Promise<TestSendReservation> {
  /*
    Derived HERE, not in Convex: `x-forwarded-for` is visible to a Next route and
    invisible to a Convex function, and each recipient must be a digest before it
    crosses into a stored row at all.
  */
  const originKey = deriveOriginKey(args.request);
  /*
    One digest per DISTINCT recipient. `deriveRecipientKey` normalizes before
    hashing, so two spellings of one inbox collapse to a single key here — the
    meter charges that inbox's bucket once for the send, never twice. The origin
    and owner buckets are still charged once each by the mutation, because a
    send is one human action however many people it is addressed to.
  */
  const recipientKeys = [...new Set(args.to.map(deriveRecipientKey))];

  try {
    /*
      `fetchAuthMutation` forwards the caller's signed Convex token, so the
      mutation resolves the owner from a verified identity. Nothing about WHO is
      sending travels as an argument — see the note on `reserveTestSend` in
      convex/authTestSends.ts for why that matters.
    */
    const result = await fetchAuthMutation(api.authTestSends.reserveTestSend, {
      recipientKeys,
      ...(originKey === undefined ? {} : { originKey }),
    });
    return {
      isAllowed: result.isAllowed,
      message: result.refusalMessage,
      retryAtMs: result.retryAtMs,
    };
  } catch (error) {
    console.warn("[send-meter] allowance check failed; refusing the send", error);
    return { isAllowed: false, message: METER_UNAVAILABLE_MESSAGE, retryAtMs: null };
  }
}
