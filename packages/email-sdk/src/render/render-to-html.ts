import { render } from "react-email";
import type { EmailDocument } from "../store/document";
import { renderToReactEmail } from "./render-to-react-email";

export interface RenderToHTMLOptions {
  /*
    Pretty-print the HTML (useful for snapshots/debugging). Default: false.
  */
  isPretty?: boolean;
  /**
   * Stamp every block's outermost element with `data-flock-block-id`.
   *
   * ANALYSIS ONLY — see {@link RenderToReactEmailOptions.isBlockAnnotated}.
   * A sent email is always rendered without it.
   */
  isBlockAnnotated?: boolean;
  /**
   * Subject line, also emitted as the document `<title>`.
   * See {@link RenderToReactEmailOptions.subject}.
   */
  subject?: string;
  /**
   * Preheader text rendered through React Email's `<Preview>`.
   * See {@link RenderToReactEmailOptions.previewText}.
   */
  previewText?: string;
}

/*
  Render a flat email document to email-safe HTML via React Email's `render`
  (re-exported by the unified `react-email` package from @react-email/render).
  Throws DocumentIntegrityError when the document fails the integrity check.
*/
export async function renderToHTML(
  document: EmailDocument,
  options: RenderToHTMLOptions = {},
): Promise<string> {
  return render(
    renderToReactEmail(document, {
      isBlockAnnotated: options.isBlockAnnotated ?? false,
      subject: options.subject,
      previewText: options.previewText,
    }),
    { pretty: options.isPretty ?? false },
  );
}
