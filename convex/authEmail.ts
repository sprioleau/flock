/*
  The one email auth sends: "here's your sign-in link."

  Delivered through Resend's REST API with plain `fetch` rather than the
  `resend` SDK — this module is bundled into the Convex deployment, and a
  two-field JSON POST is not worth pulling a Node-shaped dependency into that
  bundle. The web app keeps using the SDK for test sends; nothing is shared
  between the two paths except the API key.

  Failure policy: THROW. Better Auth surfaces a failed `sendMagicLink` to the
  caller, and a silent success would leave someone staring at an inbox that
  will never receive anything. A missing API key throws for the same reason —
  it is a misconfiguration, not a runtime condition to paper over.
*/

const RESEND_SEND_ENDPOINT = "https://api.resend.com/emails";

/*
  Displayed in the email; kept here so the copy lives with the template.
*/
const PRODUCT_NAME = "Flock";

export async function sendMagicLinkEmail(args: {
  email: string;
  url: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      "Can't send the sign-in link: RESEND_API_KEY is not set on the Convex deployment.",
    );
  }
  const fromAddress = process.env.RESEND_FROM_EMAIL;
  if (fromAddress === undefined || fromAddress.length === 0) {
    throw new Error(
      "Can't send the sign-in link: RESEND_FROM_EMAIL is not set on the Convex deployment.",
    );
  }

  const response = await fetch(RESEND_SEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [args.email],
      subject: `Your ${PRODUCT_NAME} sign-in link`,
      text: renderMagicLinkText(args.url),
      html: renderMagicLinkHtml(args.url),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Resend rejected the sign-in link email (${response.status}). ${detail}`.trim(),
    );
  }
}

function renderMagicLinkText(url: string): string {
  return [
    `Here's your link back into ${PRODUCT_NAME}.`,
    "",
    url,
    "",
    "It works once and expires in 15 minutes. Opening it keeps everything you've",
    "already made — your drafts, brand kit, images and saved sections — and ties",
    "them to this email address, so they're waiting on any device you sign in from.",
    "",
    "If you didn't ask for this, you can ignore it. Nothing changes until the link",
    "is opened.",
  ].join("\n");
}

/*
  Inline styles only, table-free, no external assets: this has to render in
  every mail client, including the ones that strip <style> blocks.
*/
function renderMagicLinkHtml(url: string): string {
  const safeUrl = escapeHtmlAttribute(url);
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f6f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1a;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:600;">
        Here&rsquo;s your link back into ${PRODUCT_NAME}
      </h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#4a4a45;">
        Opening it keeps everything you&rsquo;ve already made &mdash; your drafts, brand kit,
        images and saved sections &mdash; and ties them to this email address, so
        they&rsquo;re waiting on any device you sign in from.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${safeUrl}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#1c1c1a;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">
          Sign in to ${PRODUCT_NAME}
        </a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#77776f;">
        The link works once and expires in 15 minutes.
      </p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#77776f;">
        If you didn&rsquo;t ask for this, you can ignore it &mdash; nothing changes until
        the link is opened.
      </p>
    </div>
  </body>
</html>`;
}

/*
  Enough for an href: the URL is Better Auth&rsquo;s own, never user text.
*/
function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
