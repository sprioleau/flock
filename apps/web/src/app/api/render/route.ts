import {
  checkDocumentIntegrity,
  emailDocumentSchema,
  renderToHTML,
  renderToPlainText,
} from "@flock/email-sdk";
import type { RenderResponseBody } from "./contract";

/*
  POST /api/render — flat email document in, every representation of the
  rendered email out.

  Body: { "document": EmailDocument }.
  200 → { html, prettyHtml, plainText }
  400 → structured errors: invalid_json | missing_document |
        schema_validation_failed (Zod issues) | integrity_check_failed
        (checkDocumentIntegrity errors)

  All three come back together on purpose: the preview dialog shows them as
  three tabs of the same email, so producing them from one document read makes
  tab switching instant and keeps the tabs from ever disagreeing.
*/
export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const hasDocument =
    typeof payload === "object" && payload !== null && "document" in payload;
  if (!hasDocument) {
    return Response.json(
      {
        error: "missing_document",
        message: 'Request body must be an object of the form { "document": EmailDocument }.',
      },
      { status: 400 },
    );
  }

  const parsed = emailDocumentSchema.safeParse((payload as { document: unknown }).document);
  if (!parsed.success) {
    return Response.json(
      { error: "schema_validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const integrity = checkDocumentIntegrity(parsed.data);
  if (!integrity.isValid) {
    return Response.json(
      { error: "integrity_check_failed", errors: integrity.errors },
      { status: 400 },
    );
  }

  const [html, prettyHtml, plainText] = await Promise.all([
    renderToHTML(parsed.data),
    renderToHTML(parsed.data, { isPretty: true }),
    renderToPlainText(parsed.data),
  ]);
  return Response.json({ html, prettyHtml, plainText } satisfies RenderResponseBody);
}
