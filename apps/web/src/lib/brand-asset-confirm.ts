/*
  The ONE client-side call to POST /api/brand-kit/confirm-asset (brand-kit
  architecture §8, Stage S: make an extracted suggestion durable).

  Why it is a module and not an inline fetch: two surfaces now ask for the
  same thing — the brand kit panel's asset card, and the logo block's property
  panel — and a second copy of this call is exactly how the two would drift
  apart on the request shape, on error handling, or (worst) on what a caller
  is allowed to name.

  THE PART THAT MUST NOT WIDEN: the caller says which KIND of asset to
  confirm, and nothing else. The route re-reads the asset URL from the
  session's kit row server-side, because a client-supplied URL would turn
  confirm into an SSRF fetch at a target the client picked. There is
  deliberately no `url` parameter here to pass one, and adding one would
  defeat the route's guard rather than extend it.

  Confirming does real network work — fetch the third-party image, run it
  through the SSRF rails, rehost it into Convex storage — so it fails in
  ordinary ways: the source 404s, answers a bot challenge instead of bytes,
  isn't an image, or is too big. Every failure comes back as a message
  written for the user, so no caller has to invent copy for a failure it
  cannot see from the browser.
*/

import { z } from "zod";
import type { BrandKitAssetKind } from "./brand-kit";

/*
  The route's contract, PARSED rather than asserted. A cast would let an
  unreachable route (an HTML error page, a proxy's JSON) type-lie its way
  into the UI as a success carrying `url: undefined`.
*/
const confirmAssetResponseSchema = z.discriminatedUnion("isOk", [
  z.object({ isOk: z.literal(true), url: z.string() }),
  z.object({ isOk: z.literal(false), message: z.string() }),
]);

export type ConfirmBrandAssetOutcome = z.infer<typeof confirmAssetResponseSchema>;

/*
  Used only when the route never answered, or answered something this file
  cannot read — every failure the route CAN see arrives with its own words.
*/
const UNAVAILABLE_MESSAGE = "Couldn't save that image right now. Try again.";

/*
  Confirm the session kit's suggested asset. Resolves either way: a rejected
  promise here would leave a caller's in-flight flag stuck on.
*/
export async function confirmBrandAsset({
  sessionId,
  kind,
}: {
  sessionId: string;
  kind: BrandKitAssetKind;
}): Promise<ConfirmBrandAssetOutcome> {
  try {
    const response = await fetch("/api/brand-kit/confirm-asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, kind }),
    });
    /*
      The BODY decides, not the status: every refusal the route means to show
      a user is a 4xx/5xx carrying `{ isOk: false, message }`.
    */
    const parsed = confirmAssetResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : { isOk: false, message: UNAVAILABLE_MESSAGE };
  } catch {
    return { isOk: false, message: UNAVAILABLE_MESSAGE };
  }
}
