import {
  HtmlEmailImportError,
  parseHtmlEmailImport,
  type HtmlEmailImportResult,
} from "@/lib/html-email-import";

interface HtmlImportPreviewPayload {
  html: string;
  baseUrl?: string;
}

/*
  Preview-only HTML import endpoint. It has no document or asset mutation
  side-effects: the parser returns a sanitized source snapshot and an
  editable document candidate for the client to inspect before confirmation.
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

  if (!isHtmlImportPreviewPayload(payload)) {
    return Response.json(
      { error: "invalid_input", message: 'Request body must include an "html" string.' },
      { status: 400 },
    );
  }

  try {
    const result = parseHtmlEmailImport(payload);
    return Response.json(result satisfies HtmlEmailImportResult);
  } catch (error: unknown) {
    if (error instanceof HtmlEmailImportError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.code === "too-large" ? 413 : 400 },
      );
    }
    return Response.json(
      { error: "conversion_failed", message: "The HTML could not be converted for preview." },
      { status: 400 },
    );
  }
}

function isHtmlImportPreviewPayload(value: unknown): value is HtmlImportPreviewPayload {
  if (typeof value !== "object" || value === null || !("html" in value)) {
    return false;
  }
  const candidate = value as { html: unknown; baseUrl?: unknown };
  return (
    typeof candidate.html === "string" &&
    (candidate.baseUrl === undefined || typeof candidate.baseUrl === "string")
  );
}
