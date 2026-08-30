import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth/auth-server";
import { DASHBOARD_PATH, LOGIN_PATH } from "@/lib/auth/config";

/*
  GET /api/auth/welcome — where a magic link lands after it verifies.

  It exists to do one thing the plugin cannot: confirm the link actually
  produced a session before committing the visitor to the editor. A magic link
  that was already used, or that expired in transit, otherwise drops someone
  into the studio as a stranger and quietly starts them a fresh anonymous
  library — the exact opposite of what they clicked the link for. Verifying
  here sends a failed link back to the front door instead.

  Lands on the dashboard, which is what a magic link is FOR: the person
  clicking it is proving an identity in order to get back to work they already
  have. It previously landed on bare `/studio`, which mints a brand-new empty
  draft — the one destination that shows them none of it. Starting something
  new is one click from here; finding an old draft was not.

  Lives under /api on purpose — it is a redirect endpoint, not a page. The
  static `welcome` segment takes precedence over the sibling `[...all]`
  catch-all, so it never shadows a Better Auth endpoint.
*/
export async function GET(request: Request): Promise<Response> {
  let isVerified = false;
  try {
    isVerified = await isAuthenticated();
  } catch {
    isVerified = false;
  }

  return NextResponse.redirect(
    new URL(isVerified ? DASHBOARD_PATH : LOGIN_PATH, request.url),
    303,
  );
}
