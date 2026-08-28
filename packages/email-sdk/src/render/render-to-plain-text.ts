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
  react-email's <CodeBlock> separates every Prism token with a ZERO WIDTH
  JOINER followed by a ZERO WIDTH SPACE. In the HTML that pair is invisible
  and useful — it gives long code lines somewhere to wrap — but html-to-text
  carries it straight through, so code copied out of the text alternative
  arrived with hidden characters between every token and failed on paste.
  Measured on the mixed render fixture: ten pairs in a two-line snippet, and
  the same ten in the HTML render, which is why only the text side is cleaned.

  Removed as the exact PAIR, never as zero-width characters in general. U+200D
  is load-bearing on its own: family and profession emoji are ZWJ-joined
  sequences, and a blanket strip would quietly break any of those in the
  email's prose. U+200D followed by U+200B cannot occur in a valid emoji
  sequence, so the pair identifies react-email's separator unambiguously.
*/
const CODE_TOKEN_SEPARATOR = /‍​/gu;

/*
  The other half of the same defect. Under the pair, react-email spaces tokens
  with U+00A0 NO-BREAK SPACE, and after removing the pair it is the only
  non-ASCII character left on a code line. A no-break space breaks a paste into
  a shell or a compiler exactly like an invisible one does, and a text/plain
  part has nothing to gain from it — text-only clients rewrap at will, so the
  "non-breaking" property buys nothing and costs correctness.
*/
const NO_BREAK_SPACE = / /gu;

export async function renderToPlainText(document: EmailDocument): Promise<string> {
  const text = await render(renderToReactEmail(document), { plainText: true });
  return text.replace(CODE_TOKEN_SEPARATOR, "").replace(NO_BREAK_SPACE, " ");
}
