import { checkDocumentIntegrity } from "@flock/email-sdk";
import { api } from "@convex/_generated/api";
import { fetchAuthQuery } from "@/lib/auth/auth-server";
import { isAuthEnabled } from "@/lib/auth/config";
import { reserveTestSend } from "@/lib/auth/send-meter";
import { sendTestEmailWithResend } from "../chat/send-test-email";
import {
  sendTestEmailRequestBodySchema,
  type SendTestEmailErrorResponseBody,
  type SendTestEmailResponseBody,
} from "./contract";

/**
 * POST /api/send-test-email — the HUMAN path's test-send endpoint (the agent
 * path executes the same core module from the /api/chat sendTestEmail
 * executor, mirroring how /api/generate-image pairs with its chat executor).
 *
 * The chat flow gates sends behind a user-approval round because an AGENT
 * proposes them; here the click on the header's Send-test button IS that
 * explicit human intent (the analogue of the persona sweep's isManualSweep),
 * so this route does not ask a second time before dispatching into
 * {@link sendTestEmailWithResend} — same renderer, same subject derivation,
 * same payload-hash idempotency key (a re-click on an unchanged draft replays
 * Resend's original response instead of sending again), same user-facing
 * error copy. There is exactly ONE send path.
 *
 * Audit trail: the module writes the same flock.sendTestEmail.sent/.failed
 * log lines it writes for agent sends; this route adds one provenance line
 * marking the send as user-authored. A test send is a side effect, not a
 * document edit, so (as in the chat flow) nothing enters the op-log spine.
 *
 * WHO IS ASKING — the correction to the paragraph above.
 *
 * "The click on the Send-test button IS the human intent" is true of the
 * button and false of the URL. A route handler never sees a click; it sees an
 * HTTP request, and anything on the internet can make one. Until this gate
 * landed, the request carried BOTH the entire document (body copy, links,
 * images) and the recipient, so a stranger with curl could put arbitrary
 * content in an arbitrary inbox, sent from RESEND_FROM_EMAIL and DKIM-signed
 * by this project's verified domain — the reputation of that domain being the
 * asset actually at stake. The Zod email check on `to` is a FORMAT check, not
 * an allowlist, and never stood between anyone and that.
 *
 * So the route now resolves the caller's identity server-side, from the signed
 * session token Convex verifies, and refuses (401) when there is none. That is
 * deliberately the lowest possible bar: a browser sitting in an EDITOR is
 * signed in anonymously already, so a visitor who has never typed an email
 * address — including one who wandered in through /demo — passes it without
 * noticing. A bare curl with no session does not. The point is not to decide
 * who deserves to send; it is to make every send attributable to a session
 * this server minted, which is what a rate limit or a per-identity send meter
 * would later have to hang off.
 *
 * "In an editor" and not "on any page", which this comment used to claim.
 * Anonymous sign-in is scoped, on purpose, to EDITOR_ENTRY_PATHS (/studio and
 * /demo) plus links carrying a `doc`/`canvas` capability id — see
 * lib/auth/FlockAuthProvider.tsx, where the reasoning is that it must never
 * reach `/`: "Continue without an account" is an explicit choice on the login
 * page, and a silent sign-in on load would make that choice meaningless.
 * Nothing about this route's behaviour changes, because every path that can
 * reach a send is an editor. The old phrasing merely promised a guarantee the
 * app deliberately does not make.
 *
 * HOW MANY — the other half, and the reason the gate above was not enough.
 *
 * Identity is only WHO. The gate makes every send attributable; it caps
 * nothing, and the sessions it accepts are FREE TO MINT — a browser is signed
 * in anonymously the moment it lands on /studio, /demo, or a share link. So a
 * script could still mint a session, send, discard it and repeat, forever,
 * which puts the domain's reputation back exactly where the gate found it. The
 * send meter (convex/authTestSends.ts, called through lib/auth/send-meter.ts)
 * closes that: an identity bucket, an ORIGIN bucket a fresh identity does not
 * reset, and a RECIPIENT bucket no proxy pool can rotate past.
 *
 * It is deliberately NOT an AI credit. `chargeCreditForRequest` meters the
 * daily MODEL allowance, and a test send calls no model — spending someone's
 * AI budget to mail themselves a draft would make that number mean two
 * different things, and would let a person who tested three drafts discover
 * they can no longer talk to the agent. Separate counter, separate table.
 *
 * WHERE IT SITS in the sequence below is deliberate. It runs AFTER the free
 * refusals (identity, malformed body, failed integrity), so nothing a caller
 * gets rejected for costs them an allowance; and BEFORE the Resend call, so a
 * send in flight is already counted and two tabs racing the last unit cannot
 * both win it. There is no refund on failure — see `reserveTestSend`.
 */

