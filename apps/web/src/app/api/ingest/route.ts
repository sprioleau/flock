import { MOCK_MODEL_HEADER } from "@/lib/chat-contract";
import { createPageClassifier } from "@/lib/content-ingestion/classify-page-model";
import { ingestPage } from "@/lib/content-ingestion/ingest-page";
import { getSessionIdFromCookieHeader } from "@/lib/session-cookie";
import { ingestRequestBodySchema } from "./contract";

/**
 * POST /api/ingest — read one public web page server-side and return what is
 * ACTUALLY on it.
 *
 * One mode, where there were two. The old route branched on a `kind` the
 * caller had to supply, which required the caller to know what kind of page it
 * was pointing at before anyone had fetched it.
 *
 *   { url }  → title, source name, canonical URL, the page's description, its
 *              prose in reading order, the lists it wrote, the structured data
 *              its publisher declared, and its stored lead image.
 *
 * Responses:
 *   200 { isOk: true,  page }
 *   422 { isOk: false, reason, message }   — the page could not be read
 *   400 { isOk: false, message }           — the request itself was bad
 *
 * A 422 is the faithfulness rule in HTTP form: robots.txt, a paywall, a block,
 * or a page with no readable content produces a REFUSAL with a user-facing
 * message, never invented content. Callers relay `message` and stop.
 *
 * Read-only: it never touches a document. The anonymous session cookie is used
 * only to file a rehosted image in that session's Asset Library.
 */

const MAX_REQUEST_BYTES = 8 * 1024;

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_REQUEST_BYTES) {
    return Response.json({ isOk: false, message: "That request is too large." }, { status: 413 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json(
      { isOk: false, message: "That request wasn't valid JSON." },
      { status: 400 },
    );
  }
  const parsedBody = ingestRequestBodySchema.safeParse(json);
  if (!parsedBody.success) {
    return Response.json(
      { isOk: false, message: 'Tell us what to read: { url: "https://…" }.' },
      { status: 400 },
    );
  }
  const { url } = parsedBody.data;
  const sessionId = getSessionIdFromCookieHeader(request.headers.get("cookie"));

  const isMockRun = request.headers.get(MOCK_MODEL_HEADER) === "1";
  const result = await ingestPage({
    url,
    sessionId,
    classify: createPageClassifier({ isMockRun }),
  });
  return result.isOk
    ? Response.json({ isOk: true, page: result.page })
    : Response.json(
        { isOk: false, reason: result.reason, message: result.message },
        { status: 422 },
      );
}
