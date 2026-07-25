import { render } from "react-email";
import type { EmailDocument } from "../store/document";
import { renderToReactEmail } from "./render-to-react-email";

export interface RenderToHTMLOptions {
  /** Pretty-print the HTML (useful for snapshots/debugging). Default: false. */
  isPretty?: boolean;
}

/**
 * Render a flat email document to email-safe HTML via React Email's `render`
 * (re-exported by the unified `react-email` package from @react-email/render).
 * Throws DocumentIntegrityError when the document fails the integrity check.
 */
export async function renderToHTML(
  document: EmailDocument,
  options: RenderToHTMLOptions = {},
): Promise<string> {
  return render(renderToReactEmail(document), { pretty: options.isPretty ?? false });
}