function errorResponse(status: number, body: SendTestEmailErrorResponseBody): Response {
  return Response.json(body, { status });
}

/**
 * What the user is told when the gate closes. Phrased as a state of the
 * session rather than a verdict on them, because on a normal deployment that
 * is exactly what it is: the anonymous sign-in that happens on page load has
 * gone missing, and a reload mints a new one.
 */
const NOT_SIGNED_IN_MESSAGE =
  "This Flock couldn't confirm who's sending — reload the page and try again.";

/**
 * The caller's verified identity, or the fact that there is none.
 *
 * `ownerId` is null in exactly one situation: this deployment has auth
 * switched off entirely, so nobody has an id to be named by.
 */
type CallerResolution =
  | { isIdentified: true; ownerId: string | null }
  | { isIdentified: false };

async function resolveCaller(): Promise<CallerResolution> {
  /**
   * NEXT_PUBLIC_FLOCK_AUTH_ENABLED off means the identity system does not
   * exist here: nothing signs anyone in, `ctx.auth.getUserIdentity()` is null
   * in every Convex function, and ownership falls back to the client-supplied
   * session id (convex/authIdentity.ts). Requiring an identity in that state
   * would refuse EVERY send forever — a permanently broken button, not a
   * security control.
   *
   * So the flag short-circuits the gate, which is how the rest of the app
   * already reads it: app/page.tsx passes the front door with
   * `!isAuthEnabled() || isAuthenticatedSafely()`, and dashboard/page.tsx only
   * redirects when `isAuthEnabled() && !isAuthenticatedSafely()`. The flag is
   * the switch for whether identity is consulted at all, and one route
   * inventing a stricter reading of it is how two surfaces end up disagreeing.
   *
   * That does leave an auth-off deployment as open as this route was before —
   * honestly so, and not silently: such a deployment has no identities of any
   * kind, so there is nothing to check and the only real fix is turning the
   * flag on. Production (flockto.email) runs with it ON, which is where the
   * live exposure was. What is NOT done here is checking the mirrored session
   * cookie instead: it is JS-writable and client-chosen, so any caller can
   * mint one, and treating it as a credential would buy the appearance of a
   * gate with none of the substance.
   */
  if (!isAuthEnabled()) {
    return { isIdentified: true, ownerId: null };
  }

  try {
    /**
     * `fetchAuthQuery` forwards the caller's signed Convex token — the same
     * route-handler pattern the brand kit, asset library and saved-section
     * routes use — and `api.auth.getCurrentUser` runs behind
     * `ctx.auth.getUserIdentity()`. So the answer is the SERVER's belief about
     * who this is, verified by Convex, not a cookie the browser asserted.
     */
    const identity = await fetchAuthQuery(api.auth.getCurrentUser, {});
    if (identity === null) {
      return { isIdentified: false };
    }
    return { isIdentified: true, ownerId: identity.id };
  } catch (error) {
    /**
     * FAILS CLOSED, unlike the credit meter next door (lib/auth/credits.ts),
     * which lets a request through when its own check breaks. The trade is the
     * opposite one here: a broken counter costs a free turn, but a gate that
     * opens when it cannot see is not a gate at all — an outage would restore
     * exactly the anonymous-send hole this exists to close. A user gets the
     * reload message and a retry; the real reason stays in the logs.
     */
    console.warn("[send-test-email] identity check failed; refusing the send", error);
    return { isIdentified: false };
  }
}

