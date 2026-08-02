import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth/auth-server";
import { LOGIN_PATH, STUDIO_PATH } from "@/lib/auth/config";

/**
 * GET /api/auth/welcome — where a magic link lands after it verifies.
 *
 * It exists to do one thing the plugin cannot: confirm the link actually
 * produced a session before committing the visitor to the editor. A magic link
 * that was already used, or that expired in transit, otherwise drops someone
 * into the studio as a stranger and quietly starts them a fresh anonymous
 * library — the exact opposite of what they clicked the link for. Verifying
 * here sends a failed link back to the front door instead.
 *
 * Lands on bare `/studio`, which mints a new draft (StudioShell creates one
 * when the URL names none). A fresh canvas is the right destination: what they
 * already made is reachable from inside the studio, and picking an arbitrary
 * old draft for them would be a guess.
 *
 * Lives under /api on purpose — it is a redirect endpoint, not a page. The
 * static `welcome` segment takes precedence over the sibling `[...all]`
 * catch-all, so it never shadows a Better Auth endpoint.
 */
export async function GET(request: Request): Promise<Response> {
  let isVerified = false;
  try {
    isVerified = await isAuthenticated();
  } catch {
    isVerified = false;
  }

  return NextResponse.redirect(
    new URL(isVerified ? STUDIO_PATH : LOGIN_PATH, request.url),
    303,
  );
}
