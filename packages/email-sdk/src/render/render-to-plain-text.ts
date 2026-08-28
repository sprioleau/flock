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
/*
  Undo react-email's code-token spacing, for the TEXT SIDE ONLY.

  <CodeBlock> rewrites every space inside a Prism token as three characters —
  `token.replaceAll(" ", "\xA0‍​")` in
  react-email/dist/components/code-block/code-block.mjs. That is a deliberate
  and correct email hack, not an accident: the NO-BREAK SPACE stops clients
  collapsing the whitespace that code indentation depends on, and the
  zero-width characters after it hand the now-unbreakable line somewhere legal
  to wrap. It is left completely intact in the HTML, which is where it does its
  work.

  A `text/plain` part has neither of those problems to solve. Nothing collapses
  its whitespace and nothing reflows its line boxes, so all three characters
  buy nothing there — and they cost real correctness, because code copied out
  of a text-only client carries them into a shell or a compiler and fails.
  Measured on the mixed render fixture: ten occurrences in a two-line snippet.

  Matched as react-email's EXACT three-character sequence, which makes this
  provably the inverse of the transform above and leaves every other character
  in the email alone. Deliberately not a general strip of zero-width
  characters or of NO-BREAK SPACE: U+200D is load-bearing on its own — family
  and profession emoji are ZWJ-joined — and a blanket strip would quietly
  corrupt any of those in the email's prose. A test pins that.
*/
const CODE_TOKEN_SPACE = / ‍​/gu;

export async function renderToPlainText(document: EmailDocument): Promise<string> {
  const text = await render(renderToReactEmail(document), { plainText: true });
  return text.replace(CODE_TOKEN_SPACE, " ");
}