export async function POST(request: Request): Promise<Response> {
  // The identity gate runs BEFORE the body is even read: an unauthenticated
  // caller gets no schema feedback, no integrity verdict, and no work done on
  // their behalf — just the door.
  const caller = await resolveCaller();
  if (!caller.isIdentified) {
    return errorResponse(401, { error: "not_signed_in", message: NOT_SIGNED_IN_MESSAGE });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return errorResponse(400, {
      error: "invalid_request",
      message: "Request body is not valid JSON.",
    });
  }

  const parsedBody = sendTestEmailRequestBodySchema.safeParse(json);
  if (!parsedBody.success) {
    return errorResponse(400, {
      error: "invalid_request",
      message: parsedBody.error.issues.map((issue) => issue.message).join("; "),
    });
  }
  const { document, to, subject, previewText } = parsedBody.data;

  // Schema-valid but structurally broken documents (orphans, cycles, pointer
  // disagreements) are rejected before rendering — mirroring /api/chat.
  const integrity = checkDocumentIntegrity(document);
  if (!integrity.isValid) {
    return errorResponse(400, {
      error: "invalid_document",
      message: "This draft couldn't be sent because its document failed an integrity check.",
    });
  }

  /*
    The meter. Every refusal above this line is free, because none of them could
    have reached an inbox; from here on a send is being ATTEMPTED, so it counts.
  */
  const reservation = await reserveTestSend({ request, to });
  if (!reservation.isAllowed) {
    /*
      Logged so an operator can see the meter biting — a cap that refuses
      silently is indistinguishable from a broken button in a support thread.
      The recipient is already logged for successful sends by the send module,
      so nothing new about the user is recorded here.
    */
    console.log(
      JSON.stringify({
        tag: "flock.sendTestEmail.limitReached",
        ownerId: caller.ownerId,
        retryAtMs: reservation.retryAtMs,
      }),
    );
    return errorResponse(429, {
      error: "send_limit_reached",
      message: reservation.message,
    });
  }

  // Provenance: user-initiated from the studio header (the chat path's
  // ActionContext records author "agent"; this is the human counterpart).
  //
  // `caller` now says "http" — a member of ACTION_CALLERS, which the previous
  // "studio-header" was not. The taxonomy names the SURFACE an invocation
  // arrived through, and what this file sees is an HTTP route, which is the
  // whole lesson of the gate above: the button is upstream of a request, not
  // the same thing as one. The lost detail moves to `surface`, an extra field
  // rather than a wrong value in a typed one.
  //
  // `ownerId` is the identity that just passed the gate, so a send in the logs
  // can be traced to the session that made it. It is null only on an auth-off
  // deployment, where no id exists to record.
  console.log(
    JSON.stringify({
      tag: "flock.sendTestEmail.userInitiated",
      author: "user",
      caller: "http",
      surface: "studio-header",
      ownerId: caller.ownerId,
      to,
    }),
  );

  const outcome = await sendTestEmailWithResend({ doc: document, to, subject, previewText });
  if (!outcome.isSent) {
    // invalid_recipient is the caller's input (400). not_configured is this
    // deployment missing a capability rather than a provider fault, so it is a
    // 503 the client renders as "not set up" instead of a retryable error. The
    // rest are provider or server conditions (502). Copy is already user-facing
    // from the module — the missing env keys are logged there, never returned.
    if (outcome.reason === "invalid_recipient") {
      return errorResponse(400, { error: "invalid_recipient", message: outcome.message });
    }
    if (outcome.reason === "not_configured") {
      return errorResponse(503, {
        error: "not_configured",
        message: `The test email wasn't sent: ${outcome.message}`,
      });
    }
    return errorResponse(502, {
      error: "send_failed",
      message: `The test email wasn't sent: ${outcome.message}`,
    });
  }

  const body: SendTestEmailResponseBody = { messageId: outcome.messageId, to };
  return Response.json(body);
}
