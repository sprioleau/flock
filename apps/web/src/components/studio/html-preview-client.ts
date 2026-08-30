import type { EmailDocument } from "@flock/email-sdk";
import {
  RENDER_API_PATH,
  type RenderErrorResponseBody,
  type RenderResponseBody,
} from "@/app/api/render/contract";

/*
  The client half of the email preview dialog, as plain functions.

  Deliberately React-free: the app's vitest environment is `node`, so keeping
  the render request, the view definitions and "which text does Copy put on
  the clipboard" out of the component is what makes them testable at all.
*/

/*
  ---------------------------------------------------------------------------
  The three views
  ---------------------------------------------------------------------------
*/

/*
  One render, three ways to look at it. Ordered as the tabs read, from the
  most human view to the most literal one.
*/
export const PREVIEW_VIEW_IDS = ["preview", "html", "text"] as const;

export type PreviewViewId = (typeof PREVIEW_VIEW_IDS)[number];

export const DEFAULT_PREVIEW_VIEW_ID: PreviewViewId = "preview";

export interface PreviewView {
  id: PreviewViewId;
  /*
    Tab label — user-facing.
  */
  label: string;
  /*
    What Copy puts on the clipboard for this view, or null when the view has
    nothing to copy (the rendered preview is a picture of the email, not text).
  */
  copyLabel: string | null;
}

export const PREVIEW_VIEWS: readonly PreviewView[] = [
  { id: "preview", label: "Preview", copyLabel: null },
  { id: "html", label: "HTML", copyLabel: "Copy HTML" },
  { id: "text", label: "Plain text", copyLabel: "Copy text" },
];

/*
  ---------------------------------------------------------------------------
  Requesting the render
  ---------------------------------------------------------------------------
*/

export type RenderRequestResult =
  | { isOk: true; render: RenderResponseBody }
  | { isOk: false; message: string };

/*
  Human copy for every way the render can fail. Raw Zod issues and integrity
  error lists are useful in the console, not in a dialog.
*/
function describeRenderError(body: RenderErrorResponseBody | null): string {
  switch (body?.error) {
    case "schema_validation_failed":
    case "integrity_check_failed":
      return "This email can't be rendered yet — something in it is incomplete. Try undoing your last change.";
    case "invalid_json":
    case "missing_document":
      return "This email couldn't be sent to the renderer. Reopen this window to try again.";
    default:
      return body?.message ?? "The email couldn't be rendered. Reopen this window to try again.";
  }
}

/*
  POSTs the draft and returns all three representations, or human copy.
*/
export async function requestEmailRender(document: EmailDocument): Promise<RenderRequestResult> {
  let response: Response;
  try {
    response = await fetch(RENDER_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document }),
    });
  } catch {
    return { isOk: false, message: "Couldn't reach the renderer. Check your connection." };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    return { isOk: false, message: "The renderer sent back something unreadable." };
  }

  if (!response.ok) {
    return { isOk: false, message: describeRenderError(body as RenderErrorResponseBody) };
  }

  const payload = body as Partial<RenderResponseBody> | null;
  const hasEveryView =
    typeof payload?.html === "string" &&
    typeof payload.prettyHtml === "string" &&
    typeof payload.plainText === "string";
  if (!hasEveryView) {
    return { isOk: false, message: "The renderer sent back an incomplete result." };
  }

  return { isOk: true, render: payload as RenderResponseBody };
}

/*
  ---------------------------------------------------------------------------
  Copying
  ---------------------------------------------------------------------------
*/

/*
  The text behind each view's Copy button. The HTML tab copies the SAME
  pretty-printed source the user is reading — copying a minified blob they
  were never shown would be a different answer to the same button.
*/
export function selectCopyText({
  view,
  render,
}: {
  view: PreviewViewId;
  render: RenderResponseBody;
}): string | null {
  switch (view) {
    case "html":
      return render.prettyHtml;
    case "text":
      return render.plainText;
    default:
      return null;
  }
}

/*
  Writes to the clipboard, reporting whether it landed. Clipboard access is
  refused outside a secure context and in some embedded browsers, so the
  caller can say "couldn't copy" rather than falsely confirm.
*/
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
