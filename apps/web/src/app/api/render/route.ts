import {
  checkDocumentIntegrity,
  emailDocumentSchema,
  renderToHTML,
} from "@tandem/email-sdk";

/**
 * POST /api/render — flat email document in, email-safe HTML out.
 *
 * Body: { "document": EmailDocument }.
 * 200 → { html }
 * 400 → structured errors: invalid_json | missing_document |
 *       schema_validation_failed (Zod issues) | integrity_check_failed
 *       (checkDocumentIntegrity errors)
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

  const html = await renderToHTML(parsed.data);
  return Response.json({ html });
}
