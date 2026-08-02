import "server-only";
import { api } from "@convex/_generated/api";
import { getSessionIdFromCookieHeader } from "@/lib/session-cookie";
import { hasOwnerOverride } from "./owner-override";
import { deriveOriginKey } from "./origin-key";
import { fetchAuthMutation } from "./auth-server";

/**
 * The one line an inference route adds to charge a credit.
 *
 * Usage, at the top of a route that is about to call a model:
 *
 *   const charge = await chargeCreditForRequest({ request });
 *   if (!charge.isAllowed) {
 *     return Response.json({ error: "out_of_credits", message: charge.message }, { status: 429 });
 *   }
 *
 * Charged before the model call, not after — see convex/authCredits.ts for why
 * there is no refund path.
 *
 * FAILS OPEN. If the credit check itself cannot complete (Convex unreachable,
 * auth misconfigured), the request proceeds. A metering outage must not take
 * the product down: the provider quota is still a hard ceiling behind it, and
 * "the demo broke because the counter broke" is a worse failure than "someone
 * got a free turn".
 */

export type CreditCharge = {
  isAllowed: boolean;
  /** True when the owner override lifted the cap for this browser. */
  isUnlimited: boolean;
  remaining: number | null;
  message: string;
};

const OUT_OF_CREDITS_MESSAGE =
  "You've used today's AI allowance. It refills automatically — try again later.";

export async function chargeCreditForRequest(args: {
  request: Request;
  /**
   * True when this request will be served by a deterministic mock instead of a
   * real model. Mock runs spend no provider quota, so charging for them would
   * make the number mean something different in dev than in production — and
   * would burn a demo visitor's allowance on a deployment with no API key
   * configured at all.
   */
  isMockRun?: boolean;
  /** Credits this piece of work costs. Defaults to one. */
  amount?: number;
}): Promise<CreditCharge> {
  if (args.isMockRun === true) {
    return { isAllowed: true, isUnlimited: true, remaining: null, message: "" };
  }

  const cookieHeader = args.request.headers.get("cookie");

  if (hasOwnerOverride(cookieHeader)) {
    return {
      isAllowed: true,
      isUnlimited: true,
      remaining: null,
      message: "",
    };
  }

  // Pre-roll-out callers have no verified identity; the mirrored session
  // cookie is the fallback ownership key (convex/authIdentity.ts).
  const sessionId = getSessionIdFromCookieHeader(cookieHeader) ?? "";
  // Derived HERE and not in Convex, which cannot see the client address.
  const originKey = deriveOriginKey(args.request);

  try {
    const result = await fetchAuthMutation(api.authCredits.spend, {
      sessionId,
      ...(originKey === undefined ? {} : { originKey }),
      ...(args.amount === undefined ? {} : { amount: args.amount }),
    });
    return {
      isAllowed: result.isAllowed,
      isUnlimited: false,
      remaining: result.balance.remaining,
      message: result.isAllowed ? "" : OUT_OF_CREDITS_MESSAGE,
    };
  } catch (error) {
    console.warn("[credits] allowance check failed; letting the request through", error);
    return { isAllowed: true, isUnlimited: false, remaining: null, message: "" };
  }
}
