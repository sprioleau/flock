import { render } from "react-email";
import type { EmailDocument } from "../store/document";
import { renderToReactEmail } from "./render-to-react-email";

/**
 * Render a flat email document to the plain-text version of the email — what a
 * text-only mail client shows, and what most providers ship as the
 * `text/plain` alternative part.
 *
 * React Email's `render` does this natively via `{ plainText: true }`: it
 * renders the same React tree to HTML and then converts that HTML to text with
 * `html-to-text`, so the text stays in lockstep with {@link renderToHTML} — one
 * source of truth, two representations.
 *
 * Throws DocumentIntegrityError when the document fails the integrity check.
 */
export async function renderToPlainText(document: EmailDocument): Promise<string> {
  return render(renderToReactEmail(document), { plainText: true });
}
