/*
  /api/render wire contract — imported by both the route and the studio's
  preview dialog (isomorphic: types and constants only).

  One request returns all three representations of the same email, because
  they are three views of ONE render, not three separate questions. Tabbing
  between them is instant and can never show two different versions of the
  draft.
*/

export const RENDER_API_PATH = "/api/render";

export interface RenderResponseBody {
  /*
    Minified email-safe HTML — what actually gets sent, and what the preview
    iframe renders. Kept unformatted: pretty-printing injects whitespace
    between table cells, which email clients render as real gaps.
  */
  html: string;
  /*
    The same HTML, pretty-printed. Purely for reading in the source view.
  */
  prettyHtml: string;
  /*
    The plain-text alternative — what a text-only mail client shows.
  */
  plainText: string;
}

export interface RenderErrorResponseBody {
  error:
    | "invalid_json"
    | "missing_document"
    | "schema_validation_failed"
    | "integrity_check_failed"
    | "render_failed";
  /*
    User-facing copy — safe to show as-is.
  */
  message?: string;
  issues?: unknown;
  errors?: unknown;
}
