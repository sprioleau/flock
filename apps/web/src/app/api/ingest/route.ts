import { MOCK_MODEL_HEADER } from "@/lib/chat-contract";
import { ingestArticle } from "@/lib/content-ingestion/ingest-article";
import { ingestPerson } from "@/lib/content-ingestion/ingest-person";
import { getSessionIdFromCookieHeader } from "@/lib/session-cookie";
import { ingestRequestBodySchema } from "./contract";

/**
 * POST /api/ingest — read one public web page server-side and return its
 * ACTUAL content (Phase 7.4).
 *
 * Two modes, the plan's two flagship cases:
 *   { kind: "article", url }               → title, byline, date, source,
 *                                            canonical URL, stored lead image,
 *                                            and the article's own text.
 *   { kind: "person", url, personName? }   → name, role, organization, stored
 *                                            portrait, bio, and attributed
 *                                            facts with their sources.
 *
 * Responses:
 *   200 { isOk: true,  kind, article | person }
 *   422 { isOk: false, kind, reason, message }   — the page could not be read
 *   400 { isOk: false, message }                 — the request itself was bad
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
      {
        isOk: false,
        message: 'Tell us what to read: { kind: "article" | "person", url: "https://…" }.',
      },
      { status: 400 },
    );
  }
  const { kind, url, personName } = parsedBody.data;
  const sessionId = getSessionIdFromCookieHeader(request.headers.get("cookie"));
  const isMockRun = request.headers.get(MOCK_MODEL_HEADER) === "1";

  if (kind === "article") {
    const result = await ingestArticle({ url, sessionId });
    return result.isOk
      ? Response.json({ isOk: true, kind, article: result.article })
      : Response.json(
          { isOk: false, kind, reason: result.reason, message: result.message },
          { status: 422 },
        );
  }

  const result = await ingestPerson({
    url,
    sessionId,
    isMockRun,
    ...(personName === undefined ? {} : { personName }),
  });
  return result.isOk
    ? Response.json({ isOk: true, kind, person: result.person })
    : Response.json(
        { isOk: false, kind, reason: result.reason, message: result.message },
        { status: 422 },
      );
}
