import { createEmptyDocument } from "@flock/email-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RENDER_API_PATH } from "@/app/api/render/contract";
import {
  copyTextToClipboard,
  DEFAULT_PREVIEW_VIEW_ID,
  PREVIEW_VIEW_IDS,
  PREVIEW_VIEWS,
  requestEmailRender,
  selectCopyText,
} from "./html-preview-client";

/**
 * The decisions behind the email preview dialog: which views exist, what each
 * server reply means in plain English, and exactly which text each view's Copy
 * button puts on the clipboard. The component that renders these is thin by
 * design (the app's vitest environment is `node`, so there is no DOM to mount
 * into) — everything worth pinning is here.
 */

const DOCUMENT = createEmptyDocument();

const RENDER = {
  html: "<html><body>minified</body></html>",
  prettyHtml: "<html>\n  <body>pretty</body>\n</html>",
  plainText: "pretty as text",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The three views
// ---------------------------------------------------------------------------

describe("the preview's views", () => {
  it("offers exactly three: the rendered email, its HTML, and its plain text", () => {
    expect(PREVIEW_VIEW_IDS).toEqual(["preview", "html", "text"]);
    expect(PREVIEW_VIEWS.map((view) => view.id)).toEqual([...PREVIEW_VIEW_IDS]);
  });

  it("opens on the rendered email — the view that needs no explanation", () => {
    expect(DEFAULT_PREVIEW_VIEW_ID).toBe("preview");
  });

  it("labels every view in plain language", () => {
    expect(PREVIEW_VIEWS.map((view) => view.label)).toEqual(["Preview", "HTML", "Plain text"]);
  });

  it("offers Copy on the two text views and not on the rendered one", () => {
    // The rendered preview is a picture of the email, not text you can paste.
    expect(PREVIEW_VIEWS.find((view) => view.id === "preview")?.copyLabel).toBeNull();
    expect(PREVIEW_VIEWS.find((view) => view.id === "html")?.copyLabel).toBe("Copy HTML");
    expect(PREVIEW_VIEWS.find((view) => view.id === "text")?.copyLabel).toBe("Copy text");
  });
});

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

describe("selectCopyText", () => {
  it("copies the SAME pretty HTML the source view is showing, not the minified send-HTML", () => {
    // Copying a blob the user was never shown would be a different answer to
    // the same button.
    expect(selectCopyText({ view: "html", render: RENDER })).toBe(RENDER.prettyHtml);
    expect(selectCopyText({ view: "html", render: RENDER })).not.toBe(RENDER.html);
  });

  it("copies the plain text from the plain-text view", () => {
    expect(selectCopyText({ view: "text", render: RENDER })).toBe(RENDER.plainText);
  });

  it("has nothing to copy from the rendered preview", () => {
    expect(selectCopyText({ view: "preview", render: RENDER })).toBeNull();
  });

  it("agrees with each view's own copyLabel about whether Copy is offered", () => {
    for (const view of PREVIEW_VIEWS) {
      const hasCopyText = selectCopyText({ view: view.id, render: RENDER }) !== null;
      expect(hasCopyText).toBe(view.copyLabel !== null);
    }
  });
});

describe("copyTextToClipboard", () => {
  it("reports success once the text is on the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyTextToClipboard(RENDER.prettyHtml)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(RENDER.prettyHtml);
  });

  it("reports failure instead of falsely confirming when the browser refuses", async () => {
    // Clipboard access is denied outside a secure context and in some embedded
    // browsers; a green "Copied" there would be a lie.
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    await expect(copyTextToClipboard(RENDER.prettyHtml)).resolves.toBe(false);
  });

  it("reports failure when there is no clipboard API at all", async () => {
    vi.stubGlobal("navigator", {});

    await expect(copyTextToClipboard("anything")).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Requesting the render
// ---------------------------------------------------------------------------

describe("requestEmailRender", () => {
  it("POSTs the document and returns all three views from one request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, RENDER));
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestEmailRender(DOCUMENT);

    expect(result).toEqual({ isOk: true, render: RENDER });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(RENDER_API_PATH);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ document: DOCUMENT });
  });

  it("makes exactly one request — the source view needs no round-trip of its own", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, RENDER));
    vi.stubGlobal("fetch", fetchMock);

    await requestEmailRender(DOCUMENT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("explains a document the renderer rejected without showing raw Zod issues", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(400, { error: "schema_validation_failed", issues: [{ code: "invalid" }] }),
      ),
    );

    const result = await requestEmailRender(DOCUMENT);

    expect(result.isOk).toBe(false);
    expect(result.isOk === false && result.message).toContain("can't be rendered yet");
    expect(result.isOk === false && result.message).not.toContain("invalid");
  });

  it("explains a failed integrity check in the same human terms", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse(400, { error: "integrity_check_failed", errors: [] })),
    );

    const result = await requestEmailRender(DOCUMENT);

    expect(result.isOk === false && result.message).toContain("can't be rendered yet");
  });

  it("says the connection failed when the request never lands", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));

    const result = await requestEmailRender(DOCUMENT);

    expect(result.isOk === false && result.message).toContain("Check your connection");
  });

  it("does not treat unreadable JSON as a successful render", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json", { status: 200 })),
    );

    const result = await requestEmailRender(DOCUMENT);

    expect(result.isOk).toBe(false);
  });

  it("rejects a 200 that is missing a view rather than rendering an empty tab", async () => {
    // A tab showing nothing with no explanation is worse than an error.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { html: "<p>hi</p>" })));

    const result = await requestEmailRender(DOCUMENT);

    expect(result.isOk).toBe(false);
    expect(result.isOk === false && result.message).toContain("incomplete");
  });
});
